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
import { listAgents, listProjects, resolveProject, isExtraRoot } from './registry.js';
import { insideBase } from './workspace.js';
import { CLAUDE_MODELS, ollamaChatModels } from './system.js';
import { OLLAMA_MODELS } from './router.js';
import { pickDefault, benchCandidates, runBenchmark, recommend, listLmStudio, measureLmStudio } from './ollama-models.js';
import { freemem } from 'node:os';
import { spawn as spawnProc, execFile } from 'node:child_process';
import { loadProviders, publicProviders, knownProviders, testProvider, MODEL_RE } from './providers.js';
import { createLogger } from './logger.js';
import { setEnvVar, KEY_RE } from './envfile.js';
import { createProbe, collectSystem } from './system.js';
import { join } from 'node:path';
import { telegramFromEnv } from './telegram.js';
import { createDispatcher, askClaude } from './dispatcher.js';
import { checkUpload, saveFile, readStored, removeFile, removeTaskDir, isImage, extOf, MAX_FILE_BYTES, MAX_FILES_PER_TASK, MAX_TOTAL_BYTES } from './attachments.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MANUAL_STATUSES = new Set(['backlog', 'review', 'done']); // el resto lo mueve el runner
const MODES = new Set(['read', 'edit']);
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

export function createApp({ db = openDb(), runnerOpts = {}, now, providers = loadProviders(), logger = createLogger(), envFile = config.envFile, probe = createProbe({ config }), attachmentsDir = config.attachmentsDir, dispatcher, docsRoot = config.docsRoot, openFolder = (dir) => spawnProc('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref(), ollamaFetch = fetch, serverCtl = defaultServerCtl, freeMem = freemem } = {}) {
  const startedAt = new Date();
  const engineSet = () => new Set(['auto', ...['claude', 'ollama', 'codex'].filter((e) => !db.disabledEngines().includes(e)), ...Object.keys(providers)]);
  /** Recarga los proveedores en el mismo objeto (el runner conserva la referencia). */
  // Los proveedores apagados a mano se quitan del conjunto activo (su clave sigue guardada en .env).
  const applyOff = () => { for (const n of db.disabledProviders()) delete providers[n]; };
  const reloadProviders = () => { for (const k of Object.keys(providers)) delete providers[k]; Object.assign(providers, loadProviders()); applyOff(); };
  applyOff();
  // Medición de modelos (Ollama y LM Studio): una a la vez; el resultado queda guardado para comparar y elegir.
  const benches = {};
  const benchOf = (engine) => (benches[engine] ??= { running: false, current: null, total: 0, results: [], skipped: [], free_gb: null, abort: null });
  const benchView = (engine) => {
    const bench = benchOf(engine);
    const last = db.engineBench(engine);
    return bench.running
      ? { engine, running: true, current: bench.current, total: bench.total, results: bench.results, skipped: bench.skipped, best: null, at: null, free_gb: bench.free_gb }
      : { engine, running: false, current: null, total: last?.results?.length ?? 0, results: last?.results ?? [], skipped: last?.skipped ?? [], best: last?.best ?? null, at: last?.at ?? null, free_gb: last?.free_gb ?? null };
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
    if (out.project) {
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
  const needsConfirm = (task) => route(task, db.disabledEngines()).mode === 'edit';

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
        engines_off: db.disabledEngines(),
        settings: db.settings(), providers: publicProviders(providers), templates: TEMPLATES, schedules: db.schedules(), costs: costs(),
        messages: db.messages(150),
      });
    }
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
        lmstudio: lm ?? [], lmstudio_up: lm !== null,
        engine_models: db.engineModels(), default_seen: db.defaultSeen(),
        defaults: { claude: db.defaultSeen().claude, ollama: ollamaDefault, codex: null, lmstudio: null },
      });
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
      db.audit(`${engine}.server.stop`, null, down ? 'ok' : 'sigue respondiendo');
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
      db.audit(`${engine}.server.start`, null, ok ? 'ok' : 'sin respuesta');
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
        if (bench.running) return send(res, 409, { error: 'Ya hay una medición en curso' });
        if (runner.stats().active[engine] > 0) return send(res, 409, { error: `${label} está ocupado con una misión: espera a que termine para medir` });
        let models; let baseUrl; let fetchFn; let measureFn;
        if (engine === 'ollama') {
          const ol = await probe.ollama().catch(() => ({ ok: false }));
          if (!ol.ok) return send(res, 400, { error: ol.error ?? 'Ollama no responde (¿está iniciado?)' });
          models = ol.models; baseUrl = config.ollamaUrl; fetchFn = ollamaFetch;
        } else {
          const lm = providers.lmstudio;
          if (!lm) return send(res, 400, { error: 'LM Studio está apagado en Sistema: enciéndelo primero' });
          try { models = await listLmStudio({ url: lm.baseUrl, fetchFn: ollamaFetch }); } catch { return send(res, 400, { error: 'LM Studio no responde: abre la app y activa su servidor local (pestaña Developer)' }); }
          baseUrl = lm.baseUrl; fetchFn = ollamaFetch; measureFn = measureLmStudio;
        }
        const freeGb = freeMem() / 1e9;
        const { candidates, skipped } = benchCandidates(models, freeGb);
        if (!candidates.length) return send(res, 400, { error: engine === 'ollama' ? 'No hay modelos de chat que medir (descarga uno, p. ej. «ollama pull gemma3:4b»)' : 'LM Studio no tiene modelos de chat descargados' });
        Object.assign(bench, { running: true, current: null, total: candidates.length, results: [], skipped, free_gb: Math.round(freeGb * 10) / 10, abort: new AbortController() });
        db.audit(`${engine}.benchmark`, null, `${candidates.length} modelos`);
        logger.info(`Midiendo ${candidates.length} modelos de ${label}`);
        runBenchmark(candidates, { url: baseUrl, fetchFn, measureFn, signal: bench.abort.signal, onProgress: (results, current) => { bench.results = [...results]; bench.current = current; } })
          .then((results) => {
            const done = { at: new Date().toISOString(), free_gb: bench.free_gb, skipped, results, best: recommend(results) };
            db.setEngineBench(engine, done);
            logger.info(`Medición de ${label} terminada. Recomendado: ${done.best ?? 'ninguno'}`);
          })
          .catch((e) => logger.warn(`Medición de ${label} falló: ${e.message}`))
          .finally(() => { bench.running = false; bench.current = null; });
        return send(res, 202, benchView(engine));
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
      // Sin agente (o "auto"): lo elige el despachador y, si ninguno encaja, crea uno nuevo.
      const auto = !body.agent || body.agent === 'auto';
      if (auto) {
        const probe = validate({ ...body, agent: listAgents()[0]?.name });
        if (probe.error) return send(res, 400, { error: probe.error });
      }
      let choice = null;
      if (auto) {
        try { choice = await dispatcher.choose({ title: body.title, description: body.description ?? '', project: body.project || null, mode: body.mode ?? 'read' }); } catch (e) { return send(res, 409, { error: `No se pudo elegir agente: ${e.message}` }); }
        body = { ...body, agent: choice.agent };
      }
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
      return send(res, 201, choice ? { ...task, auto: choice } : task);
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
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return send(res, 400, { error: 'Escribe una respuesta' });
        if (text.length > 4000) return send(res, 400, { error: 'La respuesta es demasiado larga (máx. 4000 caracteres)' });
        if (needsConfirm(task) && body.confirm !== true) return send(res, 409, { error: 'Esta misión puede editar archivos: requiere confirmación', needsConfirm: true });
        try { runner.reply(id, text); } catch (e) { return send(res, 409, { error: e.message }); }
        return send(res, 202, db.getTask(id));
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

  return { server, db, runner, scheduler, logger };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const { server, scheduler, logger } = createApp({ logger: createLogger({ echo: true }) });
  server.listen(config.port, config.host, () => {
    scheduler.start();
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
