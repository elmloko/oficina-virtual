import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { resolveProject, listAgents, listProjects, isDocsRoot } from './registry.js';
import { createTopicFolder, insideBase, listFiles, removeIfEmpty } from './workspace.js';
import { tmpdir } from 'node:os';
import { route } from './router.js';
import { buildPlanPrompt, parsePlan } from './coordinator.js';
import { chat, secretEnvNames } from './providers.js';
import { noopLogger } from './logger.js';
import * as gitworkDefault from './gitwork.js';
import { promptSection, dirFor } from './attachments.js';
import { parseConsults, stripConsults, protocolPrompt, alreadyConsultedPrompt, consultBrief, answersPrompt } from './collab.js';

const DONE_STATES = new Set(['review', 'done']);
const RESULT_CONTEXT_LIMIT = 6000;
const CONVERSATION_TURNS = 12; // mensajes (agente + usuario) que se reenvían como contexto
const REVIEW_PATCH_LIMIT = 20_000; // diff que se entrega a quien revisa una misión que editó archivos

/**
 * Cola con límite de concurrencia por motor, dependencias entre tareas, presupuesto y timeout.
 * emit(taskId, extra) avisa a la UI. spawnFn, fetchFn y registry son inyectables para pruebas.
 */
export function createRunner(db, emit, { spawnFn = spawn, fetchFn = fetch, registry = { listAgents, listProjects }, providers = {}, logger = noopLogger, gitwork = gitworkDefault, attachmentsDir = config.attachmentsDir, docsRoot = config.docsRoot } = {}) {
  const active = { claude: 0, ollama: 0 };
  let paused = false;
  // Límites editables desde la web (se leen en cada ciclo); los proveedores en internet comparten `max_api`.
  const limits = () => { const s = db.settings(); return { claude: s.max_claude, ollama: s.max_ollama, codex: s.max_codex, api: s.max_api }; };
  const limitOf = (engine) => limits()[engine] ?? limits().api;
  const hasRoom = (engine) => (active[engine] ?? 0) < limitOf(engine);
  // El proceso `claude` no debe heredar claves de otros proveedores (ni activar facturación por API sin querer).
  const childEnv = () => { const env = { ...process.env }; for (const k of secretEnvNames()) delete env[k]; return env; };
  const waiting = []; // { id, engine, model }
  const procs = new Map(); // id -> { kill }
  const timedOut = new Set();
  const extraPrompt = new Map(); // id -> contexto adicional calculado antes de ejecutar (p. ej. el diff a revisar)
  const replySnaps = new Map(); // id -> estado previo a una respuesta en vuelo, para poder deshacerla al cancelar
  const consults = new Map(); // id -> { pending:Set<childId>, answers:[] } mientras la misión espera a sus colegas
  const carry = new Map(); // id -> costo ya gastado en fases anteriores de la misma ejecución (antes de consultar)

  const log = (id, kind, text) => { db.addEvent(id, kind, text); emit(id, { event: { kind, text } }); };
  const patch = (id, p) => { const t = db.updateTask(id, p); emit(id); return t; };

  /** `prepare` corre tras las comprobaciones y antes de encolar: si algo falla antes, no deja rastro. */
  function enqueue(id, prepare) {
    const task = db.getTask(id);
    if (!task) throw new Error('Tarea no existe');
    if (['queued', 'running'].includes(task.status)) throw new Error('La tarea ya está en curso');
    const plan = route(task, db.disabledEngines());
    if (plan.blocked) throw new Error(plan.blocked);
    const { daily_budget_usd: budget } = db.settings();
    if (plan.engine === 'claude' && budget > 0 && db.costToday() >= budget) {
      throw new Error(`Presupuesto diario agotado ($${db.costToday().toFixed(2)} de $${budget})`);
    }
    prepare?.(task);
    patch(id, { status: 'queued', engine: plan.engine, mode: plan.mode, error: null, result: null, finished_at: null });
    if (plan.note) log(id, 'info', plan.note);
    if (!['claude', 'codex'].includes(plan.engine) && task.project) log(id, 'info', 'Este motor no ve archivos del proyecto: solo recibe el texto de la misión.');
    waiting.push({ id, engine: plan.engine, model: plan.model });
    db.audit('task.run', id, `${task.agent} ${plan.engine}/${plan.mode} ${task.project ?? ''}`);
    pump();
  }

  /**
   * El usuario responde a un agente y este continúa la misma misión. Cada ejecución es independiente
   * (sin sesión persistente), así que la conversación viaja en el prompt: la respuesta anterior del agente
   * se guarda como evento 'answer' y el mensaje del usuario como 'user'.
   */
  function reply(id, text) {
    const task = db.getTask(id);
    if (!task) throw new Error('Tarea no existe');
    if (task.kind !== 'task') throw new Error('Solo se puede responder a misiones de un agente');
    if (!['review', 'done', 'failed'].includes(task.status)) throw new Error(task.status === 'backlog' ? 'La misión aún no se ha ejecutado' : 'La misión sigue en curso: espera a que termine');
    enqueue(id, (t) => {
      const eventIds = [];
      if (t.result) eventIds.push(db.addEvent(id, 'answer', t.result).id);
      eventIds.push(db.addEvent(id, 'user', text).id);
      emit(id, { event: { kind: 'user', text } });
      replySnaps.set(id, { eventIds, status: t.status, result: t.result, error: t.error, cost_usd: t.cost_usd, started_at: t.started_at, finished_at: t.finished_at });
      db.updateTask(id, { reply_text: text }); // enqueue lo emite al encolar
      db.audit('task.reply', id, text.slice(0, 200));
    });
  }

  /** null = lista para correr, 'wait' = faltan dependencias, string = motivo de fallo. */
  function depState(task) {
    for (const depId of task.depends_on) {
      const dep = db.getTask(depId);
      if (!dep) return `La dependencia #${depId} ya no existe`;
      if (dep.status === 'failed') return `La dependencia #${depId} falló`;
      if (['queued', 'running'].includes(dep.status)) return 'wait';
      if (!DONE_STATES.has(dep.status)) return `La dependencia #${depId} no se lanzó o fue cancelada`;
    }
    return null;
  }

  function pump() {
    if (paused) return;
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i];
      const task = db.getTask(w.id);
      if (!task || task.status !== 'queued') { waiting.splice(i--, 1); continue; }
      const dep = depState(task);
      if (dep && dep !== 'wait') { // cascada de fallo
        waiting.splice(i--, 1);
        log(w.id, 'error', dep);
        patch(w.id, { status: 'failed', error: dep, finished_at: new Date().toISOString() });
        logger.warn(`#${w.id} falló sin ejecutarse: ${dep}`);
        i = -1; // los dependientes de este también deben fallar
        continue;
      }
      if (dep === 'wait' || !hasRoom(w.engine)) continue;
      waiting.splice(i--, 1);
      active[w.engine] = (active[w.engine] ?? 0) + 1;
      start(w).finally(() => { active[w.engine]--; procs.delete(w.id); timedOut.delete(w.id); consultEnded(w.id); pump(); });
    }
  }

  async function start({ id, engine, model }) {
    const task = db.getTask(id);
    if (!task || task.status !== 'queued') return; // cancelada mientras esperaba
    patch(id, { status: 'running', started_at: new Date().toISOString() });
    logger.info(`#${id} «${task.title.slice(0, 60)}» empezó (${task.agent} · ${engine})`);
    const timer = setTimeout(() => { timedOut.add(id); procs.get(id)?.kill(); }, db.settings().task_timeout_min * 60_000);
    try {
      if (task.review_of) { const ctx = await reviewContext(task); if (ctx) extraPrompt.set(id, ctx); }
      const out = engine === 'claude' ? await runClaude(task) : engine === 'ollama' ? await runOllama(task, model) : engine === 'codex' ? await runCodex(task) : await runProvider(task, engine);
      if (db.getTask(id).status !== 'running') { await afterCancel(id); return; } // cancelada
      if (canConsult(task) && (await beginConsults(task, out))) return; // espera a sus colegas; sigue «en misión» sin ocupar cupo
      out.result = stripConsults(out.result);
      if (task.kind === 'objective') createPlan(task, out.result);
      await finalizeWorktree(id);
      reportWorkdir(id);
      const base = (replySnaps.get(id)?.cost_usd ?? 0) + (carry.get(id) ?? 0); // una respuesta suma al costo de lo ya gastado en la misión
      replySnaps.delete(id); carry.delete(id);
      patch(id, { status: task.consult_of ? 'done' : 'review', result: out.result, cost_usd: base + (out.cost ?? 0), reply_text: null, finished_at: new Date().toISOString() });
      logger.info(`#${id} terminó (${engine}${out.cost ? ` · $${out.cost.toFixed(3)}` : ''})`);
      try { spawnReviews(id); } catch (e) { log(id, 'error', `No se pudo lanzar la revisión automática: ${e.message}`); } // nunca debe fallar la misión original
    } catch (err) {
      if (db.getTask(id).status !== 'running') { await afterCancel(id); return; }
      const msg = timedOut.has(id) ? `Tiempo agotado (${db.settings().task_timeout_min} min)` : err.message;
      log(id, 'error', msg);
      replySnaps.delete(id); carry.delete(id);
      dropEmptyWorkdir(id); // retira la carpeta de Documentos si quedó vacía
      patch(id, { status: 'failed', error: msg, reply_text: null, finished_at: new Date().toISOString() });
      logger.error(`#${id} falló: ${msg.slice(0, 200)}`);
    } finally { clearTimeout(timer); extraPrompt.delete(id); }
  }

  // ---------- colaboración: un agente le pide ayuda a otro ----------
  const messageOut = (m) => { emit(m.task_id, { message: m }); return m; };
  const canConsult = (t) => t.kind === 'task' && !t.consult_of && !t.review_of && !t.schedule_id && db.settings().collab > 0;
  const hasConsulted = (id) => db.events(id).some((e) => e.kind === 'consult');

  /** Si el agente pidió ayuda: crea una misión de solo lectura por colega y deja la misión original en espera. Devuelve true si quedó esperando. */
  async function beginConsults(task, out) {
    if (hasConsulted(task.id)) return false; // una sola ronda
    const { asks, unknown } = parseConsults(out.result, new Set(registry.listAgents().map((a) => a.name)), task.agent);
    if (unknown.length) log(task.id, 'info', `Pidió ayuda a agentes que no existen (se ignoran): ${unknown.join(', ')}`);
    if (!asks.length) return false;
    const id = task.id;
    const before = stripConsults(out.result);
    db.addEvent(id, 'answer', before || '(pidió ayuda a otros agentes antes de seguir)'); // forma parte de la conversación que verá al continuar
    carry.set(id, (carry.get(id) ?? 0) + (out.cost ?? 0));
    const state = { pending: new Set(), answers: [] };
    consults.set(id, state);
    for (const ask of asks) {
      const request = db.addMessage({ task_id: id, from_agent: task.agent, to_agent: ask.agent, kind: 'request', text: ask.question });
      log(id, 'info', `🤝 Pide ayuda a ${ask.agent}: ${ask.question.slice(0, 300)}`);
      let child = null;
      try {
        child = db.createTask({ title: `🤝 ${task.agent} consulta a ${ask.agent}: ${ask.question}`.slice(0, 200), description: consultBrief(task, ask.question), project: task.project, agent: ask.agent, engine: 'auto', mode: 'read', consult_of: id });
        db.audit('consult.create', id, `${task.agent} → ${ask.agent} (#${child.id})`);
        messageOut(db.linkMessage(request.id, child.id)); // la petición queda enlazada a la misión del colega
        emit(child.id);
        state.pending.add(child.id);
        enqueue(child.id);
      } catch (e) {
        if (!child) messageOut(request);
        if (child) state.pending.delete(child.id);
        state.answers.push({ agent: ask.agent, error: e.message });
        messageOut(db.addMessage({ task_id: id, child_id: child?.id ?? null, from_agent: ask.agent, to_agent: task.agent, kind: 'answer', text: `No pudo responder: ${e.message}` }));
      }
    }
    if (state.pending.size) log(id, 'info', `Esperando la respuesta de: ${[...state.pending].map((c) => db.getTask(c)?.agent).filter(Boolean).join(', ')}.`);
    if (!state.pending.size) setImmediate(() => resumeAfterConsults(id));
    return true;
  }

  /** Una misión de consulta terminó (bien, mal o cancelada): anota la respuesta y, si ya no falta nadie, reanuda al agente original. */
  function consultEnded(childId) {
    const child = db.getTask(childId);
    const parentId = child?.consult_of;
    const state = parentId && consults.get(parentId);
    if (!state || !state.pending.delete(childId)) return;
    const parent = db.getTask(parentId);
    const ok = ['done', 'review'].includes(child.status);
    const error = ok ? null : (child.error || 'la consulta se canceló');
    state.answers.push({ agent: child.agent, text: ok ? child.result ?? '' : null, error });
    messageOut(db.addMessage({ task_id: parentId, child_id: childId, from_agent: child.agent, to_agent: parent?.agent ?? '', kind: 'answer', text: ok ? (child.result ?? '(sin texto)') : `No pudo responder: ${error}` }));
    log(parentId, 'info', ok ? `🤝 ${child.agent} respondió.` : `🤝 ${child.agent} no pudo responder: ${error}`);
    if (!state.pending.size) resumeAfterConsults(parentId);
  }

  /** Entrega las respuestas de los colegas al agente original y vuelve a ponerlo en cola. */
  function resumeAfterConsults(id) {
    const state = consults.get(id);
    consults.delete(id);
    const task = db.getTask(id);
    if (!state || !task || task.status !== 'running') return;
    log(id, 'consult', answersPrompt(state.answers));
    const plan = route(task, db.disabledEngines());
    const { daily_budget_usd: budget } = db.settings();
    if (plan.blocked) {
      log(id, 'error', plan.blocked); carry.delete(id); replySnaps.delete(id);
      patch(id, { status: 'failed', error: plan.blocked, finished_at: new Date().toISOString() });
      return;
    }
    if (plan.engine === 'claude' && budget > 0 && db.costToday() >= budget) {
      const msg = `Presupuesto diario agotado ($${db.costToday().toFixed(2)} de $${budget})`;
      log(id, 'error', msg); carry.delete(id); replySnaps.delete(id);
      patch(id, { status: 'failed', error: msg, finished_at: new Date().toISOString() });
      return;
    }
    patch(id, { status: 'queued', engine: plan.engine, mode: plan.mode });
    waiting.push({ id, engine: plan.engine, model: plan.model });
    pump();
  }

  // ---------- revisión cruzada: otros agentes revisan el trabajo al terminar ----------
  const reviewBrief = (agent, task) => [
    `Revisa con criterio el trabajo de la misión #${task.id} («${task.title}»), hecha por el agente ${task.agent}. Evalúa desde tu especialidad (${agent}).`,
    'Responde en español con: 1) Veredicto: APROBAR o CAMBIOS NECESARIOS. 2) Hallazgos ordenados por gravedad (con archivo y línea si aplica). 3) Qué corregirías. No modifiques archivos.',
    ...(agent === 'security' ? ['Presta atención especial al aislamiento entre tenants, a la validación de entradas y a posibles fugas de datos o secretos.'] : []),
  ].join('\n');

  /** Lanza una misión de solo lectura por cada agente de la cadena. Solo la primera vez que la misión termina bien. */
  function spawnReviews(id) {
    const task = db.getTask(id);
    if (!task || task.kind !== 'task' || !task.chain.length || task.chain_fired) return;
    db.updateTask(id, { chain_fired: 1 });
    const launched = [];
    for (const agent of task.chain) {
      const rev = db.createTask({
        title: `Revisar #${id}: ${task.title}`.slice(0, 200), description: reviewBrief(agent, task), project: task.project,
        agent, engine: 'auto', mode: 'read', review_of: id, depends_on: [id],
      });
      emit(rev.id);
      try { enqueue(rev.id); launched.push(`#${rev.id} ${agent}`); } catch (e) { log(id, 'error', `No se pudo lanzar la revisión de ${agent}: ${e.message}`); }
    }
    if (launched.length) log(id, 'info', `Revisión automática en curso: ${launched.join(', ')}.`);
    db.audit('review.chain', id, task.chain.join(','));
  }

  /** Quien revisa una misión que editó archivos recibe su diff (el modo plan no puede ejecutar git). */
  async function reviewContext(task) {
    const orig = db.getTask(task.review_of);
    if (!orig?.worktree || orig.change_state !== 'pending' || !existsSync(orig.worktree)) return '';
    try {
      const c = await exclusive(() => gitwork.changes(orig.worktree, orig.base_sha)); // dos revisores no deben tocar el índice a la vez
      if (!c.files.length) return '';
      const list = c.files.map((f) => `${f.status} ${f.path} (+${f.additions} −${f.deletions})`).join('\n');
      return `--- Cambios de la misión #${orig.id} (rama ${orig.branch}) ---\n${list}\n\n${c.patch.slice(0, REVIEW_PATCH_LIMIT)}${c.patch.length > REVIEW_PATCH_LIMIT ? '\n[diff recortado]' : ''}`;
    } catch { return ''; }
  }

  // ---------- misiones que editan: copia aislada en una rama de git ----------
  async function prepareWorktree(task, repo) {
    if (!(await gitwork.canIsolate(repo))) {
      log(task.id, 'info', 'El proyecto no es un repositorio git con commits: se edita directamente y no se podrá revertir.');
      return null;
    }
    if (task.worktree && existsSync(task.worktree)) return task.worktree;
    const info = await gitwork.createWorktree({ repo, id: task.id, root: config.worktreesDir });
    db.updateTask(task.id, { branch: info.branch, worktree: info.path, base_sha: info.base, change_state: 'pending' });
    log(task.id, 'info', `Trabajando en la rama ${info.branch}, en una copia aislada: tu proyecto no cambia hasta que apliques los cambios.`);
    return info.path;
  }

  /** Al terminar bien: guarda lo editado en un commit; si no se tocó nada, retira la copia. */
  async function finalizeWorktree(id) {
    const t = db.getTask(id);
    if (!t?.worktree || t.change_state !== 'pending') return;
    try {
      await gitwork.commitAll(t.worktree, `Misión #${id}: ${t.title}`);
      const c = await gitwork.changes(t.worktree, t.base_sha);
      if (!c.files.length) {
        await gitwork.discard({ repo: resolveProject(t.project), wt: t.worktree, branch: t.branch });
        db.updateTask(id, { branch: null, worktree: null, base_sha: null, change_state: null });
        log(id, 'info', 'La misión no modificó archivos.');
      } else {
        const add = c.files.reduce((n, f) => n + f.additions, 0); const del = c.files.reduce((n, f) => n + f.deletions, 0);
        log(id, 'info', `Cambios guardados en la rama ${t.branch}: ${c.files.length} archivo(s), +${add} −${del}. Revísalos y aplícalos desde el panel.`);
      }
    } catch (e) { log(id, 'error', `No se pudieron guardar los cambios: ${e.message}`); }
  }

  // ---------- misiones en «Documentos»: una carpeta nueva por tema ----------
  /** Carpeta donde trabaja la misión: nueva (con el nombre del tema) si edita; sin carpeta si solo lee. */
  function docsFolder(task) {
    if (task.mode !== 'edit') {
      log(task.id, 'info', 'Documentos en solo lectura: no se crea carpeta. Marca «puede editar» para que guarde archivos.');
      return tmpdir();
    }
    if (task.workdir && existsSync(task.workdir) && insideBase(task.workdir, docsRoot)) return task.workdir; // una respuesta sigue en la misma carpeta
    const dir = createTopicFolder(docsRoot, task.title);
    db.updateTask(task.id, { workdir: dir });
    log(task.id, 'info', `📂 Carpeta nueva para este tema: ${dir}. Todo lo que guarde el agente va ahí.`);
    return dir;
  }

  /** Al terminar: dice qué archivos quedaron guardados; si no hay ninguno, retira la carpeta vacía. */
  function reportWorkdir(id) {
    const t = db.getTask(id);
    if (!t?.workdir) return;
    if (!existsSync(t.workdir)) { db.updateTask(id, { workdir: null }); return; }
    const { files, total } = listFiles(t.workdir);
    if (!total) {
      if (removeIfEmpty(t.workdir)) { db.updateTask(id, { workdir: null }); log(id, 'info', 'La misión no guardó ningún archivo: se retiró la carpeta vacía.'); }
      return;
    }
    log(id, 'info', `📂 ${total} archivo(s) guardados en ${t.workdir}:\n${files.map((f) => `- ${f}`).join('\n')}${total > files.length ? `\n… y ${total - files.length} más` : ''}`);
  }

  /** Si la misión no llegó a guardar nada (falló o la cancelaron), la carpeta vacía se retira. */
  function dropEmptyWorkdir(id) {
    const t = db.getTask(id);
    if (t?.workdir && existsSync(t.workdir) && !listFiles(t.workdir).total && removeIfEmpty(t.workdir)) db.updateTask(id, { workdir: null });
  }

  /** Una ejecución cancelada puede dejar ediciones a medias: la copia vuelve a su último commit. */
  async function afterCancel(id) {
    const t = db.getTask(id);
    dropEmptyWorkdir(id);
    if (t?.worktree) await gitwork.reset(t.worktree).catch(() => {});
  }

  let gitLock = Promise.resolve(); // una operación git sobre proyectos a la vez
  const exclusive = (fn) => { const run = gitLock.then(fn, fn); gitLock = run.catch(() => {}); return run; };

  function pendingChanges(id) {
    const t = db.getTask(id);
    if (!t) throw new Error('Tarea no existe');
    if (['queued', 'running'].includes(t.status)) throw new Error('La misión sigue en curso: espera a que termine');
    if (!t.worktree || t.change_state !== 'pending') throw new Error('Esta misión no tiene cambios pendientes');
    const repo = resolveProject(t.project);
    if (!repo) throw new Error(`Proyecto no válido: ${t.project}`);
    return { t, repo };
  }

  const changesOf = (id) => exclusive(async () => {
    const t = db.getTask(id);
    if (!t) throw new Error('Tarea no existe');
    if (!t.worktree || t.change_state !== 'pending') return { branch: t.branch, state: t.change_state, files: [], patch: '', truncated: false };
    pendingChanges(id);
    return { branch: t.branch, state: 'pending', base: t.base_sha, ...(await gitwork.changes(t.worktree, t.base_sha)) };
  });

  const applyChanges = (id) => exclusive(async () => {
    const { t, repo } = pendingChanges(id);
    await gitwork.commitAll(t.worktree, `Misión #${id}: ${t.title}`);
    const r = await gitwork.apply({ repo, branch: t.branch, message: `Misión #${id}: ${t.title}` });
    if (!r.ok) { log(id, 'error', r.message); return r; }
    await gitwork.discard({ repo, wt: t.worktree, branch: t.branch });
    patch(id, { change_state: 'applied', worktree: null, branch: null, status: 'done' });
    log(id, 'info', `Cambios aplicados a tu proyecto (rama ${r.branch}).`);
    db.audit('task.apply', id, `${t.project} → ${r.branch}`);
    logger.info(`#${id} cambios aplicados en ${t.project} (${r.branch})`);
    return r;
  });

  const discardChanges = (id) => exclusive(async () => {
    const { t, repo } = pendingChanges(id);
    await gitwork.discard({ repo, wt: t.worktree, branch: t.branch });
    patch(id, { change_state: 'discarded', worktree: null, branch: null });
    log(id, 'info', 'Cambios descartados: tu proyecto quedó como estaba.');
    db.audit('task.discard', id, t.project);
    return { ok: true };
  });

  function createPlan(task, text) {
    const steps = parsePlan(text, new Set(registry.listAgents().map((a) => a.name)), new Set(registry.listProjects().map((p) => p.name)));
    const ids = [];
    for (const s of steps) {
      const child = db.createTask({ ...s, parent_id: task.id, depends_on: s.depends_on.map((i) => ids[i]) });
      ids.push(child.id);
      emit(child.id);
    }
    log(task.id, 'info', `Plan creado: ${ids.length} pasos (#${ids.join(', #')}). Revísalo y lánzalo.`);
    db.audit('plan.created', task.id, `${ids.length} pasos`);
  }

  async function buildPrompt(task) {
    if (task.kind === 'objective') {
      return buildPlanPrompt([task.title, task.description].filter(Boolean).join('\n'), registry.listAgents(), registry.listProjects());
    }
    const parts = [task.title, task.description].filter(Boolean);
    for (const depId of task.depends_on) {
      const dep = db.getTask(depId);
      if (dep?.result) parts.push(`--- Resultado del paso previo #${dep.id} (${dep.title}) ---\n${dep.result.slice(0, RESULT_CONTEXT_LIMIT)}`);
    }
    const turns = db.events(task.id).filter((e) => e.kind === 'answer' || e.kind === 'user' || e.kind === 'consult').slice(-CONVERSATION_TURNS);
    if (turns.length) {
      parts.push('--- Conversación hasta ahora (continúa a partir del último mensaje) ---');
      for (const e of turns) parts.push(e.kind === 'user' ? `Usuario: ${e.text}` : e.kind === 'consult' ? e.text.slice(0, RESULT_CONTEXT_LIMIT * 2) : `Tú (${task.agent}): ${e.text.slice(0, RESULT_CONTEXT_LIMIT)}`);
    }
    if (isDocsRoot(task.project)) {
      const dir = db.getTask(task.id)?.workdir;
      parts.push(dir
        ? `--- Carpeta de trabajo ---\nEstás dentro de una carpeta nueva creada para este tema (${dir}). Guarda ahí todos los archivos que se te pidan (informes, documentos, tablas…) con nombres claros en español y no salgas de esa carpeta.`
        : '--- Modo solo lectura ---\nNo puedes guardar archivos: entrega el contenido completo en tu respuesta.');
    }
    if (canConsult(task)) parts.push(hasConsulted(task.id) ? alreadyConsultedPrompt : protocolPrompt(registry.listAgents().map((a) => a.name), task.agent));
    if (extraPrompt.get(task.id)) parts.push(extraPrompt.get(task.id));
    const files = await promptSection(attachmentsDir, db.attachments(task.id), task.engine);
    if (files) parts.push(files);
    return parts.join('\n\n');
  }

  async function runClaude(task) {
    const repo = task.project ? resolveProject(task.project) : null;
    if (task.project && !repo) throw new Error(`Proyecto no válido: ${task.project}`);
    let cwd = repo ?? process.cwd();
    if (isDocsRoot(task.project)) cwd = docsFolder(task);
    else if (task.mode === 'edit' && repo) cwd = (await prepareWorktree(task, repo)) ?? cwd; // aislada si el proyecto es un repo git
    const orig = task.review_of ? db.getTask(task.review_of) : null;
    if (orig?.worktree && orig.change_state === 'pending' && existsSync(orig.worktree)) cwd = orig.worktree; // el revisor lee el código ya modificado
    if (db.getTask(task.id).status !== 'running') throw new Error('Cancelada'); // cancelada mientras se preparaba la copia
    // "plan" = solo lectura. "acceptEdits" permite editar archivos pero no ejecutar comandos arbitrarios.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', task.mode === 'edit' ? 'acceptEdits' : 'plan'];
    if (task.kind !== 'objective') args.push('--agent', task.agent);
    if (task.kind !== 'objective' && db.attachments(task.id).length) args.push('--add-dir', dirFor(attachmentsDir, task.id)); // para que pueda leer los adjuntos
    const { task_budget_usd: cap } = db.settings();
    if (cap > 0) args.push('--max-budget-usd', String(cap));
    return new Promise((resolve, reject) => {
      const child = spawnFn('claude', args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      procs.set(task.id, { kill: () => child.kill() });
      let buf = '';
      let final = null;
      let stderr = '';
      const onLine = (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'text' && b.text) log(task.id, 'text', b.text);
            else if (b.type === 'tool_use') log(task.id, 'tool', `${b.name} ${JSON.stringify(b.input).slice(0, 300)}`);
          }
        } else if (msg.type === 'result') final = msg;
      };
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => reject(new Error(`No se pudo lanzar claude: ${e.message}`)));
      child.on('close', (code) => {
        if (buf) onLine(buf);
        if (final && !final.is_error) resolve({ result: final.result ?? '', cost: final.total_cost_usd });
        else reject(new Error(final?.result || stderr.trim() || `claude terminó con código ${code}`));
      });
      buildPrompt(task).then((p) => child.stdin.end(p), (e) => { child.kill(); reject(e); });
    });
  }

  /** Codex CLI (`codex exec`) con tu sesión de ChatGPT: siempre en sandbox de solo lectura; editar archivos lo hace Claude Code. */
  async function runCodex(task) {
    const repo = task.project ? resolveProject(task.project) : null;
    if (task.project && !repo) throw new Error(`Proyecto no válido: ${task.project}`);
    let cwd = repo ?? process.cwd();
    if (isDocsRoot(task.project)) cwd = docsFolder(task); // en solo lectura es una carpeta temporal, nunca todo Documentos
    if (db.getTask(task.id).status !== 'running') throw new Error('Cancelada');
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd];
    if (task.model) args.push('-m', task.model);
    args.push('-');
    return new Promise((resolve, reject) => {
      const child = spawnFn(config.codexBin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      procs.set(task.id, { kill: () => child.kill() });
      let buf = '';
      let stderr = '';
      let failure = '';
      const messages = [];
      const onLine = (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        const item = msg.item;
        if (msg.type === 'item.completed' && item?.type === 'agent_message' && item.text) { messages.push(item.text); log(task.id, 'text', item.text); }
        else if (msg.type === 'item.started' && item?.type === 'command_execution') log(task.id, 'tool', `shell ${String(item.command ?? '').slice(0, 300)}`);
        else if (msg.type === 'turn.completed' && msg.usage) log(task.id, 'info', `Codex: ${msg.usage.input_tokens ?? 0} tokens de entrada, ${msg.usage.output_tokens ?? 0} de salida`);
        else if (msg.type === 'turn.failed') failure = msg.error?.message ?? 'Codex falló';
        else if (msg.type === 'error') failure = msg.message ?? failure;
      };
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => reject(new Error(`No se pudo lanzar codex: ${e.message}`)));
      child.on('close', (code) => {
        if (buf) onLine(buf);
        if (!failure && messages.length) resolve({ result: messages[messages.length - 1], cost: 0 });
        else reject(new Error(failure || stderr.trim().slice(-300) || `codex terminó con código ${code}`));
      });
      buildPrompt(task).then((p) => child.stdin.end(p), (e) => { child.kill(); reject(e); });
    });
  }

  async function runOllama(task, model) {
    const ctrl = new AbortController();
    procs.set(task.id, { kill: () => ctrl.abort() });
    const sys = `Eres el agente "${task.agent}". Responde en español, conciso y directo.`;
    const res = await fetchFn(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: sys }, { role: 'user', content: await buildPrompt(task) }] }),
    });
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
    let text = '';
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { text += JSON.parse(line).message?.content ?? ''; } catch { /* línea parcial */ }
      }
    }
    log(task.id, 'text', text);
    return { result: text, cost: 0 };
  }

  async function runProvider(task, engine) {
    const provider = providers[engine];
    if (!provider) throw new Error(`Proveedor "${engine}" no está activo (falta su clave en .env o está desactivado en Sistema)`);
    const ctrl = new AbortController();
    procs.set(task.id, { kill: () => ctrl.abort() });
    const sys = `Eres el agente "${task.agent}". Responde en español, conciso y directo.`;
    const out = await chat(provider, { model: task.model, system: sys, prompt: await buildPrompt(task), signal: ctrl.signal, fetchFn });
    log(task.id, 'text', out.text);
    log(task.id, 'info', `${provider.name}/${out.model}: ${out.usage.input} tokens de entrada, ${out.usage.output} de salida (costo no calculado)`);
    return { result: out.text, cost: 0 };
  }

  function cancel(id) {
    const task = db.getTask(id);
    if (!task) return false;
    const wi = waiting.findIndex((w) => w.id === id);
    if (wi >= 0) waiting.splice(wi, 1);
    const waitingOn = consults.get(id);
    if (waitingOn) { consults.delete(id); carry.delete(id); for (const k of waitingOn.pending) cancel(k); } // cancelar al agente cancela las consultas que esperaba
    if (['queued', 'running'].includes(task.status)) {
      const snap = replySnaps.get(id);
      if (snap) { // cancelar una respuesta la deshace: la misión vuelve a su estado anterior y el mensaje queda para editarlo
        replySnaps.delete(id);
        for (const eid of snap.eventIds) db.deleteEvent(eid);
        patch(id, { status: snap.status, result: snap.result, error: snap.error, started_at: snap.started_at, finished_at: snap.finished_at });
        log(id, 'info', `Respuesta cancelada; puedes editarla y reenviarla: «${(task.reply_text ?? '').slice(0, 300)}»`);
      } else {
        patch(id, { status: 'backlog', finished_at: null }); // antes de matar, para que start() vea que fue cancelada
        log(id, 'info', 'Cancelada por el usuario');
      }
      db.audit('task.cancel', id);
      logger.warn(`#${id} cancelada`);
    }
    procs.get(id)?.kill();
    consultEnded(id); // si era una consulta que aún no había empezado, no hay proceso que avise al terminar
    pump(); // los dependientes de una tarea cancelada deben fallar
    return true;
  }

  function cancelAll() {
    const ids = new Set(waiting.map((w) => w.id));
    for (const t of db.listTasks()) if (t.status === 'running' || t.status === 'queued') ids.add(t.id);
    for (const id of ids) cancel(id);
    logger.warn(`Cancelación total: ${ids.size} tarea(s)`);
    return ids.size;
  }

  function setPaused(value) {
    paused = !!value;
    logger.warn(paused ? 'Cola en pausa: no se iniciarán tareas nuevas' : 'Cola reanudada');
    if (!paused) pump();
    return paused;
  }

  /** Foto del estado de la cola para el panel de sistema. */
  function snapshot() {
    const lim = limits();
    const tasks = db.listTasks();
    const waitReason = (w) => {
      const t = db.getTask(w.id);
      if (!t) return 'ya no existe';
      if (paused) return 'cola en pausa';
      if (depState(t) === 'wait') return 'espera sus dependencias';
      return hasRoom(w.engine) ? 'por iniciar' : `límite de concurrencia (${w.engine} ${active[w.engine] ?? 0}/${limitOf(w.engine)})`;
    };
    return {
      paused,
      off: db.disabledEngines(),
      active: { ...active },
      limit: lim,
      running: tasks.filter((t) => t.status === 'running').map((t) => ({ id: t.id, title: t.title, agent: t.agent, engine: t.engine, started_at: t.started_at })),
      waiting: waiting.map((w) => ({ id: w.id, engine: w.engine, title: db.getTask(w.id)?.title ?? '', reason: waitReason(w) })),
    };
  }

  return { enqueue, reply, cancel, changes: changesOf, applyChanges, discardChanges, cancelAll, setPaused, snapshot, kick: pump, stats: () => ({ active: { ...active }, limit: limits(), waiting: waiting.length, paused, off: db.disabledEngines() }) };
}
