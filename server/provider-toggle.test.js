// Activar / desactivar un proveedor en internet sin borrar su clave.
import './test-agents.js'; // primero: fija AGENTS_DIR antes de cargar config.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createApp } from './index.js';
import { knownProviders } from './providers.js';

test('knownProviders: «enabled» exige clave y que no esté apagado', () => {
  const env = { GROQ_API_KEY: 'k'.repeat(12), OPENAI_API_KEY: 'k'.repeat(12) };
  const list = knownProviders(env, ['openai']);
  const by = (n) => list.find((p) => p.name === n);
  assert.deepEqual([by('groq').configured, by('groq').enabled], [true, true]);
  assert.deepEqual([by('openai').configured, by('openai').enabled], [true, false]); // clave guardada pero apagado
  assert.deepEqual([by('gemini').configured, by('gemini').enabled], [false, false]);
});

test('db: la lista de proveedores apagados se guarda y se puede revertir', () => {
  const db = openDb(':memory:');
  assert.deepEqual(db.disabledProviders(), []);
  db.setProviderEnabled('groq', false); db.setProviderEnabled('openrouter', false);
  assert.deepEqual(db.disabledProviders(), ['groq', 'openrouter']);
  db.setProviderEnabled('groq', true);
  assert.deepEqual(db.disabledProviders(), ['openrouter']);
});

test('API: desactivar un proveedor lo quita del selector y de las misiones, conserva la clave y se puede reactivar', async () => {
  process.env.GROQ_API_KEY = 'k'.repeat(12);
  const db = openDb(':memory:');
  const app = createApp({ db });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    let st = (await call('GET', '/api/state')).body;
    assert.ok(st.providers.some((p) => p.name === 'groq'), 'activo al inicio');
    assert.equal((await call('POST', '/api/tasks', { title: 'con groq', agent: 'docs', engine: 'groq' })).status === 400, false);

    const off = await call('PUT', '/api/system/providers/groq/toggle', { enabled: false });
    assert.deepEqual([off.status, off.body.enabled, off.body.configured, off.body.keyHint.startsWith('••••')], [200, false, true, true]);
    st = (await call('GET', '/api/state')).body;
    assert.ok(!st.providers.some((p) => p.name === 'groq'), 'fuera del selector de motores');
    const blocked = await call('POST', '/api/tasks', { title: 'con groq apagado', agent: 'docs', engine: 'groq' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /desactivado/);
    assert.equal(process.env.GROQ_API_KEY, 'k'.repeat(12), 'la clave sigue guardada');
    assert.ok(db.auditLog(10).some((a) => a.action === 'provider.disabled' && a.detail === 'groq'));

    // sigue apagado tras recargar proveedores (p. ej. al cambiar otra clave)
    assert.ok(!(await call('GET', '/api/state')).body.providers.some((p) => p.name === 'groq'));

    const on = await call('PUT', '/api/system/providers/groq/toggle', { enabled: true });
    assert.equal(on.body.enabled, true);
    assert.ok((await call('GET', '/api/state')).body.providers.some((p) => p.name === 'groq'));

    assert.equal((await call('PUT', '/api/system/providers/gemini/toggle', { enabled: true })).status, 400); // sin clave no se puede activar
    assert.equal((await call('PUT', '/api/system/providers/groq/toggle', { enabled: 'si' })).status, 400);
    assert.equal((await call('PUT', '/api/system/providers/fantasma/toggle', { enabled: true })).status, 404);
  } finally { delete process.env.GROQ_API_KEY; app.server.close(); app.server.closeAllConnections?.(); }
});
