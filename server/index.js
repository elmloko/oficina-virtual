import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createScheduler, validateSpec } from './scheduler.js';
import { TEMPLATES } from './templates.js';
import { route } from './router.js';
import { listAgents, listProjects, resolveProject, isExtraRoot, isServerRef } from './registry.js';
import { exportBundle, readUpload, planImport, applyImport, scanSources, pickScanned, MAX_IMPORT } from './agents-io.js';
import { insideBase } from './workspace.js';
import { CLAUDE_MODELS, ollamaChatModels } from './system.js';
import { OLLAMA_MODELS } from './router.js';
import { pickDefault, benchCandidates, runBenchmark, mergeBench, chatModels, listLmStudio, measureLmStudio } from './ollama-models.js';
import { freemem } from 'node:os';
import { spawn as spawnProc, execFile } from 'node:child_process';
import { loadProviders, publicProviders, knownProviders, testProvider, MODEL_RE } from './providers.js';
import { createLogger } from './logger.js';
import { classify, needsApproval, runSsh, runSsh2, passVar, encodePass, decodePass } from './infra.js';
import { timingSafeEqual } from 'node:crypto';
import { setEnvVar, KEY_RE } from './envfile.js';
import { MODES, splitMode, levelOf, modeAgent, modeLabel } from './modes.js';
import { createVault, SECRET_NAME_RE, PLACEHOLDER_RE, placeholder, validateSecret } from './vault.js';
import { createProbe, collectSystem } from './system.js';
import { join } from 'node:path';
import { telegramFromEnv } from './telegram.js';
import { createDispatcher, askClaude } from './dispatcher.js';
import { checkUpload, saveFile, readStored, removeFile, removeTaskDir, isImage, extOf, MAX_FILE_BYTES, MAX_FILES_PER_TASK, MAX_TOTAL_BYTES } from './attachments.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MANUAL_STATUSES = new Set(['backlog', 'review', 'done']); // el resto lo mueve el runner
// Modos válidos: ver server/modes.js (full = control total de este equipo; los de nivel read valen con cualquier motor)
const SERVER_ENVS = new Set(['prod', 'staging', 'dev']);
/** Valida la lista de servidores (sin secretos: nada de contraseñas ni claves). */
function parseServers(raw) {
  if (!Array.isArray(raw) || raw.length > 100) return { error: 'Lista de servidores inválida' };
  const seen = new Set(); const out = [];
  for (const s of raw) {
    const name = String(s?.name ?? '').trim();
    if (!/^[\w][\w .-]{0,39}$/.test(name)) return { error: `Nombre inválido: «${name.slice(0, 40)}» (letras, números, espacio, punto, guion; máx. 40)` };
    if (seen.has(name.toLowerCase())) return { error: `Nombre repetido: ${name}` };
    seen.add(name.toLowerCase());
    const host = String(s.host ?? '').trim();
    if (!/^[\w][\w.-]{0,99}$/.test(host)) return { error: `Host inválido en «${name}»` };
    const user = String(s.user ?? '').trim();
    if (user && !/^[\w][\w.-]{0,39}$/.test(user)) return { error: `Usuario inválido en «${name}»` };
    const port = s.port === '' || s.port == null ? 22 : Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `Puerto inválido en «${name}»` };
    const env = SERVER_ENVS.has(s.env) ? s.env : 'prod';
    if (out.some((o) => passVar(o.name) === passVar(name))) return { error: `«${name}» se parece demasiado a otro servidor (mismo nombre sin símbolos)` };
    out.push({ name, host, user, port, env, notes: String(s.notes ?? '').slice(0, 500), allow_all: s.allow_all === true });
  }
  return { value: out };
}
const MAX_REVIEWERS = 4;

/** Enciende un servidor local. Sin shell: se lanza el programa con argumentos fijos (el puerto sale de la configuración, nunca de la petición). */
export const defaultServerCtl = {
  lmstudio: (port) => new Promise((resolve, reject) => {
    const run = (retry) => execFile(config.lmsBin, ['server', 'start', '--port', String(port)], { timeout: 30_000, windowsHide: true }, (err) => (err && err.code !== 'ENOENT' && retry ? setTimeout(() => run(false), 2000) : err ? reject(new Error(err.code === 'ENOENT' ? 'No encontré el programa «lms» de LM Studio (define LMS_BIN en .env)' : err.message)) : resolve()));
    run(true);
  }),
  ollama: () => new Promise((resolve, reject) => {
    const child = spawnProc(config.ollamaBin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'No encontré el programa «ollama» (define OLLAMA_BIN en .env)' : e.message)));
    child.once('spawn', () => { child.unref(); resolve(); }); // sigue vivo aunque se cierre la oficina
  }),
  /** Apaga el servidor. Ollama no tiene comando de apagado: se cierran sus procesos (y la bandeja, que si no lo reabre). */
  stop: {
    lmstudio: () => new Promise((resolve, reject) => {
      execFile(config.lmsBin, ['server', 'stop'], { timeout: 30_000, windowsHide: true }, (err) => (err ? reject(new Error(err.code === 'ENOENT' ? 'No encontré el programa «lms» de LM Studio (define LMS_BIN en .env)' : err.message)) : resolve()));
    }),
    ollama: async () => {
      const kill = (name) => new Promise((resolve) => execFile('taskkill', ['/F', '/IM', name], { windowsHide: true }, () => resolve()));
      await kill('ollama app.exe'); await kill('ollama.exe');
    },
  },
};

/** Modelos de LM Studio vía su CLI: tamaño real en disco y sacarlos de la memoria. Sin shell; el id es el que listó LM Studio. */
export const defaultLmsCtl = {
  /** Map id → bytes, o null si `lms` no está o falla (entonces se estima el tamaño por el nombre). */
  sizes: () => new Promise((resolve) => execFile(config.lmsBin, ['ls', '--json'], { timeout: 15_000, windowsHide: true, maxBuffer: 4e6 }, (err, out) => {
    if (err) return resolve(null);
    try { resolve(new Map(JSON.parse(out).filter((m) => m.modelKey && m.sizeBytes > 0).map((m) => [m.modelKey, m.sizeBytes]))); } catch { resolve(null); }
  })),
  /** Sin id descarga todos. Nunca falla: si no estaba cargado no hay nada que hacer. */
  unload: (id) => new Promise((resolve) => {
    if (id && !MODEL_RE.test(id)) return resolve();
    execFile(config.lmsBin, id ? ['unload', id] : ['unload', '--all'], { timeout: 30_000, windowsHide: true }, () => resolve());
  }),
};

export function createApp({ db = openDb(), lmsCtl = defaultLmsCtl, runnerOpts = {}, now, providers = loadProviders(), logger = createLogger(), envFile = config.envFile, probe = createProbe({ config }), attachmentsDir = config.attachmentsDir, dispatcher, docsRoot = config.docsRoot, openFolder = (dir) => spawnProc('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref(), ollamaFetch = fetch, serverCtl = defaultServerCtl, freeMem = freemem, runSshFn = runSsh, runSsh2Fn = runSsh2, approvalWaitMs = 15 * 60_000, agentSources = config.agentSources } = {}) {
  const startedAt = new Date();
  const APPROVAL_WAIT_MS = approvalWaitMs;
  /** Contraseña guardada de un servidor (vive en .env, codificada); null = se usa tu llave SSH. */
  const serverPassword = (name) => decodePass(process.env[passVar(name)]);
  const vault = createVault({ envFile }); // secretos que el agente usa sin verlos
  /** Lo que escribes: NOMBRE_TOKEN=valor (o PASSWORD, SECRET, API_KEY…) pasa a la bóveda y el agente solo recibe el marcador. */
  const secretsDirect = () => db.settings().secrets_direct === 1;
  const guardSecrets = (text, taskId = null) => {
    if (secretsDirect()) return { text, names: [] }; // modo Directo: lo que escribes le llega al agente tal cual
    const { text: clean, saved } = vault.capture(text);
    for (const s of saved) {
      db.scrubSecret(s.value, placeholder(s.name)); // y desaparece de los registros donde ya estuviera
      db.audit('vault.set', taskId, `${s.name} (desde tu mensaje)`);
      if (taskId) runner.log(taskId, 'info', `🔑 Guardé ${s.name} en tus secretos: el agente solo ve ${placeholder(s.name)} y la oficina pone el valor al ejecutar.`);
    }
    if (saved.length) broadcast({ type: 'vault' });
    return { text: clean, names: saved.map((s) => s.name) };
  };
  const pinHostKey = (name, fp) => { db.setServers(db.servers().map((s) => (s.name === name ? { ...s, hostkey: fp } : s))); db.audit('servers.hostkey', null, `${name}: ${fp}`); };
  const sshRun = (o) => {
    const password = serverPassword(o.server.name);
    return password
      ? runSsh2Fn({ server: o.server, command: o.command, stdin: o.stdin ?? null, password, pinned: o.server.hostkey ?? null, onPin: (fp) => pinHostKey(o.server.name, fp) })
      : runSshFn({ ...o, sshBin: config.sshBin });
  };
  /** Lo que ve la web de cada servidor: nunca la contraseña, solo si hay una guardada. */
  const publicServers = () => db.servers().map((s) => ({ ...s, has_password: !!serverPassword(s.name) }));
  const engineSet = () => new Set(['auto', ...['claude', 'ollama', 'codex'].filter((e) => !db.disabledEngines().includes(e)), ...Object.keys(providers)]);
  /** Recarga los proveedores en el mismo objeto (el runner conserva la referencia). */
  // Los proveedores apagados a mano se quitan del conjunto activo (su clave sigue guardada en .env).
  const applyOff = () => { for (const n of db.disabledProviders()) delete providers[n]; };
  const reloadProviders = () => { for (const k of Object.keys(providers)) delete providers[k]; Object.assign(providers, loadProviders()); applyOff(); };
  applyOff();
  // Medición de modelos (Ollama y LM Studio): una a la vez; el resultado queda guardado para comparar y elegir.
  const benches = {};
  const benchOf = (engine) => (benches[engine] ??= { running: false, current: null, total: 0, results: [], skipped: [], free_gb: null, abort: null });
  // lo medido se guarda tras cada modelo y se une a lo anterior: medir de nuevo o reintentar uno no borra el resto
  const benchView = (engine) => {
    const bench = benchOf(engine);
    const last = db.engineBench(engine);
    return bench.running
      ? { engine, running: true, current: bench.current, done: bench.results.length, total: bench.total, results: last?.results ?? [], skipped: last?.skipped ?? bench.skipped, best: last?.best ?? null, changed_from: null, at: last?.at ?? null, free_gb: bench.free_gb }
      : { engine, running: false, current: null, total: last?.results?.length ?? 0, results: last?.results ?? [], skipped: last?.skipped ?? [], best: last?.best ?? null, changed_from: last?.changed_from ?? null, at: last?.at ?? null, free_gb: last?.free_gb ?? null };
  };
  const sockets = new Set();
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of sockets) if (ws.readyState === 1) ws.send(s); };
  const emit = (id, extra = {}) => { const task = db.getTask(id); if (task) broadcast({ type: 'task', task, ...extra }); };
  const runner = createRunner(db, emit, { attachmentsDir, ...runnerOpts, providers, logger });
  dispatcher ??= createDispatcher({ listAgents, agentsDir: config.agentsDir, logger, ask: (p) => askClaude(p, { spawnFn: runnerOpts.spawnFn }) });
  const scheduler = createScheduler({ db, runner, emit, now, logger });
  logger.subscribe((entry) => broadcast({ type: 'log', entry }));
  const publicDir = resolve(config.root, 'public');

  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) => new Promise((ok, fail) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) { fail(new Error('Cuerpo demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { fail(new Error('JSON inválido')); } });
  });

  /** Cuerpo binario con tope de tamaño; corta la conexión en cuanto se pasa. */
  const readRaw = (req, max) => new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { fail(new Error(`El archivo supera ${max / 1024 / 1024} MB`)); req.destroy(); } else chunks.push(d); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
  const dropAttachments = (id) => removeTaskDir(attachmentsDir, id).catch(() => {});

  // Anti DNS-rebinding / CSRF: solo aceptamos Host local y, si hay Origin, que sea local.
  const localHost = (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h ?? '');
  const trusted = (req) => localHost(req.headers.host) && (!req.headers.origin || localHost(req.headers.origin.replace(/^https?:\/\//, '')));

  function validate(body, { partial = false } = {}) {
    const agents = new Set(listAgents().map((a) => a.name));
    const out = {};
    for (const k of ['title', 'description', 'project', 'agent', 'engine', 'mode', 'model']) if (body[k] !== undefined) out[k] = body[k];
    if (out.model === '') out.model = null;
    if (out.model != null && !MODEL_RE.test(out.model)) return { error: 'Modelo inválido' };
    if (!partial || 'title' in out) if (typeof out.title !== 'string' || !out.title.trim()) return { error: 'Falta el título' };
    if (!partial || 'agent' in out) if (!agents.has(out.agent)) return { error: 'Agente desconocido' };
    if ('engine' in out && !engineSet().has(out.engine)) return { error: 'Motor inválido (¿falta la clave del proveedor o está desactivado?)' };
    if ('mode' in out && !MODES.has(out.mode)) return { error: 'Modo inválido' };
    if ('mode' in out) Object.assign(out, splitMode(out.mode)); // receta que actúa → su permiso (edit/infra/full) + la receta
    // Modo infraestructura con Claude Code sin servidor de destino: no podría operar nada y se quedaría en un plan. Mejor avisar al crear.
    if (out.mode === 'infra' && !isServerRef(out.project) && (!partial || 'engine' in out) && ['auto', 'claude'].includes(out.engine ?? 'auto')) {
      return { error: 'Para que el agente opere un servidor elige uno en «Proyecto» (agrégalo antes en Sistema → Ajustes → Servidores). Sin servidor de destino solo puede entregar un plan: en ese caso elige otro motor (Codex, Ollama…).' };
    }
    if (out.mode === 'full') {
      if (isServerRef(out.project)) return { error: 'Control total es para este equipo. Para un servidor elige «Operar un servidor».' };
      if (isExtraRoot(out.project)) return { error: 'Las carpetas extra son de solo lectura: elige otro proyecto o ninguno' };
    }
    if (isServerRef(out.project)) {
      if (!db.servers().some((s) => `srv:${s.name}` === out.project)) return { error: 'Servidor desconocido (agrégalo en Sistema → Ajustes)' };
      if (out.mode === 'edit') return { error: 'Un servidor se trabaja en modo infraestructura: el agente planifica y tú ejecutas' };
    } else if (out.project) {
      if (!resolveProject(out.project)) return { error: 'Proyecto fuera de htdocs o inexistente' };
      if (isExtraRoot(out.project) && out.mode === 'edit') return { error: 'Las carpetas extra son de solo lectura' };
    } else if (out.mode === 'edit') return { error: 'Editar requiere un proyecto' };
    return { value: out };
  }

  /** Agentes que revisarán la misión al terminar: lista de agentes existentes, sin repetir ni incluir al propio autor. */
  function parseChain(raw, author) {
    if (raw == null || raw === '') return { value: [] };
    if (!Array.isArray(raw)) return { error: 'La revisión automática debe ser una lista de agentes' };
    const agents = new Set(listAgents().map((a) => a.name));
    const out = [...new Set(raw)];
    if (out.length > MAX_REVIEWERS) return { error: `Como máximo ${MAX_REVIEWERS} revisores` };
    for (const a of out) {
      if (typeof a !== 'string' || !agents.has(a)) return { error: `Revisor desconocido: ${String(a).slice(0, 40)}` };
      if (a === author) return { error: 'Un agente no puede revisarse a sí mismo' };
    }
    return { value: out };
  }

  /** Ejecutar con permiso de edición exige confirmación explícita (confirm:true). */
  /** Pide confirmación si la misión puede editar archivos o actuar de verdad sobre un servidor (Claude Code + modo infraestructura). */
  const needsConfirm = (task) => {
    const plan = route(task, db.disabledEngines(), runner.down());
    return plan.mode === 'edit' || plan.mode === 'full' || (plan.mode === 'infra' && isServerRef(task.project)); // cualquier motor actúa
  };

  function costs() {
    const s = db.settings();
    return { today: db.costToday(), daily_budget_usd: s.daily_budget_usd, byAgent: db.costByAgent(), byDay: db.costByDay() };
  }

  function scheduleFrom(body) {
    const tpl = body.template ? TEMPLATES.find((t) => t.id === body.template) : null;
    if (body.template && !tpl) return { error: 'Plantilla desconocida' };
    const s = {
      name: body.name ?? tpl?.name,
      spec: body.spec ?? tpl?.spec,
      project: body.project || tpl?.defaultProject || null,
      agent: body.agent ?? tpl?.agent,
      engine: body.engine ?? 'auto',
      title: body.title ?? tpl?.title,
      description: body.description ?? tpl?.description ?? '',
    };
    if (typeof s.name !== 'string' || !s.name.trim()) return { error: 'Falta el nombre' };
    if (typeof s.title !== 'string' || !s.title.trim()) return { error: 'Falta el título' };
    if (!listAgents().some((a) => a.name === s.agent)) return { error: 'Agente desconocido' };
    if (!engineSet().has(s.engine)) return { error: 'Motor inválido' };
    const specErr = validateSpec(s.spec);
    if (specErr) return { error: specErr };
    if (s.project && !resolveProject(s.project)) return { error: 'Proyecto fuera de htdocs o inexistente' };
    if (tpl?.needsProject && !s.project) return { error: 'Esta plantilla requiere un proyecto' };
    return { value: s };
  }

  async function api(req, res, url) {
    const m = (re) => url.pathname.match(re);
    const method = req.method;
    let r;

    if (method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, {
        tasks: db.listTasks(), agents: listAgents(), projects: listProjects(), stats: runner.stats(),
        engines_off: db.disabledEngines(), servers: publicServers(),
        settings: db.settings(), providers: publicProviders(providers), templates: TEMPLATES, schedules: db.schedules(), costs: costs(),
        messages: db.messages(150),
      });
    }
    // ---------- importar / exportar agentes (sin repetir: compara nombre y contenido; nunca reemplaza uno tuyo) ----------
    if (method === 'GET' && url.pathname === '/api/agents/export') {
      const names = (url.searchParams.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bundle = exportBundle(config.agentsDir, names);
      db.audit('agent.export', null, `${bundle.agents.length} agentes`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="agentes-${bundle.exported_at.slice(0, 10)}.json"` });
      return res.end(JSON.stringify(bundle, null, 2));
    }
    if (method === 'GET' && url.pathname === '/api/agents/scan') return send(res, 200, { sources: agentSources.map((s) => s.label), agents: scanSources(agentSources, config.agentsDir) });
    if (method === 'POST' && url.pathname === '/api/agents/import') {
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }
      let items;
      if (Array.isArray(body.ids)) { // desde «Buscar en este equipo»: el servidor relee el disco, el navegador solo elige
        if (body.ids.length > MAX_IMPORT) return send(res, 400, { error: `Como máximo ${MAX_IMPORT} agentes por vez` });
        items = pickScanned(agentSources, body.ids.filter((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)));
        if (!items.length) return send(res, 400, { error: 'Esos agentes ya no están en el equipo; vuelve a buscar' });
      } else {
        const up = readUpload(body);
        if (up.error) return send(res, 400, { error: up.error });
        items = up.items;
      }
      if (body.dry) return send(res, 200, { results: planImport(items, config.agentsDir).map(({ content, ...p }) => p) });
      const results = await applyImport(items, config.agentsDir);
      const done = results.filter((r) => r.status === 'importado').map((r) => r.name);
      if (done.length) {
        db.audit('agent.import', null, done.join(', '));
        logger.info(`Agentes importados (${done.length}): ${done.join(', ')}`);
        broadcast({ type: 'agents-changed' });
      }
      return send(res, 200, { results });
    }
    if (method === 'GET' && url.pathname === '/api/replies/history') return send(res, 200, db.userHistory(Math.min(500, Number(url.searchParams.get('limit')) || 100)));
    if (method === 'GET' && url.pathname === '/api/messages') return send(res, 200, db.messages(Math.min(500, Number(url.searchParams.get('limit')) || 150)));
    if (method === 'GET' && url.pathname === '/api/costs') return send(res, 200, costs());
    if (method === 'GET' && url.pathname === '/api/audit') return send(res, 200, db.auditLog(200));
    if (url.pathname === '/api/settings') {
      if (method === 'GET') return send(res, 200, db.settings());
      if (method === 'PUT') {
        try { const s = db.setSettings(await readJson(req)); db.audit('settings.update', null, JSON.stringify(s)); logger.info('Ajustes actualizados'); runner.kick(); return send(res, 200, s); } catch (e) { return send(res, 400, { error: e.message }); }
      }
    }

    // --- sistema ---
    if (method === 'GET' && url.pathname === '/api/system') {
      return send(res, 200, await collectSystem({ db, runner, probe, config, startedAt, now: now?.() ?? new Date() }));
    }
    if (method === 'GET' && url.pathname === '/api/logs') {
      const level = ['info', 'warn', 'error'].includes(url.searchParams.get('level')) ? url.searchParams.get('level') : null;
      return send(res, 200, logger.list({ after: Number(url.searchParams.get('after')) || 0, level }));
    }
    if (method === 'POST' && /^\/api\/queue\/(pause|resume|cancel-all)$/.test(url.pathname)) {
      const action = url.pathname.split('/').pop();
      if (action === 'cancel-all') { const n = runner.cancelAll(); db.audit('queue.cancel_all', null, `${n} tareas`); return send(res, 200, { cancelled: n }); }
      const paused = runner.setPaused(action === 'pause');
      db.audit(`queue.${action}`);
      broadcast({ type: 'queue', paused });
      return send(res, 200, { paused });
    }
    if (method === 'GET' && url.pathname === '/api/models') {
      if (url.searchParams.has('fresh')) probe.ollama.reset?.(); // «Buscar modelos»: leer lo instalado ahora mismo
      const ol = await probe.ollama().catch(() => ({ ok: false }));
      const ollamaDefault = (ol.ok && pickDefault(ol.models, db.ollamaBench())) || OLLAMA_MODELS.light; // el mejor instalado EN ESTE equipo
      let lm = null; // LM Studio solo responde si su servidor local está encendido
      const lmp = providers.lmstudio;
      if (lmp) {
        try {
          const j = await (await ollamaFetch(`${lmp.baseUrl}/models`, { signal: AbortSignal.timeout(1500) })).json();
          const best = db.engineBench('lmstudio')?.best;
          lm = (j.data ?? []).filter((x) => !/embed/i.test(x.id)).map((x) => ({ value: x.id, label: x.id, recommended: x.id === best }));
        } catch { lm = null; }
      }
      return send(res, 200, {
        claude: CLAUDE_MODELS,
        codex: await (probe.codexModels?.() ?? Promise.resolve([])).catch(() => []),
        ollama: ol.ok ? ollamaChatModels(ol.models, ollamaDefault) : [],
        lmstudio: lm ?? [], lmstudio_up: lm !== null, ollama_up: !!ol.ok,
        engine_models: db.engineModels(), default_seen: db.defaultSeen(),
        defaults: { claude: db.defaultSeen().claude, ollama: ollamaDefault, codex: null, lmstudio: null },
      });
    }
    // --- probar Ollama: una pregunta mínima al modelo que usas (carga el modelo, así que puede tardar) ---
    if (method === 'POST' && m(/^\/api\/system\/ollama\/test$/)) {
      if (db.disabledEngines().includes('ollama')) return send(res, 400, { error: 'Ollama está apagado: enciéndelo primero' });
      if ((runner.stats().active.ollama ?? 0) > 0) return send(res, 409, { error: 'Ollama está ocupado con una misión: espera a que termine para probarlo' });
      const info = await probe.ollama();
      if (!info.ok) return send(res, 200, { ok: false, error: info.error ?? 'Ollama no responde: enciende su servidor' });
      const model = db.engineModels().ollama || pickDefault(info.models ?? [], db.engineBench('ollama'));
      if (!model) return send(res, 200, { ok: false, error: 'No hay ningún modelo de chat instalado (prueba: ollama pull gemma3:4b)' });
      const t0 = Date.now();
      try {
        const r = await ollamaFetch(`${config.ollamaUrl}/api/chat`, {
          method: 'POST', signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({ model, stream: false, keep_alive: 0, options: { num_predict: 12, temperature: 0 }, messages: [{ role: 'user', content: 'Responde solo con la palabra: listo' }] }),
        });
        if (!r.ok) return send(res, 200, { ok: false, model, error: `Ollama respondió ${r.status}` });
        const j = await r.json();
        const text = String(j.message?.content ?? '').trim();
        const ms = Date.now() - t0;
        db.audit('ollama.test', null, `${model} ${ms} ms`);
        return send(res, 200, text ? { ok: true, model, ms, text: text.slice(0, 80) } : { ok: false, model, ms, error: `${model} no devolvió texto (¿es un modelo que «piensa» sin responder?)` });
      } catch (e) {
        return send(res, 200, { ok: false, model, error: e.name === 'TimeoutError' ? `${model} tardó más de 2 min en responder` : e.message });
      }
    }
    // --- apagar el servidor local de Ollama o de LM Studio ---
    if (method === 'POST' && (r = m(/^\/api\/system\/(ollama|lmstudio)\/server\/stop$/))) {
      const engine = r[1];
      const label = engine === 'ollama' ? 'Ollama' : 'LM Studio';
      const lm = providers.lmstudio;
      if (engine === 'lmstudio' && !lm) return send(res, 400, { error: 'LM Studio está apagado en Sistema' });
      const base = engine === 'ollama' ? config.ollamaUrl : lm.baseUrl;
      const up = async () => { try { return (await ollamaFetch(engine === 'ollama' ? `${base}/api/tags` : `${base}/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
      if (!(await up())) return send(res, 200, { ok: true, already: true });
      if ((runner.stats().active[engine] ?? 0) > 0) return send(res, 409, { error: `${label} está ocupado con una misión: espera a que termine o cancélala antes de apagarlo` });
      if (benchOf(engine).running) return send(res, 409, { error: `Hay una medición de ${label} en curso: espera a que termine` });
      try { await (serverCtl.stop ?? defaultServerCtl.stop)[engine](); } catch (e) { return send(res, 400, { error: e.message }); }
      let down = false;
      for (let i = 0; i < 12 && !down; i++) { down = !(await up()); if (!down) await new Promise((r2) => setTimeout(r2, 500)); }
      if (engine === 'ollama') probe.ollama.reset?.(); // que la próxima consulta lo vea apagado ya, no a los 4 s
      db.audit(`${engine}.server.stop`, null, down ? 'ok' : 'sigue respondiendo');
      await refreshDown();
      logger.info(`Servidor de ${label}: ${down ? 'apagado' : 'sigue encendido'}`);
      if (!down) return send(res, 504, { error: `${label} sigue respondiendo tras intentar apagarlo` });
      return send(res, 200, { ok: true, already: false });
    }
    // --- encender el servidor local de Ollama o de LM Studio ---
    if (method === 'POST' && (r = m(/^\/api\/system\/(ollama|lmstudio)\/server$/))) {
      const engine = r[1];
      const label = engine === 'ollama' ? 'Ollama' : 'LM Studio';
      const lm = providers.lmstudio;
      if (engine === 'lmstudio' && !lm) return send(res, 400, { error: 'LM Studio está apagado en Sistema: enciéndelo primero' });
      const base = engine === 'ollama' ? config.ollamaUrl : lm.baseUrl;
      const up = async () => { try { return (await ollamaFetch(engine === 'ollama' ? `${base}/api/tags` : `${base}/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
      if (await up()) return send(res, 200, { ok: true, already: true });
      try { await serverCtl[engine](engine === 'lmstudio' ? new URL(base).port || 1234 : null); } catch (e) { return send(res, 400, { error: e.message }); }
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) { ok = await up(); if (!ok) await new Promise((r2) => setTimeout(r2, 500)); }
      if (engine === 'ollama') probe.ollama.reset?.(); // que la próxima consulta lo vea encendido ya, no a los 4 s
      db.audit(`${engine}.server.start`, null, ok ? 'ok' : 'sin respuesta');
      await refreshDown();
      logger.info(`Servidor de ${label}: ${ok ? 'encendido' : 'no respondió a tiempo'}`);
      if (!ok) return send(res, 504, { error: `${label} no respondió tras encenderlo (revisa que esté instalado)` });
      return send(res, 200, { ok: true, already: false });
    }
    // --- medir los modelos instalados en esta computadora (Ollama o LM Studio) ---
    if ((r = m(/^\/api\/system\/(ollama|lmstudio)\/benchmark$/))) {
      const engine = r[1];
      const label = engine === 'ollama' ? 'Ollama' : 'LM Studio';
      const bench = benchOf(engine);
      if (method === 'GET') return send(res, 200, benchView(engine));
      if (method === 'POST') {
        if (bench.running || bench.starting) return send(res, 409, { error: 'Ya hay una medición en curso' });
        if (runner.stats().active[engine] > 0) return send(res, 409, { error: `${label} está ocupado con una misión: espera a que termine para medir` });
        // se marca ya: preparar tarda (listar, tamaños, descargar) y un doble clic lanzaba dos mediciones que se pisaban los modelos
        bench.starting = true;
        try {
          const body = await readJson(req).catch(() => ({}));
          // «Reintentar»: solo esos modelos, aunque no quepan en la RAM libre (lo pediste tú expresamente)
          const only = Array.isArray(body.models) ? body.models.filter((n) => typeof n === 'string' && MODEL_RE.test(n)) : null;
          const force = body.force === true || !!only?.length; // «medir también los omitidos»
          let models; let baseUrl; let fetchFn; let measureFn;
          let reclaim = 0; // bytes de modelos ya cargados que se descargan antes de medir
          if (engine === 'ollama') {
            const ol = await probe.ollama().catch(() => ({ ok: false }));
            if (!ol.ok) return send(res, 400, { error: ol.error ?? 'Ollama no responde (¿está iniciado?)' });
            models = ol.models; baseUrl = config.ollamaUrl; fetchFn = ollamaFetch;
          } else {
            const lm = providers.lmstudio;
            if (!lm) return send(res, 400, { error: 'LM Studio está apagado en Sistema: enciéndelo primero' });
            try { models = await listLmStudio({ url: lm.baseUrl, fetchFn: ollamaFetch }); } catch { return send(res, 400, { error: 'LM Studio no responde: abre la app y activa su servidor local (pestaña Developer)' }); }
            const sizes = await lmsCtl.sizes(); // tamaño real en disco: el nombre engaña (un «27b» cuantizado puede ocupar menos de 5 GB)
            if (sizes) models = models.map((x) => (sizes.has(x.name) ? { ...x, size: sizes.get(x.name), size_est: false } : x));
            reclaim = models.filter((x) => x.state === 'loaded').reduce((a, x) => a + (x.size ?? 0), 0);
            baseUrl = lm.baseUrl; fetchFn = ollamaFetch;
            // como `keep_alive: 0` en Ollama: al terminar cada uno se descarga para dejar la RAM al siguiente
            measureFn = async (x, opts) => { const out = await measureLmStudio(x, opts); await lmsCtl.unload(x.name); return out; };
          }
          const installed = chatModels(models).map((x) => x.name);
          if (only?.length) {
            models = models.filter((x) => only.includes(x.name));
            if (!models.length) return send(res, 400, { error: `Ese modelo ya no está instalado en ${label}` });
          }
          const freeGb = (freeMem() + reclaim) / 1e9;
          const { candidates, skipped } = benchCandidates(models, freeGb, { force });
          if (!candidates.length) {
            // hay modelos pero ninguno se puede medir ahora: decir por qué en vez de «no hay modelos»
            if (skipped.length) return send(res, 400, { can_force: true, error: `No hay ningún modelo que se pueda medir ahora: ${skipped.map((s) => `${s.name} (${s.reason})`).join(' · ')}. Cierra programas para liberar memoria o descarga un modelo más pequeño.` });
            return send(res, 400, { error: engine === 'ollama' ? 'No hay modelos de chat que medir (descarga uno, p. ej. «ollama pull gemma3:4b»)' : 'LM Studio no tiene modelos de chat descargados' });
          }
          if (engine === 'lmstudio' && reclaim) { await lmsCtl.unload(); logger.info('LM Studio: modelos descargados de la memoria para poder medir'); }
          Object.assign(bench, { running: true, current: null, total: candidates.length, results: [], skipped, free_gb: Math.round(freeGb * 10) / 10, abort: new AbortController() });
          db.audit(`${engine}.benchmark`, null, `${candidates.length} modelos`);
          logger.info(`Midiendo ${candidates.length} modelos de ${label}`);
          const base = db.engineBench(engine); // lo de antes: se conserva lo que esta medición no vuelva a medir
          const save = (results) => {
            const merged = mergeBench(base, { results, skipped, at: new Date().toISOString(), free_gb: bench.free_gb, installed });
            db.setEngineBench(engine, merged);
            return merged;
          };
          if (base?.results?.length) save([]); // ya refleja los desinstalados y los omitidos de ahora
          runBenchmark(candidates, { url: baseUrl, fetchFn, measureFn, signal: bench.abort.signal, onProgress: (results, current) => {
            bench.results = [...results]; bench.current = current;
            if (results.length) save(results); // si el servidor se reinicia a mitad, lo ya medido no se pierde
          } })
            .then((results) => {
              const done = save(results);
              logger.info(`Medición de ${label} terminada. Recomendado: ${done.best ?? 'ninguno'}${done.changed_from ? ` (nuevo: mejor que ${done.changed_from})` : ''}`);
            })
            .catch((e) => logger.warn(`Medición de ${label} falló: ${e.message}`))
            .finally(() => { bench.running = false; bench.current = null; });
          return send(res, 202, benchView(engine));
        } finally { bench.starting = false; }
      }
      if (method === 'DELETE') { bench.abort?.abort(); return send(res, 200, benchView(engine)); }
    }
    if (method === 'PUT' && (r = m(/^\/api\/system\/engines\/(claude|codex|ollama|lmstudio)\/model$/))) {
      const { model } = await readJson(req);
      if (typeof model !== 'string' || (model && !MODEL_RE.test(model))) return send(res, 400, { error: 'Modelo inválido' });
      db.setEngineModel(r[1], model);
      db.audit('engine.model', null, `${r[1]}=${model || 'predeterminado'}`);
      logger.info(`Modelo de ${r[1]}: ${model || 'predeterminado de tu sesión'}`);
      return send(res, 200, { engine: r[1], model });
    }
    if (method === 'PUT' && (r = m(/^\/api\/system\/engines\/(claude|ollama|codex)\/toggle$/))) {
      const { enabled } = await readJson(req);
      if (typeof enabled !== 'boolean') return send(res, 400, { error: 'Falta enabled (true/false)' });
      db.setEngineEnabled(r[1], enabled);
      db.audit(enabled ? 'engine.enabled' : 'engine.disabled', null, r[1]);
      logger.info(`Motor ${r[1]} ${enabled ? 'activado' : 'desactivado'}`);
      broadcast({ type: 'providers' });
      return send(res, 200, { name: r[1], enabled });
    }
    if ((r = m(/^\/api\/system\/providers\/([\w-]+)\/(test|key|toggle)$/))) {
      const def = knownProviders(process.env, db.disabledProviders()).find((p) => p.name === r[1]);
      if (!def) return send(res, 404, { error: 'Proveedor desconocido' });
      if (r[2] === 'toggle' && method === 'PUT') {
        if (!def.configured) return send(res, 400, { error: 'Primero pon la clave del proveedor' });
        const { enabled } = await readJson(req);
        if (typeof enabled !== 'boolean') return send(res, 400, { error: 'Falta enabled (true/false)' });
        db.setProviderEnabled(def.name, enabled);
        reloadProviders();
        db.audit(enabled ? 'provider.enabled' : 'provider.disabled', null, def.name);
        logger.info(`Proveedor ${def.name} ${enabled ? 'activado' : 'desactivado'}`);
        broadcast({ type: 'providers' });
        return send(res, 200, knownProviders(process.env, db.disabledProviders()).find((p) => p.name === def.name));
      }
      if (r[2] === 'test' && method === 'POST') {
        const p = providers[def.name] ?? (db.disabledProviders().includes(def.name) ? loadProviders()[def.name] : undefined); // también se puede probar la clave de uno apagado
        if (!p) return send(res, 400, { error: 'El proveedor no tiene clave configurada' });
        const out = await testProvider(p, { fetchFn: runnerOpts.fetchFn });
        logger[out.ok ? 'info' : 'warn'](`Prueba de ${def.name}: ${out.ok ? `OK (${out.ms} ms)` : out.error}`);
        return send(res, 200, out);
      }
      if (r[2] === 'key') {
        if (!def.needsKey) return send(res, 400, { error: 'Este proveedor no usa clave' });
        if (method === 'PUT') {
          const { key } = await readJson(req);
          if (typeof key !== 'string' || !KEY_RE.test(key)) return send(res, 400, { error: 'Clave inválida (8-300 caracteres imprimibles, sin espacios)' });
          setEnvVar(envFile, def.keyEnv, key);
          process.env[def.keyEnv] = key;
        } else if (method === 'DELETE') {
          setEnvVar(envFile, def.keyEnv, null);
          delete process.env[def.keyEnv];
        } else return send(res, 405, { error: 'Método no permitido' });
        reloadProviders();
        db.audit(method === 'PUT' ? 'provider.key_set' : 'provider.key_removed', null, def.name); // jamás se registra la clave
        logger.info(`Clave de ${def.name} ${method === 'PUT' ? 'guardada' : 'eliminada'}`);
        return send(res, 200, knownProviders(process.env, db.disabledProviders()).find((p) => p.name === def.name));
      }
    }

    // --- tareas ---
    if (method === 'POST' && url.pathname === '/api/tasks') {
      let body = await readJson(req);
      const vaulted = [];
      for (const k of ['title', 'description']) if (typeof body[k] === 'string') { const g = guardSecrets(body[k]); body = { ...body, [k]: g.text }; vaulted.push(...g.names); }
      // Sin agente (o "auto"): lo elige el despachador y, si ninguno encaja, crea uno nuevo.
      const auto = !body.agent || body.agent === 'auto';
      if (auto) {
        const probe = validate({ ...body, agent: listAgents()[0]?.name });
        if (probe.error) return send(res, 400, { error: probe.error });
      }
      let choice = null;
      const suggested = auto ? modeAgent(body.mode, listAgents()) : null; // el modo ya dice quién (p. ej. «Nueva función Laravel» → laravel)
      if (suggested) choice = { agent: suggested, reason: `lo sugiere el modo «${modeLabel(body.mode)}»`, created: null };
      else if (auto) {
        try { choice = await dispatcher.choose({ title: body.title, description: body.description ?? '', project: body.project || null, mode: levelOf(body.mode ?? 'read') }); } catch (e) { return send(res, 409, { error: `No se pudo elegir agente: ${e.message}` }); }
      }
      if (choice) body = { ...body, agent: choice.agent };
      const { error, value } = validate(body);
      if (error) return send(res, 400, { error });
      const chain = parseChain(body.review, value.agent);
      if (chain.error) return send(res, 400, { error: chain.error });
      const task = db.createTask({ ...value, chain: chain.value });
      db.audit('task.create', task.id, `${task.agent} ${task.project ?? ''}`);
      if (choice) {
        if (choice.created) db.audit('agent.create', task.id, `${choice.created.name}: ${choice.created.description}`);
        db.addEvent(task.id, 'info', `Agente elegido automáticamente: ${choice.agent}${choice.created ? ' (agente nuevo creado)' : ''} — ${choice.reason}`);
      }
      emit(task.id);
      if (choice?.created) { // aviso en vivo: la web lo muestra como notificación (en todas las pestañas abiertas)
        logger.info(`Agente nuevo creado: ${choice.created.name} (para la misión #${task.id})`);
        broadcast({ type: 'agent-created', agent: choice.created, task: { id: task.id, title: task.title }, reason: choice.reason });
      }
      for (const n of vaulted) runner.log(task.id, 'info', `🔑 Guardé ${n} en tus secretos: el agente solo ve ${placeholder(n)} y la oficina pone el valor al ejecutar.`);
      const out = vaulted.length ? { ...task, vaulted } : task;
      return send(res, 201, choice ? { ...out, auto: choice } : out);
    }
    // Quién haría la misión (vista previa del formulario): solo palabras clave, sin consultar a Claude.
    if (method === 'POST' && url.pathname === '/api/dispatch/preview') {
      const body = await readJson(req).catch(() => ({}));
      const title = String(body.title ?? '').slice(0, 200); const description = String(body.description ?? '').slice(0, 4000);
      if (!(title + description).trim()) return send(res, 200, { agent: null, sure: false });
      const sug = modeAgent(body.mode, listAgents());
      if (sug) return send(res, 200, { agent: sug, description: listAgents().find((a) => a.name === sug)?.description ?? '', sure: true, byMode: true });
      return send(res, 200, dispatcher.preview?.({ title, description, mode: levelOf(body.mode ?? 'read') }) ?? { agent: null, sure: false });
    }
    // --- infraestructura: el agente pide ejecutar un comando; lo fuerte espera tu aprobación ---
    if (url.pathname === '/api/infra/exec' && method === 'POST') {
      const body = await readJson(req);
      const task = db.getTask(Number(body.task_id));
      const token = runner.infraToken(task?.id);
      const a = Buffer.from(String(body.token ?? '')); const b = Buffer.from(token ?? '');
      if (!task || !token || a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 403, { error: 'No autorizado: solo una misión en modo infraestructura en curso puede usar esta herramienta' });
      if (task.status !== 'running' || task.mode !== 'infra' || !isServerRef(task.project)) return send(res, 403, { error: 'La misión no está en curso en modo infraestructura sobre un servidor' });
      const server = db.servers().find((s) => `srv:${s.name}` === task.project);
      if (!server) return send(res, 404, { error: 'El servidor de destino ya no está registrado' });
      const command = String(body.command ?? '').trim();
      // Salida: 'agent' (la ve el modelo), 'user' (solo tú, en el registro) o 'secret' (se guarda en la bóveda sin que nadie la vea)
      const output = body.output === 'user' || body.output === 'secret' ? body.output : 'agent';
      const secretName = output === 'secret' ? String(body.secret_name ?? '') : null;
      if (output === 'secret') {
        if (!SECRET_NAME_RE.test(secretName)) return send(res, 400, { error: 'Nombre de secreto inválido: MAYÚSCULAS, números y _ (p. ej. DB_PASSWORD)' });
        if (vault.get(secretName) != null) return send(res, 409, { error: `Ya existe el secreto ${secretName}: usa otro nombre (los secretos del usuario no se reemplazan)` });
      }
      const exp = vault.expand(command);
      if (exp.missing.length) return send(res, 400, { error: `No hay ningún secreto guardado como ${exp.missing.join(', ')}. Pídele al usuario que lo guarde (Sistema → Ajustes → Secretos, o escribiendo NOMBRE=valor en su respuesta). Disponibles: ${vault.names().join(', ') || 'ninguno'}` });
      const direct = secretsDirect();
      let { tier, reason, critical } = classify(command.replace(PLACEHOLDER_RE, 'VALOR'), { ignoreSecrets: direct || output !== 'agent' }); // Directo: leer un .env es lectura normal
      if (exp.used.length && tier !== 'strong') { tier = 'strong'; reason = `usa ${exp.used.join(', ')} (la oficina pone el valor al ejecutar; el modelo no lo ve)`; } // usar un secreto siempre se revisa (podría enviarlo fuera)
      else if (exp.used.length) reason = `${reason} · usa ${exp.used.join(', ')}`;
      const wouldAsk = needsApproval(tier, server.env);
      const allowAll = !!task.allow_all || server.allow_all === true; // «Permitir todo» en la misión o en el servidor
      const ask = wouldAsk && !allowAll;
      const show = command.length > 300 ? `${command.slice(0, 300)}…` : command;
      if (ask) {
        const ap = db.createApproval({ task_id: task.id, server: server.name, command, tier, reason, critical });
        runner.log(task.id, 'info', `⏸ Espera tu permiso (#${ap.id}) en ${server.name}: ${show} — ${reason}`);
        db.audit('infra.ask', task.id, `${server.name}: ${show}`);
        broadcast({ type: 'approval', approval: ap });
        const deadline = Date.now() + APPROVAL_WAIT_MS;
        let cur = ap;
        while (cur.status === 'pending' && Date.now() < deadline) {
          await new Promise((r2) => setTimeout(r2, 500));
          cur = db.getApproval(ap.id);
          if (db.getTask(task.id)?.status !== 'running') { cur = db.decideApproval(ap.id, 'denied') ?? db.getApproval(ap.id); break; } // misión cancelada: no se ejecuta nada
        }
        if (cur.status === 'pending') { cur = db.decideApproval(ap.id, 'expired') ?? db.getApproval(ap.id); }
        broadcast({ type: 'approval', approval: cur });
        if (cur.status !== 'approved') {
          runner.log(task.id, 'info', `✕ No se ejecutó (#${ap.id}): ${cur.status === 'denied' ? 'lo rechazaste' : 'nadie lo aprobó a tiempo'}`);
          return send(res, 200, { ok: false, denied: true, note: cur.status === 'expired' ? 'sin respuesta a tiempo' : '' });
        }
      }
      if (wouldAsk && allowAll) runner.log(task.id, 'info', `🔓 Permitido automáticamente (${task.allow_all ? 'permitir todo en la misión' : 'permitir todo en el servidor'}): ${reason}`);
      const where = output === 'user' ? ' (salida solo para ti)' : output === 'secret' ? ` (salida → secreto ${secretName})` : '';
      runner.log(task.id, 'tool', `ssh ${server.name} $ ${show}${where}`);
      db.audit('infra.exec', task.id, `${server.name}: ${show}${where}`);
      // Con secretos, el comando real viaja por stdin a la shell remota: no aparece en la línea de comandos de ningún lado.
      const r = await sshRun(exp.used.length ? { server, command: 'exec "${SHELL:-/bin/sh}" -s', stdin: `${exp.script}\n` } : { server, command });
      const masked = direct ? r : { ...r, stdout: vault.mask(r.stdout), stderr: vault.mask(r.stderr) };
      runner.log(task.id, 'info', `↳ código ${r.code}${r.timedOut ? ' (tiempo agotado)' : ''}${masked.stderr && output === 'agent' ? ` · ${masked.stderr.slice(0, 200)}` : ''}`);
      if (output === 'agent') return send(res, 200, { ok: r.code === 0, ...masked });
      const errNote = r.code !== 0 && masked.stderr ? ` Error: ${masked.stderr.slice(0, 300)}` : '';
      if (output === 'user') {
        const raw = [r.stdout, r.stderr].filter(Boolean).join('\n').trimEnd();
        runner.log(task.id, 'private', raw || '(sin salida)');
        db.audit('infra.private', task.id, `${server.name}: salida mostrada solo al usuario`);
        const lines = raw ? raw.split('\n').length : 0;
        return send(res, 200, { ok: r.code === 0, code: r.code, timedOut: r.timedOut, stdout: '', stderr: '', note: `La salida (${lines} línea${lines === 1 ? '' : 's'}) se mostró solo al usuario en el registro de la misión; tú no la recibes. Si necesitas usar ese valor en otro comando, vuelve a leerlo con --guardar-secreto.${errNote}` });
      }
      const value = (r.stdout ?? '').replace(/\r?\n$/, '');
      const bad = r.code !== 0 ? 'el comando falló' : validateSecret(secretName, value);
      if (bad) return send(res, 200, { ok: false, code: r.code || 1, stdout: '', stderr: '', note: `No se guardó el secreto: ${bad}.${errNote}` });
      vault.set(secretName, value);
      db.scrubSecret(value, placeholder(secretName));
      db.audit('vault.set', task.id, `${secretName} (leído de ${server.name})`); // nunca el valor
      runner.log(task.id, 'info', `🔑 Guardé ${secretName} en tus secretos (${value.length} caracteres). El agente solo ve ${placeholder(secretName)}.`);
      broadcast({ type: 'vault' });
      return send(res, 200, { ok: true, code: 0, stdout: '', stderr: '', note: `Guardado como ${placeholder(secretName)} (${value.length} caracteres). Úsalo así en tus comandos; nunca verás el valor.` });
    }
    // «Permitir todo» en esta misión: deja de preguntar (y aprueba lo que estaba esperando). Se apaga solo cuando termina la misión.
    if ((r = m(/^\/api\/tasks\/(\d+)\/allow-all$/)) && method === 'POST') {
      const task = db.getTask(Number(r[1]));
      if (!task) return send(res, 404, { error: 'No existe' });
      if (task.mode !== 'infra' || !isServerRef(task.project)) return send(res, 400, { error: 'Solo aplica a misiones de infraestructura sobre un servidor' });
      const { enabled } = await readJson(req);
      const on = enabled !== false;
      db.updateTask(task.id, { allow_all: on ? 1 : 0 });
      db.audit(on ? 'infra.allowall.on' : 'infra.allowall.off', task.id, task.project);
      runner.log(task.id, 'info', on ? '🔓 Permitir todo: el agente ya no te pregunta en esta misión' : '🔒 Vuelve a preguntar lo fuerte');
      if (on) for (const ap of db.pendingApprovals().filter((a) => a.task_id === task.id)) broadcast({ type: 'approval', approval: db.decideApproval(ap.id, 'approved') });
      emit(task.id);
      return send(res, 200, db.getTask(task.id));
    }
    if (url.pathname === '/api/approvals' && method === 'GET') return send(res, 200, db.pendingApprovals());
    if ((r = m(/^\/api\/approvals\/(\d+)\/(approve|deny)$/)) && method === 'POST') {
      const ap = db.getApproval(Number(r[1]));
      if (!ap) return send(res, 404, { error: 'No existe' });
      if (ap.status !== 'pending') return send(res, 409, { error: 'Ya estaba decidido' });
      const done = db.decideApproval(ap.id, r[2] === 'approve' ? 'approved' : 'denied');
      db.audit(r[2] === 'approve' ? 'infra.approve' : 'infra.deny', ap.task_id, `${ap.server}: ${ap.command.slice(0, 200)}`);
      broadcast({ type: 'approval', approval: done });
      return send(res, 200, done);
    }
    // --- bóveda de secretos: la web ve los nombres; el valor solo cuando tú pulsas «Ver» ---
    if (url.pathname === '/api/vault' && method === 'GET') return send(res, 200, vault.names().map((name) => ({ name, placeholder: placeholder(name), length: vault.get(name).length })));
    if ((r = m(/^\/api\/vault\/([A-Z][A-Z0-9_]{1,47})(\/value)?$/))) {
      const name = r[1];
      if (r[2] && method === 'GET') {
        const value = vault.get(name);
        if (value == null) return send(res, 404, { error: 'No existe ese secreto' });
        db.audit('vault.view', null, name);
        return send(res, 200, { name, value });
      }
      if (!r[2] && method === 'PUT') {
        const { value } = await readJson(req).catch(() => ({}));
        const err = validateSecret(name, value);
        if (err) return send(res, 400, { error: err });
        vault.set(name, value);
        const cleaned = db.scrubSecret(value, placeholder(name)); // si ya estaba escrito en algún registro, se borra
        db.audit('vault.set', null, name); // nunca el valor
        broadcast({ type: 'vault' });
        return send(res, 200, { name, placeholder: placeholder(name), cleaned });
      }
      if (!r[2] && method === 'DELETE') {
        if (vault.get(name) == null) return send(res, 404, { error: 'No existe ese secreto' });
        vault.remove(name);
        db.audit('vault.remove', null, name);
        broadcast({ type: 'vault' });
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/servers' && method === 'GET') return send(res, 200, publicServers());
    if ((r = m(/^\/api\/servers\/([^/]+)\/password$/)) && method === 'PUT') {
      const name = decodeURIComponent(r[1]);
      if (!db.servers().some((s) => s.name === name)) return send(res, 404, { error: 'Servidor desconocido' });
      const { password } = await readJson(req);
      if (password === '' || password === null) {
        setEnvVar(envFile, passVar(name), null); delete process.env[passVar(name)];
        db.audit('servers.password.remove', null, name);
        return send(res, 200, { has_password: false });
      }
      if (typeof password !== 'string' || password.length > 200 || /[\u0000-\u001f]/.test(password)) return send(res, 400, { error: 'Contraseña inválida (máx. 200 caracteres, sin saltos de línea)' });
      const value = encodePass(password);
      setEnvVar(envFile, passVar(name), value); process.env[passVar(name)] = value;
      db.audit('servers.password.set', null, name); // nunca se registra la contraseña
      return send(res, 200, { has_password: true });
    }
    if (url.pathname === '/api/servers' && method === 'PUT') {
      const { servers } = await readJson(req);
      const { error, value } = parseServers(servers);
      if (error) return send(res, 400, { error });
      const used = new Set(db.listTasks().filter((t) => ['queued', 'running'].includes(t.status) && isServerRef(t.project)).map((t) => t.project));
      const gone = db.servers().find((s) => used.has(`srv:${s.name}`) && !value.some((v) => v.name === s.name));
      if (gone) return send(res, 409, { error: `«${gone.name}» tiene una misión en curso: espera a que termine` });
      const before = db.servers();
      // la huella fijada se conserva mientras no cambie el host o el puerto
      const merged = value.map((v) => { const o = before.find((b) => b.name === v.name); return o?.hostkey && o.host === v.host && o.port === v.port ? { ...v, hostkey: o.hostkey } : v; });
      for (const b of before) if (!merged.some((v) => v.name === b.name)) { setEnvVar(envFile, passVar(b.name), null); delete process.env[passVar(b.name)]; } // quitar el servidor borra su contraseña
      db.setServers(merged);
      db.audit('servers.update', null, `${value.length} servidores`);
      broadcast({ type: 'providers' });
      return send(res, 200, publicServers());
    }
    if (method === 'POST' && url.pathname === '/api/objectives') {
      const body = await readJson(req);
      if (typeof body.title !== 'string' || !body.title.trim()) return send(res, 400, { error: 'Falta el objetivo' });
      const task = db.createTask({ title: body.title.trim().slice(0, 200), description: body.description ?? '', agent: 'coordinador', engine: 'claude', mode: 'read', kind: 'objective' });
      db.audit('objective.create', task.id, task.title);
      emit(task.id);
      return send(res, 201, task);
    }
    if ((r = m(/^\/api\/tasks\/(\d+)$/))) {
      const id = Number(r[1]);
      const task = db.getTask(id);
      if (!task) return send(res, 404, { error: 'No existe' });
      if (method === 'DELETE') {
        runner.cancel(id);
        for (const c of db.children(id)) { runner.cancel(c.id); await runner.discardChanges(c.id).catch(() => {}); db.deleteTask(c.id); await dropAttachments(c.id); broadcast({ type: 'deleted', id: c.id }); }
        await runner.discardChanges(id).catch(() => {}); // sin cambios pendientes no hace nada
        db.deleteTask(id);
        await dropAttachments(id);
        db.audit('task.delete', id, task.title);
        broadcast({ type: 'deleted', id });
        return send(res, 200, { ok: true });
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        const { error, value } = validate({ ...body, project: 'project' in body ? body.project : task.project, mode: body.mode ?? task.mode }, { partial: true });
        if (error) return send(res, 400, { error });
        const patch = {};
        for (const k of ['title', 'description', 'project', 'agent', 'engine', 'mode', 'model']) if (k in body) patch[k] = value[k];
        if ('mode' in body) patch.recipe = value.recipe;
        if (body.status !== undefined) {
          if (!MANUAL_STATUSES.has(body.status) || ['queued', 'running'].includes(task.status)) return send(res, 400, { error: 'Cambio de estado no permitido' });
          patch.status = body.status;
        }
        const updated = db.updateTask(id, patch);
        if (patch.status) db.audit('task.move', id, patch.status);
        emit(id);
        runner.kick();
        return send(res, 200, updated);
      }
    }
    // --- carpeta de la misión en Documentos ---
    if (method === 'POST' && (r = m(/^\/api\/tasks\/(\d+)\/open-folder$/))) {
      const task = db.getTask(Number(r[1]));
      if (!task?.workdir || !existsSync(task.workdir) || !insideBase(task.workdir, docsRoot)) return send(res, 404, { error: 'Esta misión no tiene una carpeta en Documentos' });
      try { openFolder(task.workdir); } catch (e) { return send(res, 500, { error: `No se pudo abrir la carpeta: ${e.message}` }); }
      return send(res, 200, { ok: true, path: task.workdir });
    }
    // --- adjuntos ---
    if ((r = m(/^\/api\/tasks\/(\d+)\/attachments$/))) {
      const id = Number(r[1]);
      const task = db.getTask(id);
      if (!task) return send(res, 404, { error: 'No existe' });
      if (method === 'GET') return send(res, 200, db.attachments(id));
      if (method === 'POST') {
        if (task.kind === 'objective') return send(res, 400, { error: 'Los objetivos no admiten adjuntos' });
        const have = db.attachments(id);
        if (have.length >= MAX_FILES_PER_TASK) return send(res, 409, { error: `Máximo ${MAX_FILES_PER_TASK} adjuntos por misión` });
        if (Number(req.headers['content-length']) > MAX_FILE_BYTES) { res.setHeader('Connection', 'close'); return send(res, 413, { error: `El archivo supera ${MAX_FILE_BYTES / 1024 / 1024} MB` }); }
        let buf;
        try { buf = await readRaw(req, MAX_FILE_BYTES); } catch (e) { return send(res, 413, { error: e.message }); }
        const chk = checkUpload(url.searchParams.get('name'), buf);
        if (chk.error) return send(res, 400, { error: chk.error });
        if (have.reduce((n, a) => n + a.size, 0) + buf.length > MAX_TOTAL_BYTES) return send(res, 409, { error: `Los adjuntos de una misión no pueden pasar de ${MAX_TOTAL_BYTES / 1024 / 1024} MB` });
        const att = db.addAttachment(id, chk.name, chk.mime, buf.length);
        try { await saveFile(attachmentsDir, att, buf); } catch (e) { db.deleteAttachment(att.id); return send(res, 500, { error: 'No se pudo guardar el archivo' }); }
        db.audit('attachment.add', id, `${chk.name} (${buf.length} bytes)`);
        return send(res, 201, att);
      }
    }
    if ((r = m(/^\/api\/attachments\/(\d+)$/))) {
      const att = db.getAttachment(Number(r[1]));
      if (!att) return send(res, 404, { error: 'No existe' });
      if (method === 'DELETE') {
        db.deleteAttachment(att.id);
        await removeFile(attachmentsDir, att).catch(() => {});
        db.audit('attachment.delete', att.task_id, att.name);
        return send(res, 200, { ok: true });
      }
      if (method === 'GET') {
        let data;
        try { data = await readStored(attachmentsDir, att); } catch { return send(res, 404, { error: 'El archivo ya no está en disco' }); }
        const inline = isImage(extOf(att.name)); // el resto se descarga: nunca se interpreta como página
        res.writeHead(200, {
          'Content-Type': inline ? att.mime : 'application/octet-stream',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store', 'Content-Length': data.length,
        });
        return res.end(data);
      }
    }
    if ((r = m(/^\/api\/tasks\/(\d+)\/(run|cancel|events|launch|reply|changes|apply|discard)$/))) {
      const id = Number(r[1]);
      const task = db.getTask(id);
      if (!task) return send(res, 404, { error: 'No existe' });
      if (r[2] === 'events' && method === 'GET') return send(res, 200, db.events(id));
      if (r[2] === 'run' && method === 'POST') {
        const body = await readJson(req);
        if (needsConfirm(task) && body.confirm !== true) return send(res, 409, { error: 'Esta tarea puede editar archivos: requiere confirmación', needsConfirm: true });
        try { runner.enqueue(id); } catch (e) { return send(res, 409, { error: e.message }); }
        return send(res, 202, db.getTask(id));
      }
      if (r[2] === 'changes' && method === 'GET') {
        try { return send(res, 200, await runner.changes(id)); } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if ((r[2] === 'apply' || r[2] === 'discard') && method === 'POST') {
        const body = await readJson(req);
        if (body.confirm !== true) {
          return send(res, 409, { error: r[2] === 'apply' ? 'Aplicar modifica tu proyecto real: requiere confirmación' : 'Descartar elimina los cambios de la misión: requiere confirmación', needsConfirm: true });
        }
        try {
          const out = r[2] === 'apply' ? await runner.applyChanges(id) : await runner.discardChanges(id);
          if (out.ok === false) return send(res, 409, { error: out.message, reason: out.reason });
          return send(res, 200, db.getTask(id));
        } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (r[2] === 'reply' && method === 'POST') {
        const body = await readJson(req);
        let text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return send(res, 400, { error: 'Escribe una respuesta' });
        if (text.length > 4000) return send(res, 400, { error: 'La respuesta es demasiado larga (máx. 4000 caracteres)' });
        if (needsConfirm(task) && body.confirm !== true) return send(res, 409, { error: 'Esta misión puede editar archivos: requiere confirmación', needsConfirm: true });
        const vaulted = guardSecrets(text, id);
        text = vaulted.text;
        try { runner.reply(id, text); } catch (e) { return send(res, 409, { error: e.message }); }
        return send(res, 202, { ...db.getTask(id), vaulted: vaulted.names });
      }
      if (r[2] === 'cancel' && method === 'POST') { runner.cancel(id); return send(res, 200, db.getTask(id)); }
      if (r[2] === 'launch' && method === 'POST') {
        if (task.kind !== 'objective') return send(res, 400, { error: 'Solo los objetivos tienen plan' });
        const body = await readJson(req);
        const steps = db.children(id).filter((c) => ['backlog', 'failed'].includes(c.status));
        if (!steps.length) return send(res, 409, { error: 'No hay pasos pendientes' });
        if (steps.some(needsConfirm) && body.confirm !== true) return send(res, 409, { error: 'El plan incluye pasos que editan archivos: requiere confirmación', needsConfirm: true });
        const errors = [];
        for (const s of steps) { try { runner.enqueue(s.id); } catch (e) { errors.push(`#${s.id}: ${e.message}`); } }
        db.audit('plan.launch', id, `${steps.length} pasos`);
        return send(res, errors.length ? 207 : 202, { launched: steps.length - errors.length, errors });
      }
    }

    // --- rutinas ---
    if (method === 'GET' && url.pathname === '/api/schedules') return send(res, 200, db.schedules());
    if (method === 'POST' && url.pathname === '/api/schedules') {
      const { error, value } = scheduleFrom(await readJson(req));
      if (error) return send(res, 400, { error });
      const s = db.createSchedule({ ...value, last_run: (now?.() ?? new Date()).toISOString() });
      db.audit('schedule.create', null, s.name);
      return send(res, 201, s);
    }
    if ((r = m(/^\/api\/schedules\/(\d+)(\/run)?$/))) {
      const id = Number(r[1]);
      const s = db.getSchedule(id);
      if (!s) return send(res, 404, { error: 'No existe' });
      if (r[2] && method === 'POST') return send(res, 202, scheduler.runSchedule(s));
      if (method === 'DELETE') { db.deleteSchedule(id); db.audit('schedule.delete', null, s.name); return send(res, 200, { ok: true }); }
      if (method === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        if ('enabled' in body) patch.enabled = !!body.enabled;
        if ('name' in body) patch.name = String(body.name);
        if ('spec' in body) { const err = validateSpec(body.spec); if (err) return send(res, 400, { error: err }); patch.spec = body.spec; }
        return send(res, 200, db.updateSchedule(id, patch));
      }
    }
    return send(res, 404, { error: 'Ruta no encontrada' });
  }

  async function serveStatic(res, pathname) {
    const file = resolve(publicDir, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(publicDir + sep)) { res.writeHead(403); return res.end(); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch { res.writeHead(404); res.end('No encontrado'); }
  }

  const server = createServer(async (req, res) => {
    if (!trusted(req)) { res.writeHead(403); return res.end('Prohibido'); }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, url.pathname);
    } catch (e) { send(res, 400, { error: e.message }); }
  });

  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => trusted(req) });
  wss.on('connection', (ws) => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); });

  /** Comprueba qué motores locales tienen el servidor apagado y se lo pasa al runner (Auto los esquiva). */
  async function refreshDown() {
    const ol = await probe.ollama().catch(() => ({ ok: false }));
    runner.setDown(db.disabledEngines().includes('ollama') || ol.ok ? [] : ['ollama']);
    return runner.down();
  }

  return { server, db, runner, scheduler, logger, refreshDown };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const { server, scheduler, logger, refreshDown } = createApp({ logger: createLogger({ echo: true }) });
  server.listen(config.port, config.host, () => {
    scheduler.start();
    refreshDown(); setInterval(refreshDown, 15_000).unref(); // monitor de servidores locales (solo en producción, no en tests)
    // Bot de Telegram opcional: habla con esta misma API por localhost, así reutiliza todas sus validaciones.
    const local = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${config.port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    telegramFromEnv({ api: local, logger })?.start();
    logger.info(`Servidor iniciado en http://${config.host}:${config.port}`);
    console.log(`Oficina virtual en http://${config.host}:${config.port}`);
  });
}
