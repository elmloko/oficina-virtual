// Pruebas del panel de Sistema: registro, .env, cola (pausa/límites), métricas y administración de proveedores.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-sys-'));
mkdirSync(join(tmp, 'agents'));
mkdirSync(join(tmp, 'htdocs', 'proj'), { recursive: true });
writeFileSync(join(tmp, 'htdocs', 'proj', 'composer.json'), '{}');
for (const a of ['backend', 'tester']) writeFileSync(join(tmp, 'agents', `${a}.md`), `---\nname: ${a}\ndescription: "x"\n---\n`);
process.env.AGENTS_DIR = join(tmp, 'agents');
process.env.HTDOCS_ROOT = join(tmp, 'htdocs');
process.env.EXTRA_ROOTS = '';
for (const k of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OFICINA_ANTHROPIC_API_KEY', 'CUSTOM_LLM']) delete process.env[k];

const { openDb } = await import('./db.js');
const { createRunner } = await import('./runner.js');
const { createApp } = await import('./index.js');
// config.js carga el .env real al importarse: se vuelven a quitar las claves para que las pruebas no dependan de las del usuario
for (const k of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OFICINA_ANTHROPIC_API_KEY', 'CUSTOM_LLM']) delete process.env[k];
const { createLogger } = await import('./logger.js');
const { setEnvVar } = await import('./envfile.js');
const { nextRun } = await import('./scheduler.js');
const { collectSystem, createProbe } = await import('./system.js');
const { config } = await import('./config.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = 'gsk_SECRETO_ABCDEFGH1234';
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

/** claude falso: termina tras `delay` ms; cuenta cuántos hay vivos a la vez. */
function slowClaude(delay = 40) {
  const stats = { live: 0, peak: 0, started: 0 };
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    stats.live++; stats.started++; stats.peak = Math.max(stats.peak, stats.live);
    let timer = setTimeout(() => { stats.live--; child.stdout.write(JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.01 }) + '\n'); child.stdout.end(); child.emit('close', 0); }, delay);
    child.kill = () => { clearTimeout(timer); stats.live--; child.stdout.end(); child.emit('close', 143); };
    return child;
  };
  return { spawnFn, stats };
}

// ---------- .env ----------
test('setEnvVar: agrega, reemplaza y quita conservando comentarios y otras líneas', () => {
  const f = join(tmp, 'a.env');
  writeFileSync(f, '# comentario\nPORT=4000\n\n');
  setEnvVar(f, 'GROQ_API_KEY', SECRET);
  assert.equal(readFileSync(f, 'utf8'), `# comentario\nPORT=4000\nGROQ_API_KEY=${SECRET}\n`);
  setEnvVar(f, 'GROQ_API_KEY', 'otra_clave_12345');
  assert.match(readFileSync(f, 'utf8'), /^GROQ_API_KEY=otra_clave_12345$/m);
  assert.equal((readFileSync(f, 'utf8').match(/GROQ_API_KEY/g) ?? []).length, 1);
  setEnvVar(f, 'GROQ_API_KEY', null);
  assert.equal(readFileSync(f, 'utf8'), '# comentario\nPORT=4000\n');
  const nuevo = join(tmp, 'b.env');
  setEnvVar(nuevo, 'OPENAI_API_KEY', SECRET);
  assert.equal(readFileSync(nuevo, 'utf8'), `OPENAI_API_KEY=${SECRET}\n`);
  assert.equal(existsSync(`${f}.tmp`), false, 'no deja archivos temporales');
});

test('setEnvVar: rechaza inyección de líneas, espacios, claves cortas y nombres raros', () => {
  const f = join(tmp, 'c.env');
  for (const bad of ['abc', 'clave con espacio', 'linea1\nPATH=/x', 'a'.repeat(301), 'tab\tvalor_largo']) {
    assert.throws(() => setEnvVar(f, 'GROQ_API_KEY', bad), /inválido/, JSON.stringify(bad));
  }
  for (const name of ['groq', 'A', 'X=Y', 'MI VAR', 'A\nB']) assert.throws(() => setEnvVar(f, name, SECRET), /inválido/);
  assert.equal(existsSync(f), false, 'una escritura rechazada no crea el archivo');
});

// ---------- logger ----------
test('logger: anillo acotado, ids crecientes, filtros y suscripción', () => {
  const log = createLogger({ max: 3 });
  const seen = [];
  const off = log.subscribe((e) => seen.push(e.msg));
  log.info('a'); log.warn('b'); log.error('c'); log.info('d');
  assert.deepEqual(log.list().map((e) => e.msg), ['b', 'c', 'd']);
  assert.deepEqual(log.list({ level: 'error' }).map((e) => e.msg), ['c']);
  assert.deepEqual(log.list({ after: 3 }).map((e) => e.msg), ['d']);
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  off(); log.info('e');
  assert.equal(seen.length, 4);
});

// ---------- próxima ejecución ----------
test('nextRun: diaria con días, ya vencida, intervalo y pausada', () => {
  const at = (d, h, m) => new Date(2026, 9, d, h, m); // 26-oct-2026 es lunes
  const base = { enabled: true, last_run: at(25, 12, 0).toISOString() };
  const daily = { ...base, spec: { type: 'daily', time: '08:30', days: [1, 3] } };
  assert.deepEqual(nextRun(daily, at(26, 7, 0)), at(26, 8, 30));
  assert.deepEqual(nextRun({ ...daily, last_run: at(26, 8, 31).toISOString() }, at(26, 9, 0)), at(28, 8, 30)); // ya corrió: miércoles
  assert.deepEqual(nextRun(daily, at(26, 9, 0)), at(26, 9, 0), 'vencida = ahora');
  assert.equal(nextRun({ ...daily, enabled: false }, at(26, 7, 0)), null);
  const every = { ...base, spec: { type: 'interval', minutes: 30 }, last_run: at(26, 10, 0).toISOString() };
  assert.deepEqual(nextRun(every, at(26, 10, 10)), at(26, 10, 30));
});

// ---------- base de datos ----------
test('db: actividad de hoy (éxito, duración media, por motor), fallos y conteos', () => {
  const db = openDb(':memory:');
  const mk = (agent, engine, status, cost, secs) => {
    const t = db.createTask({ title: agent, agent, engine });
    const start = new Date(Date.now() - secs * 1000);
    db.updateTask(t.id, { status, cost_usd: cost, started_at: start.toISOString(), finished_at: new Date().toISOString(), error: status === 'failed' ? 'boom' : null });
    return t;
  };
  mk('a', 'claude', 'review', 0.2, 10); mk('b', 'claude', 'done', 0.3, 20); mk('c', 'claude', 'failed', 0, 30); mk('d', 'ollama', 'review', 0, 4);
  const act = db.activityToday();
  assert.equal(act.total, 4);
  assert.equal(act.ok, 3);
  assert.equal(act.failed, 1);
  assert.equal(act.successRate, 0.75);
  assert.ok(Math.abs(act.avgSeconds - 16) < 0.5, `media ${act.avgSeconds}`);
  const claude = act.byEngine.find((e) => e.engine === 'claude');
  assert.deepEqual([claude.ok, claude.failed, claude.cost_usd], [2, 1, 0.5]);
  assert.equal(db.recentFailures(5).length, 1);
  assert.equal(db.recentFailures(5)[0].error, 'boom');
  assert.deepEqual(db.countsByStatus(), { review: 2, done: 1, failed: 1 });
  assert.equal(openDb(':memory:').activityToday().successRate, null, 'sin datos no hay tasa');
});

test('db: límites de concurrencia validados (enteros 1-16) y con valores por defecto', () => {
  const db = openDb(':memory:');
  assert.equal(db.settings().max_claude, config.maxClaude);
  for (const bad of [0, 17, 1.5, -1, 'x']) assert.throws(() => db.setSettings({ max_claude: bad }), /inválido|entero entre 1 y 16/, String(bad));
  assert.equal(db.setSettings({ max_claude: 4, max_api: 6 }).max_claude, 4);
  assert.equal(db.settings().max_api, 6);
});

// ---------- cola ----------
test('runner: en pausa no inicia tareas; al reanudar las ejecuta y el panel explica la espera', async () => {
  const db = openDb(':memory:');
  const { spawnFn, stats } = slowClaude(20);
  const runner = createRunner(db, () => {}, { spawnFn });
  runner.setPaused(true);
  const t = db.createTask({ title: 'x', agent: 'backend' });
  runner.enqueue(t.id);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(db.getTask(t.id).status, 'queued');
  assert.equal(stats.started, 0);
  const snap = runner.snapshot();
  assert.equal(snap.paused, true);
  assert.equal(snap.waiting[0].reason, 'cola en pausa');
  runner.setPaused(false);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(runner.snapshot().paused, false);
});

test('runner: el límite se cambia en caliente y se explica el motivo de espera', async () => {
  const db = openDb(':memory:');
  db.setSettings({ max_claude: 1 });
  const { spawnFn, stats } = slowClaude(120);
  const runner = createRunner(db, () => {}, { spawnFn });
  const ids = [1, 2, 3].map((n) => db.createTask({ title: `t${n}`, agent: 'backend' }).id);
  ids.forEach((id) => runner.enqueue(id));
  await waitFor(() => stats.started === 1);
  const snap = runner.snapshot();
  assert.equal(snap.running.length, 1);
  assert.equal(snap.waiting.length, 2);
  assert.match(snap.waiting[0].reason, /límite de concurrencia \(claude 1\/1\)/);
  db.setSettings({ max_claude: 3 });
  runner.kick();
  await waitFor(() => stats.started === 3);
  assert.equal(stats.peak, 3);
  await waitFor(() => ids.every((id) => db.getTask(id).status === 'review'));
});

test('runner: cancelAll detiene en curso y en espera', async () => {
  const db = openDb(':memory:');
  db.setSettings({ max_claude: 1 });
  const { spawnFn, stats } = slowClaude(500);
  const runner = createRunner(db, () => {}, { spawnFn });
  const ids = [1, 2, 3].map((n) => db.createTask({ title: `t${n}`, agent: 'backend' }).id);
  ids.forEach((id) => runner.enqueue(id));
  await waitFor(() => stats.started === 1);
  assert.equal(runner.cancelAll(), 3);
  assert.deepEqual(ids.map((id) => db.getTask(id).status), ['backlog', 'backlog', 'backlog']);
  assert.equal(runner.snapshot().waiting.length, 0);
  assert.equal(stats.live, 0);
});

// ---------- recolección de sistema ----------
test('collectSystem: estructura completa y sin ningún secreto', async () => {
  const db = openDb(':memory:');
  const runner = createRunner(db, () => {}, {});
  const probe = { claude: async () => ({ ok: true, version: '2.1.0 (Claude Code)' }), ollama: async () => ({ ok: false, error: 'Ollama no responde (¿está iniciado?)' }) };
  const env = { GROQ_API_KEY: SECRET };
  db.createSchedule({ name: 'diaria', spec: { type: 'daily', time: '08:30' }, agent: 'backend', title: 't' });
  const sys = await collectSystem({ db, runner, probe, config, startedAt: new Date(Date.now() - 65_000), env });
  for (const k of ['server', 'db', 'claude', 'ollama', 'providers', 'paths', 'queue', 'schedules', 'activity', 'failures', 'settings']) assert.ok(k in sys, k);
  assert.ok(sys.server.uptime_s >= 65);
  const groq = sys.providers.find((p) => p.name === 'groq');
  assert.deepEqual([groq.configured, groq.keyHint], [true, '••••1234']);
  assert.equal(sys.providers.find((p) => p.name === 'openai').configured, false);
  assert.equal(sys.paths.htdocs.exists, true);
  assert.equal(sys.paths.htdocs.projects, 1);
  assert.ok(sys.schedules[0].next_run);
  assert.equal(JSON.stringify(sys).includes(SECRET), false);
});

test('probe: Ollama caído se reporta sin lanzar error; claude ausente también', async () => {
  const probe = createProbe({ config, fetchFn: async () => { throw new Error('ECONNREFUSED'); }, exec: (c, a, o, cb) => cb(new Error('ENOENT')) });
  assert.equal((await probe.ollama()).ok, false);
  assert.equal((await probe.claude()).ok, false);
  const up = createProbe({
    config,
    fetchFn: async (u) => ({ json: async () => (u.endsWith('/api/tags') ? { models: [{ name: 'qwen3:4b', size: 123 }] } : { models: [{ name: 'qwen3:4b', size: 123 }] }) }),
    exec: (c, a, o, cb) => cb(null, '2.1.312 (Claude Code)\n'),
  });
  const o = await up.ollama();
  assert.deepEqual([o.ok, o.models[0].name, o.loaded[0].name], [true, 'qwen3:4b', 'qwen3:4b']);
  assert.deepEqual(await up.claude(), { ok: true, version: '2.1.312 (Claude Code)' });
});

// ---------- API ----------
test('API de sistema: estado, registro, pausa, cancelación total y ajustes', async () => {
  const logger = createLogger();
  const { spawnFn } = slowClaude(300);
  const probe = { claude: async () => ({ ok: true, version: 'x' }), ollama: async () => ({ ok: true, models: [], loaded: [] }) };
  const { server, db } = createApp({ db: openDb(':memory:'), logger, probe, envFile: join(tmp, 'api.env'), runnerOpts: { spawnFn } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json() }; };
  try {
    const sys = await call('GET', '/api/system');
    assert.equal(sys.status, 200);
    assert.equal(sys.json.claude.ok, true);
    assert.equal(sys.json.queue.paused, false);

    assert.deepEqual((await call('POST', '/api/queue/pause')).json, { paused: true });
    const t = (await call('POST', '/api/tasks', { title: 'x', agent: 'backend' })).json;
    assert.equal((await call('POST', `/api/tasks/${t.id}/run`, {})).status, 202);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(db.getTask(t.id).status, 'queued');
    assert.equal((await call('GET', '/api/system')).json.queue.waiting[0].reason, 'cola en pausa');
    assert.deepEqual((await call('POST', '/api/queue/resume')).json, { paused: false });
    await waitFor(() => db.getTask(t.id).status === 'running');
    assert.equal((await call('POST', '/api/queue/cancel-all')).json.cancelled, 1);
    assert.equal(db.getTask(t.id).status, 'backlog');

    const logs = (await call('GET', '/api/logs')).json;
    assert.ok(logs.some((e) => /Cola en pausa/.test(e.msg)));
    assert.ok(logs.some((e) => /Cola reanudada/.test(e.msg)));
    assert.ok(logs.some((e) => /Cancelación total/.test(e.msg)));
    const after = logs.at(-1).id;
    await call('PUT', '/api/settings', { max_claude: 3 });
    const newer = (await call('GET', `/api/logs?after=${after}`)).json;
    assert.ok(newer.some((e) => /Ajustes actualizados/.test(e.msg)));
    assert.ok((await call('GET', '/api/logs?level=warn')).json.every((e) => e.level === 'warn'));

    assert.equal((await call('PUT', '/api/settings', { max_claude: 0 })).status, 400);
    assert.equal((await call('GET', '/api/system')).json.settings.max_claude, 3);
    const actions = new Set((await call('GET', '/api/audit')).json.map((a) => a.action));
    for (const a of ['queue.pause', 'queue.resume', 'queue.cancel_all']) assert.ok(actions.has(a), a);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('API de proveedores: guardar clave, enmascarar, activar el motor, probar y quitar', async () => {
  const envFile = join(tmp, 'prov.env');
  writeFileSync(envFile, '# mis variables\nPORT=4000\n');
  const fetchCalls = [];
  let status = 200;
  const fetchFn = async (url, init) => { fetchCalls.push({ url, init }); return { ok: status === 200, status, text: async () => '' }; };
  const logger = createLogger();
  const { server, db } = createApp({ db: openDb(':memory:'), logger, envFile, probe: { claude: async () => ({ ok: true }), ollama: async () => ({ ok: true, models: [], loaded: [] }) }, runnerOpts: { fetchFn } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, text: await res.text() }; };
  const json = (r) => JSON.parse(r.text);
  try {
    assert.equal((await call('PUT', '/api/system/providers/nada/key', { key: SECRET })).status, 404);
    assert.equal((await call('POST', '/api/system/providers/groq/test')).status, 400, 'sin clave no se puede probar');
    assert.equal((await call('POST', '/api/tasks', { title: 'a', agent: 'backend', engine: 'groq' })).status, 400, 'motor aún no disponible');

    for (const bad of ['corta', 'con espacio 12345', 'x\nPATH=/evil1234']) assert.equal((await call('PUT', '/api/system/providers/groq/key', { key: bad })).status, 400, bad);
    assert.equal((await call('PUT', '/api/system/providers/groq/key', {})).status, 400);

    const put = await call('PUT', '/api/system/providers/groq/key', { key: SECRET });
    assert.equal(put.status, 200);
    assert.deepEqual([json(put).configured, json(put).keyHint], [true, '••••1234']);
    assert.equal(put.text.includes(SECRET), false);
    assert.equal(readFileSync(envFile, 'utf8'), `# mis variables\nPORT=4000\nGROQ_API_KEY=${SECRET}\n`);
    assert.equal(process.env.GROQ_API_KEY, SECRET);

    assert.equal((await call('POST', '/api/tasks', { title: 'a', agent: 'backend', engine: 'groq' })).status, 201, 'el motor se activa sin reiniciar');
    assert.deepEqual(json(await call('GET', '/api/state')).providers.map((p) => p.name), ['groq']);

    const ok = json(await call('POST', '/api/system/providers/groq/test'));
    assert.equal(ok.ok, true);
    assert.equal(fetchCalls.at(-1).url, 'https://api.groq.com/openai/v1/models');
    assert.equal(fetchCalls.at(-1).init.headers.Authorization, `Bearer ${SECRET}`);
    status = 401;
    const bad = json(await call('POST', '/api/system/providers/groq/test'));
    assert.deepEqual([bad.ok, bad.error], [false, 'Clave rechazada por el proveedor']);

    const everything = [(await call('GET', '/api/state')).text, (await call('GET', '/api/system')).text, (await call('GET', '/api/logs')).text, (await call('GET', '/api/audit')).text].join('\n');
    assert.equal(everything.includes(SECRET), false, 'la clave no aparece en ninguna respuesta');
    assert.ok(db.auditLog().some((a) => a.action === 'provider.key_set' && a.detail === 'groq'));

    const del = await call('DELETE', '/api/system/providers/groq/key');
    assert.equal(del.status, 200);
    assert.equal(json(del).configured, false);
    assert.equal(readFileSync(envFile, 'utf8'), '# mis variables\nPORT=4000\n');
    assert.equal(process.env.GROQ_API_KEY, undefined);
    assert.equal((await call('POST', '/api/tasks', { title: 'a', agent: 'backend', engine: 'groq' })).status, 400, 'al quitar la clave el motor desaparece');
  } finally { delete process.env.GROQ_API_KEY; server.close(); server.closeAllConnections?.(); }
});
