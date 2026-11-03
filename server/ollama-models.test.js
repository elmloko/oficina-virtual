// Modelos de Ollama en OTRA computadora: predeterminado que sí existe, medición y recomendación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createApp } from './index.js';
import { pickDefault, benchCandidates, recommend, runBenchmark, hasModel } from './ollama-models.js';

const GB = 1e9;
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

test('pickDefault: medición > preferido instalado > el más pequeño; ignora embeddings', () => {
  const pc2 = [{ name: 'llama3.2:3b', size: 2 * GB }, { name: 'nomic-embed-text:latest', size: 0.3 * GB }, { name: 'qwen2.5:7b', size: 4.7 * GB }];
  assert.equal(pickDefault(pc2), 'llama3.2:3b'); // no está gemma3:4b → el siguiente preferido
  assert.equal(pickDefault(pc2, { best: 'qwen2.5:7b' }), 'qwen2.5:7b'); // la medición manda
  assert.equal(pickDefault(pc2, { best: 'no-existe:1b' }), 'llama3.2:3b'); // medición de otra PC que aquí no existe
  assert.equal(pickDefault([{ name: 'raro:7b', size: 5 * GB }, { name: 'raro:1b', size: GB }]), 'raro:1b'); // sin preferidos: el más liviano
  assert.equal(pickDefault([{ name: 'bge-m3:latest', size: GB }]), null);
  assert.equal(pickDefault([]), null);
  assert.equal(hasModel([{ name: 'gemma3:4b' }], 'gemma3:4b'), true);
  assert.equal(hasModel([{ name: 'tinyllama:latest' }], 'tinyllama'), true);
});

test('benchCandidates: salta especializados y los que no caben en la RAM libre', () => {
  const models = [{ name: 'gemma3:4b', size: 3.4 * GB }, { name: 'qwen2.5-coder:7b', size: 4.7 * GB }, { name: 'qwen3:8b', size: 5.2 * GB }, { name: 'deepseek-r1:8b', size: 5.2 * GB }, { name: 'bge-m3', size: GB }];
  const { candidates, skipped } = benchCandidates(models, 5);
  assert.deepEqual(candidates.map((m) => m.name), ['gemma3:4b']);
  assert.deepEqual(skipped.map((s) => s.name).sort(), ['deepseek-r1:8b', 'qwen2.5-coder:7b', 'qwen3:8b']);
  // uno ya cargado en memoria (LM Studio informa `state`) se mide aunque quede poca RAM libre
  const lm = benchCandidates([{ name: 'qwen/qwen3-4b', size: 2.2 * GB, state: 'loaded' }, { name: 'nvidia/nemotron-3-nano-4b', size: 2.2 * GB, state: 'not-loaded' }], 1.2);
  assert.deepEqual(lm.candidates.map((m) => m.name), ['qwen/qwen3-4b']);
  assert.deepEqual(lm.skipped.map((s) => s.name), ['nvidia/nemotron-3-nano-4b']);
  assert.ok(skipped.find((s) => s.name === 'qwen3:8b').reason.includes('RAM'));
});

test('recommend: el más grande entre los que van a velocidad usable; si ninguno, el más rápido', () => {
  const r = (name, size, tps, ok = true) => ({ name, size: size * GB, tps, ok });
  assert.equal(recommend([r('chico', 1, 20), r('medio', 3.4, 8), r('grande', 5.2, 2.5)]), 'medio');
  assert.equal(recommend([r('a', 3, 2), r('b', 5, 1.5)]), 'a'); // PC lenta: el más rápido
  assert.equal(recommend([r('roto', 3, 10, false)]), null);
  assert.equal(recommend([r('qwen2.5-coder:3b', 2, 50), r('llama3.2:3b', 2, 6)]), 'llama3.2:3b'); // un modelo de código no es para el día a día
});

/** Ollama falso: /api/chat devuelve métricas según el modelo. */
const fakeOllama = (table) => async (url, opts) => {
  const body = JSON.parse(opts.body);
  const t = table[body.model];
  await new Promise((r) => setTimeout(r, 40));
  if (t?.fail) return { ok: false, status: 500, json: async () => ({}) };
  const text = t.text ?? 'Las copias de seguridad protegen tus datos frente a fallos. Permiten recuperarlos si algo sale mal.';
  return { ok: true, json: async () => ({ message: { content: text, thinking: t.think }, eval_count: 100, eval_duration: (100 / t.tps) * 1e9, total_duration: 5e9, load_duration: 1e9 }) };
};

test('runBenchmark: tokens por segundo, descarga el modelo después y marca fallos', async () => {
  const sent = [];
  const base = fakeOllama({ 'a:3b': { tps: 8 }, 'b:4b': { text: '', think: 'hmm', tps: 3 }, 'c:1b': { fail: true, tps: 1 } });
  const fetchFn = async (u, o) => { sent.push(JSON.parse(o.body)); return base(u, o); };
  const progress = [];
  const results = await runBenchmark([{ name: 'a:3b', size: 2 * GB }, { name: 'b:4b', size: 3 * GB }, { name: 'c:1b', size: GB }], { url: 'http://x', fetchFn, onProgress: (rs, cur) => progress.push([rs.length, cur]) });
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [['a:3b', true], ['b:4b', false], ['c:1b', false]]);
  assert.equal(results[0].tps, 8);
  assert.match(results[1].error, /pensando/);
  assert.match(results[2].error, /500/);
  assert.ok(sent.every((b) => b.keep_alive === 0 && b.stream === false), 'cada modelo se descarga al terminar');
  assert.deepEqual(progress.at(-1), [3, null]);
  assert.deepEqual(progress[0], [0, 'a:3b']);
  const abort = new AbortController(); abort.abort();
  assert.equal((await runBenchmark([{ name: 'a:3b', size: GB }], { url: 'x', fetchFn, signal: abort.signal })).length, 0); // cancelado: no mide
});

test('misión con Ollama cuando el modelo pedido no está instalado: usa el mejor instalado y lo avisa', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const fetchFn = async (url, opts) => {
    if (url.endsWith('/api/tags')) return { json: async () => ({ models: [{ name: 'llama3.2:3b', size: 2 * GB }, { name: 'nomic-embed-text:latest', size: 3e8 }] }) };
    calls.push(JSON.parse(opts.body).model);
    const enc = new TextEncoder();
    return { ok: true, body: (async function* () { yield enc.encode(`${JSON.stringify({ message: { content: 'listo' } })}\n`); })() };
  };
  const registry = { listAgents: () => [{ name: 'summarizer', description: 's' }], listProjects: () => [] };
  const runner = createRunner(db, () => {}, { fetchFn, registry });
  const t = db.createTask({ title: 'resumir', agent: 'summarizer', engine: 'ollama' });
  runner.enqueue(t.id); // el router pide gemma3:4b, que en esta PC no existe
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.deepEqual(calls, ['llama3.2:3b']);
  assert.equal(db.getTask(t.id).used_model, 'llama3.2:3b');
  assert.match(db.events(t.id).map((e) => e.text).join('\n'), /«gemma3:4b» no está instalado.*«llama3.2:3b»/);
});

test('misión con Ollama sin ningún modelo de chat: error claro', async () => {
  const db = openDb(':memory:');
  const fetchFn = async () => ({ json: async () => ({ models: [{ name: 'bge-m3:latest', size: GB }] }), ok: true, body: null });
  const registry = { listAgents: () => [{ name: 'summarizer', description: 's' }], listProjects: () => [] };
  const runner = createRunner(db, () => {}, { fetchFn, registry });
  const t = db.createTask({ title: 'x', agent: 'summarizer', engine: 'ollama' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'failed');
  assert.match(db.getTask(t.id).error, /no tiene modelos de chat instalados.*ollama pull/);
});

test('API: medir, ver resultado y recomendación, guardarlo, y no medir si Ollama está ocupado', async () => {
  const db = openDb(':memory:');
  const models = [{ name: 'gemma3:4b', size: 3.4 * GB }, { name: 'llama3.2:3b', size: 2 * GB }, { name: 'qwen2.5-coder:7b', size: 4.7 * GB }];
  const probe = { claude: async () => ({ ok: true }), codex: async () => ({ ok: true }), ollama: async () => ({ ok: true, models, loaded: [] }) };
  const app = createApp({ db, probe, ollamaFetch: fakeOllama({ 'gemma3:4b': { tps: 6 }, 'llama3.2:3b': { tps: 9 } }), freeMem: () => 32e9 }); // RAM fija: el test no depende de la del equipo
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await call('GET', '/api/system/ollama/benchmark')).body.results.length, 0);
    const start = await call('POST', '/api/system/ollama/benchmark', {});
    assert.equal(start.status, 202);
    assert.equal(start.body.running, true);
    assert.equal(start.body.total, 2); // el de código se salta
    assert.equal((await call('POST', '/api/system/ollama/benchmark', {})).status, 409); // ya hay una en curso
    let view;
    for (let i = 0; i < 150; i++) { view = (await call('GET', '/api/system/ollama/benchmark')).body; if (!view.running) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(view.running, false);
    assert.deepEqual(view.results.map((r) => r.name), ['gemma3:4b', 'llama3.2:3b']);
    assert.equal(view.best, 'gemma3:4b'); // el más grande que va a 4 tok/s o más
    assert.ok(view.skipped.some((s) => s.name === 'qwen2.5-coder:7b'));
    assert.equal(db.ollamaBench().best, 'gemma3:4b'); // queda guardado
    const m = (await call('GET', '/api/models')).body;
    assert.equal(m.defaults.ollama, 'gemma3:4b');
    assert.equal(m.ollama.find((x) => x.value === 'gemma3:4b').recommended, true);
    assert.ok(db.auditLog(10).some((a) => a.action === 'ollama.benchmark'));
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});

test('misión con Ollama apagado: el error dice cómo encenderlo (no «fetch failed»)', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.endsWith('/api/tags')) return { json: async () => ({ models: [{ name: 'gemma3:4b', size: 3 * GB }] }) };
    throw new TypeError('fetch failed'); // servidor apagado: la conexión se rechaza
  };
  const registry = { listAgents: () => [{ name: 'summarizer', description: 's' }], listProjects: () => [] };
  const runner = createRunner(db, () => {}, { fetchFn, registry });
  const t = db.createTask({ title: 'x', agent: 'summarizer', engine: 'ollama' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'failed');
  assert.match(db.getTask(t.id).error, /Ollama no responde.*Encender servidor/);
});
