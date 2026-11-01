// Medición de modelos de LM Studio (servidor local compatible con OpenAI) y modelo inexistente en otra PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createApp } from './index.js';
import { paramsB, listLmStudio, measureLmStudio, runBenchmark, recommend } from './ollama-models.js';

const URL = 'http://127.0.0.1:1234/v1';
const GOOD = 'Las copias de seguridad protegen tus datos frente a fallos. Permiten recuperarlos si algo sale mal.';

/** LM Studio falso con API nativa (/api/v0) y opcionalmente sin ella (versiones viejas). */
function fakeLm({ native = true, models, stats = true, down = false } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push(url);
    if (down) throw new Error('ECONNREFUSED');
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
    if (url.endsWith('/api/v0/models')) return native ? json({ data: models }) : json({}, 404);
    if (url.endsWith('/v1/models')) return json({ data: models.map((m) => ({ id: m.id })) });
    if (url.endsWith('/api/v0/chat/completions')) {
      if (!native) return json({}, 404);
      const { model } = JSON.parse(opts.body);
      return json({ choices: [{ message: { content: GOOD } }], usage: { completion_tokens: 50 }, ...(stats ? { stats: { tokens_per_second: model.includes('7b') ? 3 : 9 } } : {}) });
    }
    if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { content: GOOD } }], usage: { completion_tokens: 50 } });
    return json({}, 404);
  };
  return { fetchFn, calls };
}
const MODELS = [
  { id: 'qwen2.5-7b-instruct', type: 'llm', state: 'not-loaded' },
  { id: 'llama-3.2-3b-instruct', type: 'llm', state: 'loaded' },
  { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', state: 'not-loaded' },
];

test('paramsB: estima los parámetros por el nombre', () => {
  assert.equal(paramsB('qwen2.5-7b-instruct'), 7);
  assert.equal(paramsB('llama-3.2-3b-instruct'), 3);
  assert.equal(paramsB('gemma-3-4B-it'), 4);
  assert.equal(paramsB('phi-4-mini'), 0);
  assert.equal(paramsB('modelo-bueno'), 0); // «b» dentro de una palabra no cuenta
});

test('listLmStudio: sin embeddings, con estado; cae a /v1/models si no hay API nativa; sin servidor lanza error', async () => {
  const a = await listLmStudio({ url: URL, fetchFn: fakeLm({ models: MODELS }).fetchFn });
  assert.deepEqual(a.map((m) => [m.name, m.state]), [['qwen2.5-7b-instruct', 'not-loaded'], ['llama-3.2-3b-instruct', 'loaded']]);
  assert.equal(a[0].size_est, true);
  const old = await listLmStudio({ url: URL, fetchFn: fakeLm({ native: false, models: MODELS }).fetchFn });
  assert.deepEqual(old.map((m) => m.name), ['qwen2.5-7b-instruct', 'llama-3.2-3b-instruct']);
  await assert.rejects(listLmStudio({ url: URL, fetchFn: fakeLm({ down: true, models: [] }).fetchFn }));
});

test('measureLmStudio: usa tokens/s nativos; sin ellos mide el reloj y lo marca como aproximado', async () => {
  const m = { name: 'llama-3.2-3b-instruct', size: 1.65e9 };
  const native = await measureLmStudio(m, { url: URL, fetchFn: fakeLm({ models: MODELS }).fetchFn });
  assert.deepEqual([native.ok, native.tps, native.approx], [true, 9, false]);
  const approx = await measureLmStudio(m, { url: URL, fetchFn: fakeLm({ models: MODELS, stats: false }).fetchFn });
  assert.equal(approx.ok, true);
  assert.equal(approx.approx, true);
  const old = await measureLmStudio(m, { url: URL, fetchFn: fakeLm({ native: false, models: MODELS }).fetchFn }); // sin /api/v0: usa /v1
  assert.equal(old.ok, true);
  const down = await measureLmStudio(m, { url: URL, fetchFn: fakeLm({ down: true, models: [] }).fetchFn });
  assert.deepEqual([down.ok, /ECONNREFUSED/.test(down.error)], [false, true]);
  const results = await runBenchmark([{ name: 'qwen2.5-7b-instruct', size: 3.85e9 }, m], { url: URL, fetchFn: fakeLm({ models: MODELS }).fetchFn, measureFn: measureLmStudio });
  assert.deepEqual(results.map((r) => r.tps), [3, 9]);
  assert.equal(recommend(results), 'llama-3.2-3b-instruct'); // el de 7B va a 3 tok/s: por debajo de lo usable
});

test('API: medir LM Studio; apagado o sin servidor da un error claro', async () => {
  const fake = fakeLm({ models: MODELS });
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: false }) };
  const db = openDb(':memory:');
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const app = createApp({ db, probe, providers, ollamaFetch: fake.fetchFn });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const start = await call('POST', '/api/system/lmstudio/benchmark', {});
    assert.equal(start.status, 202);
    assert.equal(start.body.engine, 'lmstudio');
    assert.equal(start.body.total, 2);
    let view;
    for (let i = 0; i < 150; i++) { view = (await call('GET', '/api/system/lmstudio/benchmark')).body; if (!view.running) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(view.best, 'llama-3.2-3b-instruct');
    assert.equal(db.engineBench('lmstudio').best, 'llama-3.2-3b-instruct');
    assert.equal(db.engineBench('ollama'), null); // cada motor guarda lo suyo
    assert.ok(db.auditLog(10).some((a) => a.action === 'lmstudio.benchmark'));
  } finally { app.server.close(); app.server.closeAllConnections?.(); }

  // sin proveedor activo (apagado): error claro
  const app2 = createApp({ db: openDb(':memory:'), probe, providers: {}, ollamaFetch: fake.fetchFn });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${app2.server.address().port}/api/system/lmstudio/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /apagado/);
  } finally { app2.server.close(); app2.server.closeAllConnections?.(); }

  // servidor sin responder: error claro
  const app3 = createApp({ db: openDb(':memory:'), probe, providers, ollamaFetch: fakeLm({ down: true, models: [] }).fetchFn });
  await new Promise((r) => app3.server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${app3.server.address().port}/api/system/lmstudio/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /no responde/);
  } finally { app3.server.close(); app3.server.closeAllConnections?.(); }
});

test('misión con LM Studio: si el modelo elegido no existe en esta PC, usa el recomendado o el cargado y lo avisa', async () => {
  const db = openDb(':memory:');
  db.setEngineModel('lmstudio', 'modelo-de-otra-pc');
  const sent = [];
  const fake = fakeLm({ models: MODELS });
  const fetchFn = async (url, opts) => {
    if (url.endsWith('/chat/completions') && !url.includes('/api/v0/')) {
      sent.push(JSON.parse(opts.body).model);
      const enc = new TextEncoder();
      return { ok: true, body: (async function* () { yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: GOOD } }] })}\n\ndata: [DONE]\n`); })() };
    }
    return fake.fetchFn(url, opts);
  };
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const registry = { listAgents: () => [{ name: 'summarizer', description: 's' }], listProjects: () => [] };
  const runner = createRunner(db, () => {}, { fetchFn, registry, providers });
  const t = db.createTask({ title: 'resumir', agent: 'summarizer', engine: 'lmstudio' });
  runner.enqueue(t.id);
  const end = Date.now() + 3000;
  while (db.getTask(t.id).status !== 'review' && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.equal(db.getTask(t.id).status, 'review');
  assert.deepEqual(sent, ['llama-3.2-3b-instruct']); // el que ya estaba cargado
  assert.match(db.events(t.id).map((e) => e.text).join('\n'), /«modelo-de-otra-pc» no está en LM Studio.*«llama-3.2-3b-instruct»/);
});
