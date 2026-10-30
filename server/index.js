import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createScheduler, validateSpec } from './scheduler.js';
import { TEMPLATES } from './templates.js';
import { route } from './router.js';
import { listAgents, listProjects, resolveProject, isExtraRoot } from './registry.js';
import { loadProviders, publicProviders, knownProviders, testProvider, MODEL_RE } from './providers.js';
import { createLogger } from './logger.js';
import { setEnvVar, KEY_RE } from './envfile.js';
import { createProbe, collectSystem } from './system.js';
import { join } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MANUAL_STATUSES = new Set(['backlog', 'review', 'done']); // el resto lo mueve el runner
const MODES = new Set(['read', 'edit']);

export function createApp({ db = openDb(), runnerOpts = {}, now, providers = loadProviders(), logger = createLogger(), envFile = config.envFile, probe = createProbe({ config }) } = {}) {
  const startedAt = new Date();
  const engineSet = () => new Set(['auto', 'claude', 'ollama', ...Object.keys(providers)]);
  /** Recarga los proveedores en el mismo objeto (el runner conserva la referencia). */
  const reloadProviders = () => { for (const k of Object.keys(providers)) delete providers[k]; Object.assign(providers, loadProviders()); };
  const sockets = new Set();
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of sockets) if (ws.readyState === 1) ws.send(s); };
  const emit = (id, extra = {}) => { const task = db.getTask(id); if (task) broadcast({ type: 'task', task, ...extra }); };
  const runner = createRunner(db, emit, { ...runnerOpts, providers, logger });
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
    if ('engine' in out && !engineSet().has(out.engine)) return { error: 'Motor inválido (¿falta la clave del proveedor?)' };
    if ('mode' in out && !MODES.has(out.mode)) return { error: 'Modo inválido' };
    if (out.project) {
      if (!resolveProject(out.project)) return { error: 'Proyecto fuera de htdocs o inexistente' };
      if (isExtraRoot(out.project) && out.mode === 'edit') return { error: 'Las carpetas extra son de solo lectura' };
    } else if (out.mode === 'edit') return { error: 'Editar requiere un proyecto' };
    return { value: out };
  }

  /** Ejecutar con permiso de edición exige confirmación explícita (confirm:true). */
  const needsConfirm = (task) => route(task).mode === 'edit';

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
        settings: db.settings(), providers: publicProviders(providers), templates: TEMPLATES, schedules: db.schedules(), costs: costs(),
      });
    }
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
    if ((r = m(/^\/api\/system\/providers\/([\w-]+)\/(test|key)$/))) {
      const def = knownProviders().find((p) => p.name === r[1]);
      if (!def) return send(res, 404, { error: 'Proveedor desconocido' });
      if (r[2] === 'test' && method === 'POST') {
        const p = providers[def.name];
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
        return send(res, 200, knownProviders().find((p) => p.name === def.name));
      }
    }

    // --- tareas ---
    if (method === 'POST' && url.pathname === '/api/tasks') {
      const { error, value } = validate(await readJson(req));
      if (error) return send(res, 400, { error });
      const task = db.createTask(value);
      db.audit('task.create', task.id, `${task.agent} ${task.project ?? ''}`);
      emit(task.id);
      return send(res, 201, task);
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
        for (const c of db.children(id)) { runner.cancel(c.id); await runner.discardChanges(c.id).catch(() => {}); db.deleteTask(c.id); broadcast({ type: 'deleted', id: c.id }); }
        await runner.discardChanges(id).catch(() => {}); // sin cambios pendientes no hace nada
        db.deleteTask(id);
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
    logger.info(`Servidor iniciado en http://${config.host}:${config.port}`);
    console.log(`Oficina virtual en http://${config.host}:${config.port}`);
  });
}
