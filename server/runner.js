import { spawn } from 'node:child_process';
import { config } from './config.js';
import { resolveProject, listAgents, listProjects } from './registry.js';
import { route } from './router.js';
import { buildPlanPrompt, parsePlan } from './coordinator.js';
import { chat, secretEnvNames } from './providers.js';

const DONE_STATES = new Set(['review', 'done']);
const RESULT_CONTEXT_LIMIT = 6000;

/**
 * Cola con límite de concurrencia por motor, dependencias entre tareas, presupuesto y timeout.
 * emit(taskId, extra) avisa a la UI. spawnFn, fetchFn y registry son inyectables para pruebas.
 */
export function createRunner(db, emit, { spawnFn = spawn, fetchFn = fetch, registry = { listAgents, listProjects }, providers = {} } = {}) {
  const limits = { claude: config.maxClaude, ollama: config.maxOllama };
  const active = { claude: 0, ollama: 0 };
  const limitOf = (engine) => limits[engine] ?? config.maxApi; // los proveedores en internet comparten un límite
  const hasRoom = (engine) => (active[engine] ?? 0) < limitOf(engine);
  // El proceso `claude` no debe heredar claves de otros proveedores (ni activar facturación por API sin querer).
  const childEnv = () => { const env = { ...process.env }; for (const k of secretEnvNames()) delete env[k]; return env; };
  const waiting = []; // { id, engine, model }
  const procs = new Map(); // id -> { kill }
  const timedOut = new Set();

  const log = (id, kind, text) => { db.addEvent(id, kind, text); emit(id, { event: { kind, text } }); };
  const patch = (id, p) => { const t = db.updateTask(id, p); emit(id); return t; };

  function enqueue(id) {
    const task = db.getTask(id);
    if (!task) throw new Error('Tarea no existe');
    if (['queued', 'running'].includes(task.status)) throw new Error('La tarea ya está en curso');
    const plan = route(task);
    const { daily_budget_usd: budget } = db.settings();
    if (plan.engine === 'claude' && budget > 0 && db.costToday() >= budget) {
      throw new Error(`Presupuesto diario agotado ($${db.costToday().toFixed(2)} de $${budget})`);
    }
    patch(id, { status: 'queued', engine: plan.engine, mode: plan.mode, error: null, result: null, finished_at: null });
    if (plan.note) log(id, 'info', plan.note);
    if (plan.engine !== 'claude' && task.project) log(id, 'info', 'Este motor no ve archivos del proyecto: solo recibe el texto de la misión.');
    waiting.push({ id, engine: plan.engine, model: plan.model });
    db.audit('task.run', id, `${task.agent} ${plan.engine}/${plan.mode} ${task.project ?? ''}`);
    pump();
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
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i];
      const task = db.getTask(w.id);
      if (!task || task.status !== 'queued') { waiting.splice(i--, 1); continue; }
      const dep = depState(task);
      if (dep && dep !== 'wait') { // cascada de fallo
        waiting.splice(i--, 1);
        log(w.id, 'error', dep);
        patch(w.id, { status: 'failed', error: dep, finished_at: new Date().toISOString() });
        i = -1; // los dependientes de este también deben fallar
        continue;
      }
      if (dep === 'wait' || !hasRoom(w.engine)) continue;
      waiting.splice(i--, 1);
      active[w.engine] = (active[w.engine] ?? 0) + 1;
      start(w).finally(() => { active[w.engine]--; procs.delete(w.id); timedOut.delete(w.id); pump(); });
    }
  }

  async function start({ id, engine, model }) {
    const task = db.getTask(id);
    if (!task || task.status !== 'queued') return; // cancelada mientras esperaba
    patch(id, { status: 'running', started_at: new Date().toISOString() });
    const timer = setTimeout(() => { timedOut.add(id); procs.get(id)?.kill(); }, db.settings().task_timeout_min * 60_000);
    try {
      const out = engine === 'claude' ? await runClaude(task) : engine === 'ollama' ? await runOllama(task, model) : await runProvider(task, engine);
      if (db.getTask(id).status !== 'running') return; // cancelada
      if (task.kind === 'objective') createPlan(task, out.result);
      patch(id, { status: 'review', result: out.result, cost_usd: out.cost ?? 0, finished_at: new Date().toISOString() });
    } catch (err) {
      if (db.getTask(id).status !== 'running') return;
      const msg = timedOut.has(id) ? `Tiempo agotado (${db.settings().task_timeout_min} min)` : err.message;
      log(id, 'error', msg);
      patch(id, { status: 'failed', error: msg, finished_at: new Date().toISOString() });
    } finally { clearTimeout(timer); }
  }

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

  function buildPrompt(task) {
    if (task.kind === 'objective') {
      return buildPlanPrompt([task.title, task.description].filter(Boolean).join('\n'), registry.listAgents(), registry.listProjects());
    }
    const parts = [task.title, task.description].filter(Boolean);
    for (const depId of task.depends_on) {
      const dep = db.getTask(depId);
      if (dep?.result) parts.push(`--- Resultado del paso previo #${dep.id} (${dep.title}) ---\n${dep.result.slice(0, RESULT_CONTEXT_LIMIT)}`);
    }
    return parts.join('\n\n');
  }

  function runClaude(task) {
    const cwd = task.project ? resolveProject(task.project) : process.cwd();
    if (!cwd) return Promise.reject(new Error(`Proyecto no válido: ${task.project}`));
    // "plan" = solo lectura. "acceptEdits" permite editar archivos pero no ejecutar comandos arbitrarios.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', task.mode === 'edit' ? 'acceptEdits' : 'plan'];
    if (task.kind !== 'objective') args.push('--agent', task.agent);
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
      child.stdin.end(buildPrompt(task));
    });
  }

  async function runOllama(task, model) {
    const ctrl = new AbortController();
    procs.set(task.id, { kill: () => ctrl.abort() });
    const sys = `Eres el agente "${task.agent}". Responde en español, conciso y directo.`;
    const res = await fetchFn(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: sys }, { role: 'user', content: buildPrompt(task) }] }),
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
    if (!provider) throw new Error(`Proveedor "${engine}" no configurado (falta su clave en .env)`);
    const ctrl = new AbortController();
    procs.set(task.id, { kill: () => ctrl.abort() });
    const sys = `Eres el agente "${task.agent}". Responde en español, conciso y directo.`;
    const out = await chat(provider, { model: task.model, system: sys, prompt: buildPrompt(task), signal: ctrl.signal, fetchFn });
    log(task.id, 'text', out.text);
    log(task.id, 'info', `${provider.name}/${out.model}: ${out.usage.input} tokens de entrada, ${out.usage.output} de salida (costo no calculado)`);
    return { result: out.text, cost: 0 };
  }

  function cancel(id) {
    const task = db.getTask(id);
    if (!task) return false;
    const wi = waiting.findIndex((w) => w.id === id);
    if (wi >= 0) waiting.splice(wi, 1);
    if (['queued', 'running'].includes(task.status)) {
      patch(id, { status: 'backlog', finished_at: null }); // antes de matar, para que start() vea que fue cancelada
      log(id, 'info', 'Cancelada por el usuario');
      db.audit('task.cancel', id);
    }
    procs.get(id)?.kill();
    pump(); // los dependientes de una tarea cancelada deben fallar
    return true;
  }

  return { enqueue, cancel, kick: pump, stats: () => ({ active: { ...active }, limit: { ...limits }, waiting: waiting.length }) };
}
