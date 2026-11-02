// Pruebas de las fases 3-6: coordinador, dependencias, presupuesto, timeout, rutinas y API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Entorno aislado: carpeta de proyectos y de agentes temporales (antes de importar config).
const tmp = mkdtempSync(join(tmpdir(), 'oficina-feat-'));
const htdocs = join(tmp, 'htdocs');
const agentsDir = join(tmp, 'agents');
mkdirSync(join(htdocs, 'proj'), { recursive: true });
writeFileSync(join(htdocs, 'proj', 'composer.json'), '{}');
mkdirSync(agentsDir);
for (const a of ['backend', 'tester', 'devops', 'reviewer', 'security', 'analyst']) {
  writeFileSync(join(agentsDir, `${a}.md`), `---\nname: ${a}\ndescription: "Agente ${a}"\n---\ncuerpo\n`);
}
const extra = join(tmp, 'descargas');
mkdirSync(extra);
process.env.HTDOCS_ROOT = htdocs;
process.env.EXTRA_ROOTS = `Descargas=${extra};Mal nombre=${extra};Fantasma=${join(tmp, 'no-existe')}`;
process.env.AGENTS_DIR = agentsDir;

const { openDb } = await import('./db.js');
const { createRunner } = await import('./runner.js');
const { createApp } = await import('./index.js');
const { parsePlan } = await import('./coordinator.js');
const { isDue, validateSpec, createScheduler } = await import('./scheduler.js');
const { listAgents, listProjects, resolveProject } = await import('./registry.js');
const { route } = await import('./router.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout esperando condición');
};

/** Fábrica de `claude` falso: registra args y stdin; `script(input, args)` devuelve líneas stream-json. */
function claudeFactory(script, { delay = 0, hang = false } = {}) {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call = { cmd, args, input: '' };
    calls.push(call);
    child.stdin.on('data', (d) => { call.input += d; });
    child.kill = () => { child.stdout.end(); child.emit('close', 143); };
    child.stdin.on('end', () => {
      if (hang) return;
      setTimeout(() => {
        const lines = script(call.input, args);
        for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
        child.stdout.end();
        child.emit('close', 0);
      }, delay);
    });
    return child;
  };
  return { spawnFn, calls };
}
const ok = (text, cost = 0.01) => () => [{ type: 'result', is_error: false, result: text, total_cost_usd: cost }];
const registry = { listAgents, listProjects };

// ---------- coordinador ----------
const AG = new Set(['backend', 'tester', 'devops']);
const PR = new Set(['proj']);
const plan = (steps) => JSON.stringify({ steps });

test('coordinador: parsea JSON dentro de bloque ```json y con texto alrededor', () => {
  const txt = 'Aquí el plan:\n```json\n' + plan([{ title: 'A', agent: 'backend', project: 'proj', mode: 'read', depends_on: [] }, { title: 'B', agent: 'tester', depends_on: [0] }]) + '\n```\nListo.';
  const steps = parsePlan(txt, AG, PR);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[1].depends_on, [0]);
  assert.equal(steps[1].project, null);
});

test('coordinador: rechaza planes inválidos', () => {
  const bad = (steps, re) => assert.throws(() => parsePlan(plan(steps), AG, PR), re);
  bad([{ title: 'x', agent: 'fantasma' }], /agente desconocido/);
  bad([{ title: 'x', agent: 'backend', project: 'otro' }], /proyecto desconocido/);
  bad([{ title: 'x', agent: 'backend', mode: 'edit' }], /requiere proyecto/);
  bad([{ title: 'x', agent: 'backend', depends_on: [0] }], /dependencia inválida/); // a sí mismo
  bad([{ title: 'x', agent: 'backend' }, { title: 'y', agent: 'backend', depends_on: [5] }], /dependencia inválida/);
  bad([], /no tiene pasos/);
  bad(Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, agent: 'backend' })), /excede/);
  assert.throws(() => parsePlan('sin json', AG, PR), /JSON/);
  assert.throws(() => parsePlan('{"steps":[', AG, PR), /incompleto/);
});

// ---------- rutinas ----------
test('rutinas: validateSpec', () => {
  assert.equal(validateSpec({ type: 'daily', time: '08:30', days: [1, 2] }), null);
  assert.ok(validateSpec({ type: 'daily', time: '25:00' }));
  assert.ok(validateSpec({ type: 'daily', time: '08:30', days: [7] }));
  assert.ok(validateSpec({ type: 'interval', minutes: 1 }));
  assert.equal(validateSpec({ type: 'interval', minutes: 60 }), null);
  assert.ok(validateSpec({ type: 'cron' }));
});

test('rutinas: isDue diaria respeta hora, día y no se dispara dos veces', () => {
  // 2026-10-26 es lunes. Hora local.
  const at = (d, h, m) => new Date(2026, 9, d, h, m);
  const s = { enabled: true, spec: { type: 'daily', time: '08:30', days: [1] }, last_run: at(25, 12, 0).toISOString() };
  assert.equal(isDue(s, at(26, 8, 29)), false);
  assert.equal(isDue(s, at(26, 8, 30)), true);
  assert.equal(isDue({ ...s, last_run: at(26, 8, 31).toISOString() }, at(26, 9, 0)), false); // ya corrió hoy
  assert.equal(isDue(s, at(27, 9, 0)), false); // martes: no está en days
  assert.equal(isDue({ ...s, enabled: false }, at(26, 9, 0)), false);
  // creada después de la hora de hoy: no corre hasta mañana
  assert.equal(isDue({ ...s, last_run: at(26, 10, 0).toISOString() }, at(26, 11, 0)), false);
});

test('rutinas: isDue por intervalo', () => {
  const t0 = new Date(2026, 9, 26, 10, 0);
  const s = { enabled: true, spec: { type: 'interval', minutes: 30 }, last_run: t0.toISOString() };
  assert.equal(isDue(s, new Date(t0.getTime() + 29 * 60_000)), false);
  assert.equal(isDue(s, new Date(t0.getTime() + 30 * 60_000)), true);
});

test('scheduler.tick: crea la tarea en solo lectura, la encola y marca last_run', () => {
  const db = openDb(':memory:');
  const t0 = new Date(2026, 9, 26, 8, 0); // lunes 08:00
  const sch = db.createSchedule({ name: 'diaria', spec: { type: 'daily', time: '08:30', days: [1] }, agent: 'reviewer', title: 'Revisar', last_run: new Date(2026, 9, 25).toISOString() });
  const enqueued = [];
  let clock = new Date(t0);
  const sched = createScheduler({ db, runner: { enqueue: (id) => enqueued.push(id) }, emit: () => {}, now: () => clock });
  assert.equal(sched.tick().length, 0); // 08:00 aún no
  clock = new Date(2026, 9, 26, 8, 31);
  const fired = sched.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].mode, 'read');
  assert.equal(fired[0].schedule_id, sch.id);
  assert.deepEqual(enqueued, [fired[0].id]);
  assert.equal(sched.tick().length, 0); // no repite
});

// ---------- runner: dependencias, presupuesto, timeout, coordinador ----------
test('runner: una tarea espera a su dependencia y recibe su resultado como contexto', async () => {
  const db = openDb(':memory:');
  const a = db.createTask({ title: 'A', agent: 'backend' });
  const b = db.createTask({ title: 'B', agent: 'tester', depends_on: [a.id] });
  const { spawnFn, calls } = claudeFactory((input) => [{ type: 'result', result: /INSTRUCCIONES[^\n]*\nA(\n|$)/.test(input) ? 'RESULTADO-A' : 'fin-B' }], { delay: 30 });
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  runner.enqueue(a.id);
  runner.enqueue(b.id); // A sigue en curso: B espera su resultado
  await waitFor(() => db.getTask(b.id).status === 'review');
  assert.equal(calls.length, 2);
  assert.match(calls[0].input, /INSTRUCCIONES[^\n]*\nA(\n|$)/, 'A debe correr primero');
  assert.match(calls[1].input, /RESULTADO-A/);
});

test('runner: si la dependencia falla, el dependiente falla sin ejecutarse (en cascada)', async () => {
  const db = openDb(':memory:');
  const a = db.createTask({ title: 'A', agent: 'backend' });
  const b = db.createTask({ title: 'B', agent: 'tester', depends_on: [a.id] });
  const c = db.createTask({ title: 'C', agent: 'tester', depends_on: [b.id] });
  const { spawnFn, calls } = claudeFactory(() => [{ type: 'result', is_error: true, result: 'boom' }]);
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  [a, b, c].forEach((t) => runner.enqueue(t.id));
  await waitFor(() => db.getTask(c.id).status === 'failed');
  assert.equal(db.getTask(a.id).status, 'failed');
  assert.match(db.getTask(b.id).error, /dependencia/);
  assert.match(db.getTask(c.id).error, /dependencia/);
  assert.equal(calls.length, 1);
});

test('runner: cancelar una tarea hace fallar a sus dependientes', async () => {
  const db = openDb(':memory:');
  const a = db.createTask({ title: 'A', agent: 'backend' });
  const b = db.createTask({ title: 'B', agent: 'tester', depends_on: [a.id] });
  const { spawnFn } = claudeFactory(ok('x'), { hang: true });
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  runner.enqueue(a.id);
  runner.enqueue(b.id);
  await waitFor(() => db.getTask(a.id).status === 'running');
  runner.cancel(a.id);
  await waitFor(() => db.getTask(b.id).status === 'failed');
  assert.equal(db.getTask(a.id).status, 'backlog');
});

test('runner: presupuesto diario agotado bloquea Claude pero no Ollama', async () => {
  const db = openDb(':memory:');
  db.setSettings({ daily_budget_usd: 1 });
  const spent = db.createTask({ title: 'gastó', agent: 'backend' });
  db.updateTask(spent.id, { status: 'review', cost_usd: 1.5, finished_at: new Date().toISOString() });
  assert.ok(db.costToday() >= 1.5);
  const t = db.createTask({ title: 'otra', agent: 'backend' });
  const runner = createRunner(db, () => {}, { spawnFn: claudeFactory(ok('x')).spawnFn, registry });
  assert.throws(() => runner.enqueue(t.id), /Presupuesto diario agotado/);
  const light = db.createTask({ title: 'resumen', agent: 'summarizer' });
  const body = (async function* () { yield Buffer.from(JSON.stringify({ message: { content: 'hola' } }) + '\n'); })();
  const r2 = createRunner(db, () => {}, { fetchFn: async () => ({ ok: true, body }), registry });
  r2.enqueue(light.id);
  await waitFor(() => db.getTask(light.id).status === 'review');
});

test('runner: tope por tarea se pasa a claude y el objetivo no usa --agent', async () => {
  const db = openDb(':memory:');
  db.setSettings({ task_budget_usd: 3 });
  const t = db.createTask({ title: 'x', agent: 'backend' });
  const { spawnFn, calls } = claudeFactory(ok('ok'));
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '3');
  assert.equal(args[args.indexOf('--agent') + 1], 'backend');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('runner: timeout mata el proceso y marca la tarea fallida', async () => {
  const db = openDb(':memory:');
  db.setSettings({ task_timeout_min: 0.001 }); // 60 ms
  const t = db.createTask({ title: 'cuelga', agent: 'backend' });
  const runner = createRunner(db, () => {}, { spawnFn: claudeFactory(ok('x'), { hang: true }).spawnFn, registry });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'failed');
  assert.match(db.getTask(t.id).error, /Tiempo agotado/);
});

test('runner: un objetivo crea pasos con dependencias reales; un plan inválido falla', async () => {
  const db = openDb(':memory:');
  const reg = { listAgents: () => [{ name: 'backend', description: 'd' }, { name: 'tester', description: 'd' }], listProjects: () => [{ name: 'proj' }] };
  const good = plan([
    { title: 'Diseñar', agent: 'backend', project: 'proj', depends_on: [] },
    { title: 'Probar', agent: 'tester', project: 'proj', depends_on: [0] },
  ]);
  const { spawnFn, calls } = claudeFactory(ok(good));
  const runner = createRunner(db, () => {}, { spawnFn, registry: reg });
  const obj = db.createTask({ title: 'Meta', agent: 'coordinador', engine: 'claude', kind: 'objective' });
  runner.enqueue(obj.id);
  await waitFor(() => db.getTask(obj.id).status === 'review');
  const kids = db.children(obj.id);
  assert.equal(kids.length, 2);
  assert.deepEqual(kids[1].depends_on, [kids[0].id]);
  assert.ok(!calls[0].args.includes('--agent'));
  assert.match(calls[0].input, /OBJETIVO/);

  const bad = db.createTask({ title: 'Meta2', agent: 'coordinador', engine: 'claude', kind: 'objective' });
  const r2 = createRunner(db, () => {}, { spawnFn: claudeFactory(ok(plan([{ title: 'x', agent: 'fantasma' }]))).spawnFn, registry: reg });
  r2.enqueue(bad.id);
  await waitFor(() => db.getTask(bad.id).status === 'failed');
  assert.match(db.getTask(bad.id).error, /agente desconocido/);
  assert.equal(db.children(bad.id).length, 0);
});

test('db: costos por agente y por día, ajustes validados', () => {
  const db = openDb(':memory:');
  const a = db.createTask({ title: 'a', agent: 'backend' });
  const b = db.createTask({ title: 'b', agent: 'backend' });
  const c = db.createTask({ title: 'c', agent: 'tester' });
  for (const [t, cost] of [[a, 0.5], [b, 0.25], [c, 0.1]]) db.updateTask(t.id, { status: 'review', cost_usd: cost, finished_at: new Date().toISOString() });
  const by = db.costByAgent();
  assert.equal(by[0].agent, 'backend');
  assert.equal(by[0].cost_usd, 0.75);
  assert.equal(by[0].tasks, 2);
  assert.equal(db.costByDay().length, 1);
  assert.throws(() => db.setSettings({ daily_budget_usd: -1 }), /inválido/);
  assert.equal(db.setSettings({ nada: 5 }).daily_budget_usd, 10); // claves desconocidas se ignoran
});

// ---------- API ----------
let app, base;
const { spawnFn: apiSpawn, calls: apiCalls } = claudeFactory((input) => {
  if (input.includes('OBJETIVO')) {
    return [{ type: 'result', result: plan([{ title: 'Paso 1', agent: 'reviewer', project: 'proj', depends_on: [] }, { title: 'Paso 2', agent: 'security', project: 'proj', depends_on: [0] }]), total_cost_usd: 0.02 }];
  }
  return [{ type: 'result', result: 'hecho', total_cost_usd: 0.01 }];
});

before(async () => {
  app = createApp({ db: openDb(':memory:'), runnerOpts: { spawnFn: apiSpawn } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.server.closeAllConnections?.(); });

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('API: ejecutar con edición exige confirmación explícita; infraestructura nunca edita', async () => {
  const t = (await call('POST', '/api/tasks', { title: 'Editar', agent: 'backend', project: 'proj', mode: 'edit' })).body;
  const sin = await call('POST', `/api/tasks/${t.id}/run`, {});
  assert.equal(sin.status, 409);
  assert.equal(sin.body.needsConfirm, true);
  assert.equal((await call('POST', `/api/tasks/${t.id}/run`, { confirm: true })).status, 202);
  await waitFor(async () => (await call('GET', '/api/state')).body.tasks.find((x) => x.id === t.id).status === 'review' || false).catch(() => {});
  await waitFor(() => app.db.getTask(t.id).status === 'review');
  assert.equal(apiCalls.at(-1).args[apiCalls.at(-1).args.indexOf('--permission-mode') + 1], 'acceptEdits');

  const infra = (await call('POST', '/api/tasks', { title: 'Deploy', agent: 'devops', project: 'proj', mode: 'edit' })).body;
  assert.equal((await call('POST', `/api/tasks/${infra.id}/run`, {})).status, 202); // se degrada a solo lectura, sin confirmación
  await waitFor(() => app.db.getTask(infra.id).status === 'review');
  assert.equal(app.db.getTask(infra.id).mode, 'read');
});

test('API: flujo de objetivo → plan → lanzar → pasos en orden', async () => {
  const obj = (await call('POST', '/api/objectives', { title: 'Auditar el proyecto' })).body;
  assert.equal(obj.kind, 'objective');
  assert.equal((await call('POST', `/api/tasks/${obj.id}/run`, {})).status, 202);
  await waitFor(() => app.db.getTask(obj.id).status === 'review');
  const state = (await call('GET', '/api/state')).body;
  const kids = state.tasks.filter((t) => t.parent_id === obj.id).sort((a, b) => a.id - b.id);
  assert.equal(kids.length, 2);
  assert.deepEqual(kids[1].depends_on, [kids[0].id]);

  const l = await call('POST', `/api/tasks/${obj.id}/launch`, {});
  assert.equal(l.status, 202);
  assert.equal(l.body.launched, 2);
  await waitFor(() => kids.every((k) => app.db.getTask(k.id).status === 'review'));
  assert.ok(app.db.getTask(kids[0].id).finished_at <= app.db.getTask(kids[1].id).finished_at);
  assert.equal((await call('POST', `/api/tasks/${obj.id}/launch`, {})).status, 409); // nada pendiente

  await call('DELETE', `/api/tasks/${obj.id}`);
  assert.equal(app.db.children(obj.id).length, 0); // borra también los pasos
});

test('API: ajustes y costos', async () => {
  assert.equal((await call('PUT', '/api/settings', { daily_budget_usd: -5 })).status, 400);
  const s = await call('PUT', '/api/settings', { daily_budget_usd: 7, task_timeout_min: 30 });
  assert.equal(s.body.daily_budget_usd, 7);
  const c = (await call('GET', '/api/costs')).body;
  assert.ok(c.today > 0);
  assert.ok(c.byAgent.length > 0);
  assert.equal(c.daily_budget_usd, 7);
});

test('API: rutinas desde plantilla, ejecutar ahora, pausar y borrar', async () => {
  assert.equal((await call('POST', '/api/schedules', { template: 'auditoria-seguridad' })).status, 400); // falta proyecto
  assert.equal((await call('POST', '/api/schedules', { template: 'nada' })).status, 400);
  assert.equal((await call('POST', '/api/schedules', { template: 'auditoria-seguridad', project: '..' })).status, 400);
  assert.equal((await call('POST', '/api/schedules', { name: 'x', title: 'x', agent: 'backend', spec: { type: 'interval', minutes: 1 } })).status, 400);

  const s = await call('POST', '/api/schedules', { template: 'auditoria-seguridad', project: 'proj' });
  assert.equal(s.status, 201);
  assert.equal(s.body.agent, 'security');
  const run = await call('POST', `/api/schedules/${s.body.id}/run`);
  assert.equal(run.status, 202);
  assert.equal(run.body.schedule_id, s.body.id);
  assert.equal(run.body.mode, 'read');
  await waitFor(() => app.db.getTask(run.body.id).status === 'review');

  assert.equal((await call('PATCH', `/api/schedules/${s.body.id}`, { enabled: false })).body.enabled, false);
  assert.equal((await call('PATCH', `/api/schedules/${s.body.id}`, { spec: { type: 'daily', time: '99:99' } })).status, 400);
  assert.equal((await call('DELETE', `/api/schedules/${s.body.id}`)).status, 200);
  assert.equal((await call('GET', '/api/schedules')).body.length, 0);
});

test('API: auditoría registra acciones relevantes', async () => {
  const log = (await call('GET', '/api/audit')).body;
  const actions = new Set(log.map((e) => e.action));
  for (const a of ['task.create', 'task.run', 'objective.create', 'plan.created', 'plan.launch', 'schedule.create', 'schedule.run', 'settings.update']) {
    assert.ok(actions.has(a), `falta ${a}`);
  }
});

test('plantillas: todas válidas y solo lectura', async () => {
  const { TEMPLATES } = await import('./templates.js');
  const names = new Set(listAgents().map((a) => a.name));
  for (const t of TEMPLATES) {
    assert.equal(validateSpec(t.spec), null, t.id);
    assert.ok(t.title && t.description, t.id);
    void names; // los agentes reales se validan en la prueba de humo contra ~/.claude/agents
  }
});

// ---------- carpetas extra (solo lectura) ----------
test('carpetas extra: se listan, resuelven solo por nombre exacto y no admiten subrutas', () => {
  const names = listProjects().map((p) => p.name);
  assert.ok(names.includes('@Descargas'));
  assert.ok(!names.includes('@Fantasma'), 'una ruta inexistente no se lista');
  assert.ok(!names.some((n) => n.includes('Mal')), 'nombres inválidos se descartan');
  assert.equal(resolveProject('@Descargas'), extra);
  assert.equal(resolveProject('@Descargas/../htdocs'), null);
  assert.equal(resolveProject('@Otra'), null);
  assert.equal(resolveProject('@constructor'), null);
  assert.equal(resolveProject('@Fantasma'), null);
  assert.ok(listProjects().find((p) => p.name === '@Descargas').extra);
});

test('carpetas extra: el router fuerza solo lectura', () => {
  assert.equal(route({ agent: 'backend', mode: 'edit', project: '@Descargas' }).mode, 'read');
  assert.equal(route({ agent: 'backend', mode: 'edit', project: 'proj' }).mode, 'edit');
});

test('API: carpetas extra rechazan edición y la plantilla de Excel usa @Descargas por defecto', async () => {
  assert.equal((await call('POST', '/api/tasks', { title: 'x', agent: 'analyst', project: '@Descargas', mode: 'edit' })).status, 400);
  const ok = await call('POST', '/api/tasks', { title: 'Leer Excel', agent: 'reviewer', project: '@Descargas', mode: 'read' });
  assert.equal(ok.status, 201);
  const s = await call('POST', '/api/schedules', { template: 'informe-operativo' });
  assert.equal(s.status, 201);
  assert.equal(s.body.project, '@Descargas');
  assert.equal(s.body.agent, 'analyst');
  await call('DELETE', `/api/schedules/${s.body.id}`);
});

test('API: responder a un agente continúa la misma misión con la conversación como contexto', async () => {
  const t = (await call('POST', '/api/tasks', { title: 'Revisar tarifas', agent: 'analyst' })).body;
  assert.equal((await call('POST', `/api/tasks/${t.id}/reply`, { text: 'hola' })).status, 409); // aún no se ejecutó
  await call('POST', `/api/tasks/${t.id}/run`, {});
  await waitFor(() => app.db.getTask(t.id).status === 'review');

  assert.equal((await call('POST', `/api/tasks/${t.id}/reply`, { text: '   ' })).status, 400);
  assert.equal((await call('POST', `/api/tasks/${t.id}/reply`, { text: 'x'.repeat(4001) })).status, 400);
  const before = apiCalls.length;
  const r = await call('POST', `/api/tasks/${t.id}/reply`, { text: 'Usa la tarifa nacional' });
  assert.equal(r.status, 202);
  await waitFor(() => app.db.getTask(t.id).status === 'review');
  app.db.updateTask(t.id, { status: 'running' }); // simula una misión en curso
  const busy = await call('POST', `/api/tasks/${t.id}/reply`, { text: 'otra' });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /en curso/);
  app.db.updateTask(t.id, { status: 'review' });

  const prompt = apiCalls.at(-1).input;
  assert.equal(apiCalls.length, before + 1);
  assert.match(prompt, /Revisar tarifas/);
  assert.match(prompt, /Tú \(analyst\): hecho/); // la respuesta anterior del agente
  assert.match(prompt, /Usuario: Usa la tarifa nacional/);
  const kinds = app.db.events(t.id).map((e) => e.kind);
  assert.ok(kinds.includes('user') && kinds.includes('answer'));
  assert.ok(app.db.auditLog(50).some((a) => a.action === 'task.reply' && a.task_id === t.id));
  assert.equal(app.db.getTask(t.id).result, 'hecho');
});

test('API: responder a una misión que edita archivos exige confirmación; los objetivos no admiten respuesta', async () => {
  const t = (await call('POST', '/api/tasks', { title: 'Editar con charla', agent: 'backend', project: 'proj', mode: 'edit' })).body;
  await call('POST', `/api/tasks/${t.id}/run`, { confirm: true });
  await waitFor(() => app.db.getTask(t.id).status === 'review');
  const sin = await call('POST', `/api/tasks/${t.id}/reply`, { text: 'sigue' });
  assert.equal(sin.status, 409);
  assert.equal(sin.body.needsConfirm, true);
  assert.equal(app.db.events(t.id).filter((e) => e.kind === 'user').length, 0); // sin confirmar no deja rastro
  assert.equal((await call('POST', `/api/tasks/${t.id}/reply`, { text: 'sigue', confirm: true })).status, 202);
  await waitFor(() => app.db.getTask(t.id).status === 'review');

  const obj = (await call('POST', '/api/objectives', { title: 'Un objetivo' })).body;
  app.db.updateTask(obj.id, { status: 'review' });
  assert.equal((await call('POST', `/api/tasks/${obj.id}/reply`, { text: 'hola' })).status, 409);
  assert.equal((await call('POST', '/api/tasks/99999/reply', { text: 'hola' })).status, 404);
});

test('API: una respuesta rechazada por presupuesto no deja mensajes huérfanos', async () => {
  const t = (await call('POST', '/api/tasks', { title: 'Con presupuesto', agent: 'tester' })).body;
  await call('POST', `/api/tasks/${t.id}/run`, {});
  await waitFor(() => app.db.getTask(t.id).status === 'review');
  const prev = app.db.settings().daily_budget_usd;
  app.db.setSettings({ daily_budget_usd: 0.0001 });
  try {
    const r = await call('POST', `/api/tasks/${t.id}/reply`, { text: 'más' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Presupuesto/);
    assert.equal(app.db.events(t.id).filter((e) => e.kind === 'user').length, 0);
    assert.equal(app.db.getTask(t.id).status, 'review');
  } finally { app.db.setSettings({ daily_budget_usd: prev }); }
});

// `claude` falso controlable: responde tras `ms` salvo que lo maten antes (kill cancela el temporizador).
function slowClaude(ms, answer) {
  const calls = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const call = { input: '' }; calls.push(call);
    let timer;
    child.stdin.on('data', (d) => { call.input += d; });
    child.kill = () => { clearTimeout(timer); child.stdout.end(); child.emit('close', 143); };
    child.stdin.on('end', () => {
      timer = setTimeout(() => {
        child.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: answer(call.input), total_cost_usd: 0.5 }) + '\n');
        child.stdout.end(); child.emit('close', 0);
      }, ms);
    });
    return child;
  };
  return { spawnFn, calls };
}

test('cancelar una respuesta la deshace: la misión vuelve a su estado anterior y el mensaje queda para editarlo', async () => {
  const db = openDb(':memory:');
  const { spawnFn, calls } = slowClaude(150, (i) => (i.includes('Usuario:') ? 'continuado' : '¿Cuál tarifa?'));
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  const t = db.createTask({ title: 'Tarifas', agent: 'analyst', engine: 'claude' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(db.getTask(t.id).result, '¿Cuál tarifa?');

  runner.reply(t.id, 'la internacioal'); // con el error de tipeo
  await waitFor(() => db.getTask(t.id).status === 'running');
  assert.equal(db.getTask(t.id).reply_text, 'la internacioal');
  runner.cancel(t.id);

  const back = db.getTask(t.id);
  assert.equal(back.status, 'review'); // no queda en backlog: vuelve a como estaba antes de responder
  assert.equal(back.result, '¿Cuál tarifa?');
  assert.equal(back.reply_text, 'la internacioal'); // para editarlo
  assert.ok(!db.events(t.id).some((e) => e.kind === 'user' || e.kind === 'answer'));
  assert.ok(db.events(t.id).some((e) => e.kind === 'info' && /editarla y reenviarla/.test(e.text)));
  await new Promise((r) => setTimeout(r, 250)); // el proceso muerto no debe pisar el estado
  assert.equal(db.getTask(t.id).status, 'review');

  runner.reply(t.id, 'la internacional'); // reenvío corregido
  await waitFor(() => db.getTask(t.id).status === 'review' && db.getTask(t.id).result === 'continuado');
  const prompt = calls.at(-1).input;
  assert.match(prompt, /Usuario: la internacional/);
  assert.doesNotMatch(prompt, /internacioal/); // el mensaje equivocado no llega al agente
  assert.match(prompt, /Tú \(analyst\): ¿Cuál tarifa\?/);
  assert.equal(db.getTask(t.id).reply_text, null); // al completar ya no hay mensaje pendiente
  assert.equal(db.getTask(t.id).cost_usd, 1); // 0.5 de la primera ejecución + 0.5 de la respuesta (no se pisa)
  db.raw.close();
});

test('cancelar una ejecución normal (no una respuesta) sigue mandando la misión al hangar', async () => {
  const db = openDb(':memory:');
  const { spawnFn } = slowClaude(150, () => 'x');
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  const t = db.createTask({ title: 'Normal', agent: 'analyst', engine: 'claude' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'running');
  runner.cancel(t.id);
  assert.equal(db.getTask(t.id).status, 'backlog');
  assert.equal(db.getTask(t.id).reply_text, null);
  await new Promise((r) => setTimeout(r, 250)); // deja terminar el proceso cancelado antes de cerrar la base
  db.raw.close();
});

// ---------- revisión cruzada ----------
test('API: valida la cadena de revisión (lista de agentes existentes, sin repetir y sin el propio autor)', async () => {
  const mk = (review) => call('POST', '/api/tasks', { title: 'X', agent: 'backend', review });
  assert.equal((await mk('reviewer')).status, 400); // no es lista
  assert.equal((await mk(['fantasma'])).status, 400);
  assert.equal((await mk(['backend'])).status, 400); // el autor no se revisa a sí mismo
  assert.equal((await mk(['reviewer', 'security', 'tester', 'devops', 'analyst'])).status, 400); // demasiados
  const ok = await mk(['reviewer', 'reviewer', 'security']); // los repetidos se colapsan
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.chain, ['reviewer', 'security']);
  assert.deepEqual((await call('POST', '/api/tasks', { title: 'Sin cadena', agent: 'backend' })).body.chain, []);
});

test('revisión cruzada: al terminar bien se lanzan los revisores (solo lectura, con el resultado), una sola vez', async () => {
  const t = (await call('POST', '/api/tasks', { title: 'Endpoint de guías', agent: 'backend', review: ['reviewer', 'security'] })).body;
  await call('POST', `/api/tasks/${t.id}/run`, {});
  await waitFor(() => app.db.listTasks().filter((x) => x.review_of === t.id).length === 2 && app.db.listTasks().filter((x) => x.review_of === t.id).every((x) => x.status === 'review'), 6000);
  const revs = app.db.listTasks().filter((x) => x.review_of === t.id).sort((a, b) => a.id - b.id);
  assert.deepEqual(revs.map((r) => r.agent), ['reviewer', 'security']);
  for (const r of revs) {
    assert.equal(r.mode, 'read');
    assert.deepEqual(r.depends_on, [t.id]);
    assert.equal(r.project, null);
    assert.match(r.title, new RegExp(`Revisar #${t.id}`));
  }
  assert.match(revs[1].description, /tenants/); // el revisor de seguridad recibe su foco
  assert.equal(app.db.getTask(t.id).chain_fired, 1);
  assert.ok(app.db.events(t.id).some((e) => /Revisión automática en curso/.test(e.text)));

  // el revisor ve el resultado de la misión original
  const revPrompt = apiCalls.filter((c) => c.input.includes(`Revisa con criterio el trabajo de la misión #${t.id}`));
  assert.equal(revPrompt.length, 2);
  assert.ok(revPrompt[0].input.includes(`--- Resultado del paso previo #${t.id} (Endpoint de guías) ---\nhecho`));

  // responder a la misión original no vuelve a lanzar revisiones
  await call('POST', `/api/tasks/${t.id}/reply`, { text: 'ajusta algo' });
  await waitFor(() => app.db.getTask(t.id).status === 'review' && app.db.getTask(t.id).reply_text === null);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.db.listTasks().filter((x) => x.review_of === t.id).length, 2);
});

test('revisión cruzada: una misión fallida o cancelada no lanza revisores', async () => {
  const f = claudeFactory(() => [{ type: 'result', is_error: true, result: 'boom', total_cost_usd: 0 }]);
  const db = openDb(':memory:');
  const runner = createRunner(db, () => {}, { spawnFn: f.spawnFn, registry });
  const t = db.createTask({ title: 'Falla', agent: 'backend', engine: 'claude', chain: ['reviewer'] });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'failed');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.listTasks().length, 1);
  assert.equal(db.getTask(t.id).chain_fired, 0); // si se reintenta y sale bien, entonces sí se revisa
  db.raw.close();
});

test('revisión cruzada: si falla el presupuesto de un revisor, la misión original sigue bien y queda el aviso', async () => {
  const f = claudeFactory(ok('listo', 5)); // cada ejecución cuesta $5
  const db = openDb(':memory:');
  db.setSettings({ daily_budget_usd: 1 });
  const runner = createRunner(db, () => {}, { spawnFn: f.spawnFn, registry });
  const t = db.createTask({ title: 'Cara', agent: 'backend', engine: 'claude', chain: ['reviewer'] });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.getTask(t.id).status, 'review'); // no se marca fallida por culpa del revisor
  assert.ok(db.events(t.id).some((e) => /No se pudo lanzar la revisión de reviewer: Presupuesto/.test(e.text)));
  db.raw.close();
});

test('Modo infraestructura: servidores sin secretos, destino «srv:», el agente solo planifica', async () => {
  assert.equal((await call('PUT', '/api/servers', { servers: [{ name: 'web 1', host: 'bad host!' }] })).status, 400);
  assert.equal((await call('PUT', '/api/servers', { servers: [{ name: 'a', host: 'x.com' }, { name: 'A', host: 'y.com' }] })).status, 400); // repetido
  const ok = await call('PUT', '/api/servers', { servers: [{ name: 'prod-web', host: '10.0.0.5', user: 'deploy', port: 2222, env: 'prod', notes: 'nginx + php-fpm', password: 'nunca' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body[0].password, undefined); // ni se guarda ni se devuelve
  assert.equal((await call('GET', '/api/state')).body.servers[0].name, 'prod-web');

  assert.equal((await call('POST', '/api/tasks', { title: 'x', agent: 'devops', project: 'srv:no-existe', mode: 'infra' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'x', agent: 'devops', project: 'srv:prod-web', mode: 'edit' })).status, 400); // un servidor no se «edita»
  const t = (await call('POST', '/api/tasks', { title: 'Revisar nginx', description: 'Está lento', agent: 'devops', project: 'srv:prod-web', mode: 'infra', engine: 'claude' })).body;
  const before = apiCalls.length;
  const sinOk = await call('POST', `/api/tasks/${t.id}/run`, {});
  assert.equal(sinOk.status, 409); assert.equal(sinOk.body.needsConfirm, true); // con Claude puede operar el servidor: confirmación
  assert.equal((await call('POST', `/api/tasks/${t.id}/run`, { confirm: true })).status, 202);
  await waitFor(() => apiCalls.length > before);
  const input = apiCalls[before].input;
  assert.match(input, /Modo infraestructura \(con ejecución\)/);
  assert.match(input, /infra-exec\.mjs/);
  assert.match(input, /deploy@10\.0\.0\.5:2222 · entorno prod/);
  assert.match(input, /ES PRODUCCIÓN/);
  const args = apiCalls[before].args;
  assert.ok(!args.includes('acceptEdits')); // nunca edita archivos
  assert.ok(args.some((a) => /^Bash\(node .*infra-exec\.mjs:\*\)$/.test(a))); // su único Bash es la herramienta de la oficina
  assert.equal(route({ agent: 'backend', project: 'srv:x' }).mode, 'infra');
  assert.equal((await call('PUT', '/api/servers', { servers: [] })).status, 200);
});

test('prompt: el título es solo una etiqueta; las instrucciones son la descripción (sin descripción, el título)', async () => {
  const db = openDb(':memory:');
  const a = db.createTask({ title: 'ETIQUETA-X', description: 'Haz la tarea Z con detalle', agent: 'backend' });
  const b = db.createTask({ title: 'Solo título como instrucción', agent: 'backend' });
  const { spawnFn, calls } = claudeFactory(ok('hecho'));
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  runner.enqueue(a.id); runner.enqueue(b.id);
  await waitFor(() => db.getTask(a.id).status === 'review' && db.getTask(b.id).status === 'review');
  const pa = calls.find((c) => c.input.includes('ETIQUETA-X')).input;
  assert.ok(pa.includes('NO la tomes como instrucción'));
  assert.ok(pa.includes('INSTRUCCIONES (haz exactamente esto):\nHaz la tarea Z con detalle'));
  const pb = calls.find((c) => c.input.includes('Solo título')).input;
  assert.ok(pb.includes('INSTRUCCIONES (haz exactamente esto):\nSolo título como instrucción'));
  assert.ok(!pb.includes('NO la tomes como instrucción'));
});
