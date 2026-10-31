// Activar / desactivar Claude Code y Ollama sin tocar nada más.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createApp } from './index.js';
import { route } from './router.js';

test('route: el modo auto esquiva el motor apagado y bloquea si no hay alternativa', () => {
  assert.equal(route({ agent: 'summarizer' }, ['ollama']).engine, 'claude'); // un agente ligero normalmente iría a Ollama
  assert.equal(route({ agent: 'backend' }, ['claude']).engine, 'ollama'); // solo lectura: Ollama puede
  assert.equal(route({ agent: 'backend' }, ['claude']).blocked, null);
  assert.match(route({ agent: 'backend', mode: 'edit' }, ['claude']).blocked, /Claude Code está desactivado.*editar/);
  assert.match(route({ agent: 'backend' }, ['claude', 'ollama']).blocked, /Claude Code está desactivado/);
  assert.match(route({ agent: 'x', engine: 'ollama' }, ['ollama']).blocked, /Ollama está desactivado/);
  assert.equal(route({ agent: 'backend' }).blocked, null);
});

test('db: los motores apagados se guardan y solo admite claude y ollama', () => {
  const db = openDb(':memory:');
  assert.deepEqual(db.disabledEngines(), []);
  db.setEngineEnabled('ollama', false); db.setEngineEnabled('claude', false);
  assert.deepEqual(db.disabledEngines(), ['claude', 'ollama']);
  db.setEngineEnabled('claude', true);
  assert.deepEqual(db.disabledEngines(), ['ollama']);
});

test('API: apagar Ollama lo quita del selector y de las misiones; reactivarlo lo devuelve', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await call('POST', '/api/tasks', { title: 'a', agent: 'docs', engine: 'ollama' })).status, 201);
    const off = await call('PUT', '/api/system/engines/ollama/toggle', { enabled: false });
    assert.deepEqual([off.status, off.body.enabled], [200, false]);
    const st = (await call('GET', '/api/state')).body;
    assert.deepEqual(st.engines_off, ['ollama']);
    assert.deepEqual(st.stats.off, ['ollama']);
    const blocked = await call('POST', '/api/tasks', { title: 'b', agent: 'docs', engine: 'ollama' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /desactivado/);
    // una misión ya creada con Ollama no arranca mientras esté apagado
    const t = (await call('POST', '/api/tasks', { title: 'c', agent: 'docs', engine: 'auto' })).body;
    db.updateTask(t.id, { engine: 'ollama' });
    const run = await call('POST', `/api/tasks/${t.id}/run`, {});
    assert.notEqual(run.status, 202);
    assert.ok(db.auditLog(10).some((a) => a.action === 'engine.disabled' && a.detail === 'ollama'));
    assert.equal((await call('GET', '/api/system')).body.ollama.enabled, false);

    assert.equal((await call('PUT', '/api/system/engines/ollama/toggle', { enabled: true })).body.enabled, true);
    assert.deepEqual((await call('GET', '/api/state')).body.engines_off, []);
    assert.equal((await call('PUT', '/api/system/engines/ollama/toggle', { enabled: 'si' })).status, 400);
    assert.equal((await call('PUT', '/api/system/engines/groq/toggle', { enabled: false })).status, 404);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});
