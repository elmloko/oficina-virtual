// Medición de modelos de LM Studio (servidor local compatible con OpenAI) y modelo inexistente en otra PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createApp, defaultServerCtl } from './index.js';
import { paramsB, listLmStudio, measureLmStudio, runBenchmark, recommend, THINKING_MAX_TOKENS } from './ollama-models.js';

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

test('measureLmStudio: si el modelo razona y se queda sin tokens, repite con margen; si aun así no responde, lo explica', async () => {
  const m = { name: 'qwen/qwen3-4b', size: 2.2e9 };
  const fakeThinking = (answerWith) => {
    const budgets = [];
    const fetchFn = async (url, opts) => {
      const { max_tokens } = JSON.parse(opts.body);
      budgets.push(max_tokens);
      const content = max_tokens >= answerWith ? GOOD : '';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content, reasoning_content: 'Okay, the user wants…' }, finish_reason: content ? 'stop' : 'length' }], usage: { completion_tokens: max_tokens }, stats: { tokens_per_second: 9.8 } }) };
    };
    return { fetchFn, budgets };
  };
  const ok = fakeThinking(1000);
  const r = await measureLmStudio(m, { url: URL, fetchFn: ok.fetchFn });
  assert.deepEqual([r.ok, r.tps, r.text.startsWith('Las copias')], [true, 9.8, true]);
  assert.deepEqual(ok.budgets, [200, THINKING_MAX_TOKENS]);
  const never = fakeThinking(Infinity);
  const bad = await measureLmStudio(m, { url: URL, fetchFn: never.fetchFn });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /pensando/);
  const plain = fakeLm({ models: MODELS }); // un modelo normal no hace la segunda petición
  await measureLmStudio({ name: 'llama-3.2-3b-instruct', size: 1.65e9 }, { url: URL, fetchFn: plain.fetchFn });
  assert.equal(plain.calls.filter((u) => u.endsWith('/chat/completions')).length, 1);
});

test('API: medir LM Studio; apagado o sin servidor da un error claro', async () => {
  const fake = fakeLm({ models: MODELS });
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: false }) };
  const db = openDb(':memory:');
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const lmsCtl = { sizes: async () => null, unload: async () => {} }; // nunca el `lms` real: no toca los modelos de este equipo
  const app = createApp({ db, probe, providers, lmsCtl, ollamaFetch: fake.fetchFn, freeMem: () => 32e9 }); // RAM fija: el test no depende de la del equipo
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
  const app2 = createApp({ db: openDb(':memory:'), probe, providers: {}, lmsCtl, ollamaFetch: fake.fetchFn });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${app2.server.address().port}/api/system/lmstudio/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /apagado/);
  } finally { app2.server.close(); app2.server.closeAllConnections?.(); }

  // servidor sin responder: error claro
  const app3 = createApp({ db: openDb(':memory:'), probe, providers, lmsCtl, ollamaFetch: fakeLm({ down: true, models: [] }).fetchFn });
  await new Promise((r) => app3.server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${app3.server.address().port}/api/system/lmstudio/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /no responde/);
  } finally { app3.server.close(); app3.server.closeAllConnections?.(); }
});

test('API: medir LM Studio con poca RAM usa el tamaño real, cuenta la RAM de los cargados, los descarga y permite forzar', async () => {
  const GBy = 1e9;
  const models = [
    { id: 'qwen/qwen3-4b', type: 'llm', state: 'loaded' },
    { id: 'prism-ml/bonsai-27b', type: 'llm', state: 'not-loaded' }, // «27b» por nombre serían ~15 GB; en disco ocupa 4,7
    { id: 'qwen/qwen3.8-27b', type: 'llm', state: 'not-loaded' },
  ];
  const unloaded = [];
  const lmsCtl = {
    sizes: async () => new Map([['qwen/qwen3-4b', 2.5 * GBy], ['prism-ml/bonsai-27b', 4.7 * GBy], ['qwen/qwen3.8-27b', 17.7 * GBy]]),
    unload: async (id) => { unloaded.push(id ?? '*'); },
  };
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: false }) };
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const app = createApp({ db: openDb(':memory:'), probe, providers, lmsCtl, ollamaFetch: fakeLm({ models }).fetchFn, freeMem: () => 3 * GBy }); // 3 libres + 2,5 del cargado = 5,5
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const finish = async () => { let v; for (let i = 0; i < 150; i++) { v = (await call('GET', '/api/system/lmstudio/benchmark')).body; if (!v.running) break; await new Promise((r) => setTimeout(r, 20)); } return v; };
  try {
    const start = await call('POST', '/api/system/lmstudio/benchmark', {});
    assert.equal(start.status, 202);
    assert.deepEqual(start.body.skipped.map((s) => s.name), ['qwen/qwen3.8-27b']); // solo el que de verdad no cabe
    const view = await finish();
    assert.deepEqual(view.results.map((r) => [r.name, r.ok, r.size_est]), [['qwen/qwen3-4b', true, false], ['prism-ml/bonsai-27b', true, false]]);
    assert.deepEqual(unloaded, ['*', 'qwen/qwen3-4b', 'prism-ml/bonsai-27b']); // libera todo antes y cada uno al terminar

    const all = await call('POST', '/api/system/lmstudio/benchmark', { force: true });
    assert.deepEqual([all.status, all.body.total], [202, 3]);
    const forced = await finish();
    assert.equal(forced.skipped.length, 0, 'el que estaba omitido ya se midió');
    assert.equal(forced.results.length, 3);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }

  // ninguno cabe: el error lo explica y permite forzar
  const tight = createApp({ db: openDb(':memory:'), probe, providers, lmsCtl, ollamaFetch: fakeLm({ models: models.slice(1) }).fetchFn, freeMem: () => 1 * GBy });
  await new Promise((r) => tight.server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${tight.server.address().port}/api/system/lmstudio/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await r.json();
    assert.deepEqual([r.status, body.can_force], [400, true]);
    assert.match(body.error, /no cabe en la RAM libre/);
  } finally { tight.server.close(); tight.server.closeAllConnections?.(); }
});

test('API: dos clics seguidos en «Medir» lanzan una sola medición; el error de LM Studio trae su motivo', async () => {
  const fake = fakeLm({ models: MODELS });
  const lmsCtl = { sizes: async () => { await new Promise((r) => setTimeout(r, 50)); return null; }, unload: async () => {} }; // preparar tarda, como `lms ls`
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: false }) };
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const app = createApp({ db: openDb(':memory:'), probe, providers, lmsCtl, ollamaFetch: fake.fetchFn, freeMem: () => 32e9 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const start = () => fetch(`${base}/api/system/lmstudio/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status);
  try {
    assert.deepEqual((await Promise.all([start(), start()])).sort(), [202, 409]);
    for (let i = 0; i < 150; i++) { if (!(await (await fetch(`${base}/api/system/lmstudio/benchmark`)).json()).running) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(await start(), 202, 'al terminar se puede volver a medir');
  } finally { app.server.close(); app.server.closeAllConnections?.(); }

  const failing = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Failed to load model: insufficient system resources' } }) });
  const r = await measureLmStudio({ name: 'google/gemma-4-12b-qat', size: 7e9 }, { url: URL, fetchFn: failing });
  assert.equal(r.ok, false);
  assert.match(r.error, /^LM Studio respondió 400: Failed to load model: insufficient system resources$/);

  const slow = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const t = await measureLmStudio({ name: 'prism-ml/bonsai-27b', size: 4.7e9 }, { url: URL, fetchFn: slow });
  assert.match(t.error, /demasiado lento/, 'el tiempo agotado se explica en español');
});

test('API: «Reintentar» mide solo ese modelo, conserva el resto y guarda tras cada modelo', async () => {
  let slow7b = 2; // el de 7B primero va lento (3 tok/s); al reintentarlo ya va bien
  const base = fakeLm({ models: MODELS }).fetchFn;
  const fetchFn = async (url, opts) => {
    const r = await base(url, opts);
    if (!url.endsWith('/api/v0/chat/completions')) return r;
    const j = await r.json();
    if (JSON.parse(opts.body).model.includes('7b')) j.stats.tokens_per_second = slow7b > 0 ? 3 : 8;
    return { ...r, json: async () => j };
  };
  const lmsCtl = { sizes: async () => null, unload: async () => { slow7b--; } };
  const db = openDb(':memory:');
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: false }) };
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const app = createApp({ db, probe, providers, lmsCtl, ollamaFetch: fetchFn, freeMem: () => 32e9 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base2 + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const finish = async () => { let v; for (let i = 0; i < 150; i++) { v = (await call('GET', '/api/system/lmstudio/benchmark')).body; if (!v.running) break; await new Promise((r) => setTimeout(r, 20)); } return v; };
  try {
    await call('POST', '/api/system/lmstudio/benchmark', {});
    const first = await finish();
    assert.equal(first.best, 'llama-3.2-3b-instruct'); // el de 7B va a 3 tok/s
    assert.equal(first.changed_from, null);

    const retry = await call('POST', '/api/system/lmstudio/benchmark', { models: ['qwen2.5-7b-instruct'] });
    assert.deepEqual([retry.status, retry.body.total], [202, 1]);
    const after = await finish();
    assert.deepEqual(after.results.map((r) => r.name).sort(), ['llama-3.2-3b-instruct', 'qwen2.5-7b-instruct'], 'el otro resultado se conserva');
    assert.deepEqual([after.best, after.changed_from], ['qwen2.5-7b-instruct', 'llama-3.2-3b-instruct'], 'ahora el de 7B rinde: es mejor y lo dice');
    assert.equal(db.engineBench('lmstudio').best, 'qwen2.5-7b-instruct', 'queda guardado: las misiones lo usan');

    assert.equal((await call('POST', '/api/system/lmstudio/benchmark', { models: ['no-existe'] })).status, 400);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
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

test('API: encender el servidor de LM Studio y de Ollama desde la oficina', async () => {
  let lmUp = false; let ollamaUp = false;
  const started = [];
  const fetchFn = async (url) => ({ ok: url.includes('1234') ? lmUp : ollamaUp, json: async () => ({ data: [] }) });
  const serverCtl = {
    lmstudio: async (port) => { started.push(['lmstudio', port]); lmUp = true; },
    ollama: async () => { started.push(['ollama']); ollamaUp = true; },
  };
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: false }) };
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const db = openDb(':memory:');
  const app = createApp({ db, probe, providers, ollamaFetch: fetchFn, serverCtl });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const post = async (path) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; };
  try {
    const a = await post('/api/system/lmstudio/server');
    assert.deepEqual([a.status, a.body.already], [200, false]);
    assert.deepEqual(started, [['lmstudio', '1234']]); // el puerto sale de la configuración del proveedor
    const again = await post('/api/system/lmstudio/server');
    assert.deepEqual([again.status, again.body.already], [200, true]); // ya encendido: no lo vuelve a lanzar
    assert.equal(started.length, 1);
    const o = await post('/api/system/ollama/server');
    assert.deepEqual([o.status, o.body.already], [200, false]);
    assert.ok(db.auditLog(10).some((x) => x.action === 'lmstudio.server.start'));
    assert.equal((await post('/api/system/groq/server')).status, 404);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }

  // el programa no existe: error claro; LM Studio apagado en Sistema: error claro
  const app2 = createApp({ db: openDb(':memory:'), probe, providers, ollamaFetch: async () => ({ ok: false }), serverCtl: { lmstudio: async () => { throw new Error('No encontré el programa «lms» de LM Studio'); } } });
  const app3 = createApp({ db: openDb(':memory:'), probe, providers: {}, ollamaFetch: async () => ({ ok: false }), serverCtl });
  for (const a of [app2, app3]) await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  try {
    const r2 = await fetch(`http://127.0.0.1:${app2.server.address().port}/api/system/lmstudio/server`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 400);
    assert.match((await r2.json()).error, /lms/);
    const r3 = await fetch(`http://127.0.0.1:${app3.server.address().port}/api/system/lmstudio/server`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r3.status, 400);
    assert.match((await r3.json()).error, /apagado/);
  } finally { for (const a of [app2, app3]) { a.server.close(); a.server.closeAllConnections?.(); } }
});

test('API: apagar el servidor de LM Studio y de Ollama (con serverCtl simulado)', async () => {
  let lmUp = true; let ollamaUp = true;
  const stopped = [];
  const fetchFn = async (url) => ({ ok: url.includes('1234') ? lmUp : ollamaUp, json: async () => ({ data: [] }) });
  const serverCtl = {
    stop: {
      lmstudio: async () => { stopped.push('lmstudio'); lmUp = false; },
      ollama: async () => { stopped.push('ollama'); ollamaUp = false; },
    },
  };
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: true, models: [], loaded: [] }) };
  const providers = { lmstudio: { name: 'lmstudio', kind: 'openai', baseUrl: URL, key: '', model: 'local-model' } };
  const db = openDb(':memory:');
  const app = createApp({ db, probe, providers, ollamaFetch: fetchFn, serverCtl });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const post = async (path) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; };
  try {
    const a = await post('/api/system/lmstudio/server/stop');
    assert.deepEqual([a.status, a.body.already], [200, false]);
    const again = await post('/api/system/lmstudio/server/stop');
    assert.deepEqual([again.status, again.body.already], [200, true]); // ya apagado: no vuelve a lanzar nada
    const o = await post('/api/system/ollama/server/stop');
    assert.deepEqual([o.status, o.body.already], [200, false]);
    assert.deepEqual(stopped, ['lmstudio', 'ollama']);
    assert.ok(db.auditLog(10).some((x) => x.action === 'ollama.server.stop'));
    assert.equal((await post('/api/system/groq/server/stop')).status, 404);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});

test('el controlador real tiene encender y apagar para Ollama y LM Studio (sin ejecutarlos)', () => {
  for (const e of ['ollama', 'lmstudio']) {
    assert.equal(typeof defaultServerCtl[e], 'function', `encender ${e}`);
    assert.equal(typeof defaultServerCtl.stop?.[e], 'function', `apagar ${e}`);
  }
});

test('API: probar Ollama hace una pregunta mínima al modelo en uso y explica los fallos', async () => {
  const calls = [];
  let reply = { message: { content: 'listo' } };
  const fetchFn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => reply }; };
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: true, models: [{ name: 'gemma3:4b', size: 3.4e9 }, { name: 'bge-m3:latest', size: 1e9 }], loaded: [] }) };
  const db = openDb(':memory:');
  const app = createApp({ db, probe, providers: {}, ollamaFetch: fetchFn });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const post = async (path) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; };
  try {
    const a = await post('/api/system/ollama/test');
    assert.equal(a.status, 200);
    assert.deepEqual([a.body.ok, a.body.model, a.body.text], [true, 'gemma3:4b', 'listo']);
    assert.equal(calls[0].body.keep_alive, 0, 'no deja el modelo cargado en memoria');
    assert.ok(db.auditLog(5).some((x) => x.action === 'ollama.test'));
    db.setEngineModel('ollama', 'llama3.2:3b'); // si elegiste un modelo, prueba ese
    assert.equal((await post('/api/system/ollama/test')).body.model, 'llama3.2:3b');
    reply = { message: { content: '' } }; // un modelo que «piensa» y no responde
    const empty = await post('/api/system/ollama/test');
    assert.equal(empty.body.ok, false);
    assert.match(empty.body.error, /no devolvió texto/);
    db.setEngineEnabled('ollama', false);
    assert.equal((await post('/api/system/ollama/test')).status, 400);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});
