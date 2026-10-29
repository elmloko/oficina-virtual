import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { route } from './router.js';
import { resolveProject } from './registry.js';
import { createRunner } from './runner.js';
import { createApp } from './index.js';

const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

// Proceso falso de `claude -p` que emite stream-json y cierra.
function fakeClaude(lines, code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => child.emit('close', 143);
    setImmediate(() => {
      for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
      child.stdout.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
}

test('router: infraestructura fuerza solo lectura y edición nunca va a Ollama', () => {
  assert.equal(route({ agent: 'devops', mode: 'edit' }).mode, 'read');
  assert.equal(route({ agent: 'summarizer' }).engine, 'ollama');
  assert.equal(route({ agent: 'summarizer', mode: 'edit' }).engine, 'claude');
  assert.equal(route({ agent: 'backend' }).engine, 'claude');
});

test('registry: rechaza path traversal fuera de htdocs', () => {
  assert.equal(resolveProject('..'), null);
  assert.equal(resolveProject('..\\..\\Windows'), null);
  assert.equal(resolveProject('../'), null);
});

test('db: reinicio marca como fallidas las tareas en curso', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oficina-'));
  const file = join(dir, 't.db');
  try {
    const db = openDb(file);
    const t = db.createTask({ title: 'x', agent: 'backend' });
    db.updateTask(t.id, { status: 'running' });
    db.raw.close();
    const again = openDb(file);
    assert.equal(again.getTask(t.id).status, 'failed');
    assert.match(again.getTask(t.id).error, /reinicio/);
    again.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: tarea Claude pasa queued→running→review con resultado y costo', async () => {
  const db = openDb(':memory:');
  const t = db.createTask({ title: 'hola', agent: 'backend' });
  const runner = createRunner(db, () => {}, {
    spawnFn: fakeClaude([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pensando' }, { type: 'tool_use', name: 'Read', input: { f: 'a' } }] } },
      { type: 'result', is_error: false, result: 'listo', total_cost_usd: 0.012 },
    ]),
  });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  const done = db.getTask(t.id);
  assert.equal(done.result, 'listo');
  assert.equal(done.cost_usd, 0.012);
  assert.deepEqual(db.events(t.id).map((e) => e.kind), ['text', 'tool']);
});

test('runner: error de claude deja la tarea en failed con mensaje', async () => {
  const db = openDb(':memory:');
  const t = db.createTask({ title: 'mal', agent: 'backend' });
  const runner = createRunner(db, () => {}, {
    spawnFn: fakeClaude([{ type: 'result', is_error: true, result: 'sin sesión' }], 1),
  });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'failed');
  assert.equal(db.getTask(t.id).error, 'sin sesión');
});

test('runner: respeta el límite de concurrencia (2 Claude a la vez)', async () => {
  const db = openDb(':memory:');
  const ids = [1, 2, 3].map((n) => db.createTask({ title: `t${n}`, agent: 'backend' }).id);
  let live = 0, peak = 0;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    live++; peak = Math.max(peak, live);
    setTimeout(() => { live--; child.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\n'); child.stdout.end(); child.emit('close', 0); }, 40);
    return child;
  };
  const runner = createRunner(db, () => {}, { spawnFn });
  ids.forEach((id) => runner.enqueue(id));
  await waitFor(() => ids.every((id) => db.getTask(id).status === 'review'));
  assert.equal(peak, 2);
});

test('runner: Ollama acumula el stream y no cuesta', async () => {
  const db = openDb(':memory:');
  const t = db.createTask({ title: 'resume', agent: 'summarizer' });
  const body = (async function* () {
    yield Buffer.from(JSON.stringify({ message: { content: 'Hola ' } }) + '\n');
    yield Buffer.from(JSON.stringify({ message: { content: 'mundo' } }) + '\n');
  })();
  const runner = createRunner(db, () => {}, { fetchFn: async () => ({ ok: true, body }) });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(db.getTask(t.id).result, 'Hola mundo');
  assert.equal(db.getTask(t.id).engine, 'ollama');
});

test('API: valida entrada, bloquea Host/Origin ajenos y limita cambios de estado', async () => {
  const { server } = createApp({ db: openDb(':memory:') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/tasks', { title: '', agent: 'backend' })).status, 400);
    assert.equal((await post('/api/tasks', { title: 'a', agent: 'no-existe' })).status, 400);
    assert.equal((await post('/api/tasks', { title: 'a', agent: 'backend', project: '..' })).status, 400);
    assert.equal((await post('/api/tasks', { title: 'a', agent: 'backend', mode: 'edit' })).status, 400); // edit sin proyecto
    assert.equal((await post('/api/tasks', { title: 'a', agent: 'backend' }, { Origin: 'https://evil.example' })).status, 403);

    const ok = await post('/api/tasks', { title: 'a', agent: 'backend' });
    assert.equal(ok.status, 201);
    const { id } = await ok.json();
    const patch = (b) => fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await patch({ status: 'running' })).status, 400);
    assert.equal((await patch({ status: 'done' })).status, 200);
  } finally { server.close(); server.closeAllConnections?.(); }
});
