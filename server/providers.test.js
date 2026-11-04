// Pruebas de proveedores en internet: carga por entorno, protocolo OpenAI/Anthropic, aislamiento de claves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-prov-'));
mkdirSync(join(tmp, 'agents'));
for (const a of ['backend', 'summarizer']) writeFileSync(join(tmp, 'agents', `${a}.md`), `---\nname: ${a}\ndescription: "x"\n---\n`);
process.env.AGENTS_DIR = join(tmp, 'agents');
process.env.HTDOCS_ROOT = join(tmp, 'htdocs');
mkdirSync(process.env.HTDOCS_ROOT);

const { loadProviders, publicProviders, secretEnvNames, chat } = await import('./providers.js');
const { openDb } = await import('./db.js');
const { createRunner } = await import('./runner.js');
const { createApp } = await import('./index.js');
const { route } = await import('./router.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = 'sk-SECRETO-1234567890';
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};
const sse = (events) => (async function* () { for (const e of events) yield Buffer.from(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`); })();
const openaiStream = () => sse([
  { choices: [{ delta: { content: 'Hola ' } }] },
  { choices: [{ delta: { content: 'mundo' } }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
  '[DONE]',
]);
const anthropicStream = () => sse([
  { type: 'message_start', message: { usage: { input_tokens: 21 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Buen' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'os días' } },
  { type: 'message_delta', usage: { output_tokens: 5 } },
]);
const fakeFetch = (body, { ok = true, status = 200, text = '' } = {}) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok, status, body: body?.(), text: async () => text }; };
  fn.calls = calls;
  return fn;
};

test('loadProviders: solo se activan los que tienen clave; el modelo se puede cambiar por entorno', () => {
  const p = loadProviders({ OPENAI_API_KEY: SECRET, OPENAI_MODEL: 'gpt-4o', GROQ_API_KEY: '' });
  assert.deepEqual(Object.keys(p), ['openai', 'lmstudio']); // LM Studio es local y no pide clave
  assert.equal(p.openai.model, 'gpt-4o');
  assert.deepEqual(Object.keys(loadProviders({})), ['lmstudio']);
  assert.equal(loadProviders({ OFICINA_ANTHROPIC_API_KEY: 'k' }).anthropic.model, 'claude-haiku-5-5');
  assert.equal(loadProviders({ ANTHROPIC_API_KEY: 'k' }).anthropic, undefined, 'ANTHROPIC_API_KEY no se usa para no activar facturación por API en `claude`');
});

test('loadProviders: proveedores personalizados compatibles con OpenAI y validación', () => {
  const env = { CUSTOM_LLM: 'lmstudio|http://127.0.0.1:1234/v1||qwen2.5;mistral|https://api.mistral.ai/v1/|MISTRAL_KEY|mistral-small;claude|http://x/v1||m;malo|ftp://x||m;sinmodelo|http://x/v1|K|', MISTRAL_KEY: SECRET };
  const p = loadProviders(env);
  assert.deepEqual(Object.keys(p).sort(), ['lmstudio', 'mistral']);
  assert.equal(p.lmstudio.key, '');
  assert.equal(p.lmstudio.model, 'qwen2.5', 'un personalizado reemplaza al integrado del mismo nombre');
  assert.equal(p.mistral.baseUrl, 'https://api.mistral.ai/v1');
  assert.deepEqual(Object.keys(loadProviders({ CUSTOM_LLM: 'mistral|https://a/v1|MISTRAL_KEY|m' })), ['lmstudio'], 'sin clave configurada queda desactivado');
});

test('publicProviders nunca incluye la clave; secretEnvNames lista las variables a ocultar', () => {
  const pub = publicProviders(loadProviders({ OPENAI_API_KEY: SECRET }));
  assert.equal(JSON.stringify(pub).includes(SECRET), false);
  assert.deepEqual(pub.map((p) => p.name), ['openai', 'lmstudio']);
  assert.deepEqual(pub.map((p) => p.local), [false, true], 'LM Studio se marca local (no «en internet»)');
  const names = secretEnvNames({ CUSTOM_LLM: 'mio|http://h/v1|MI_CLAVE|m' });
  for (const n of ['OPENAI_API_KEY', 'OFICINA_ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'MI_CLAVE']) assert.ok(names.includes(n), n);
});

test('chat (OpenAI): URL, autorización, cuerpo, streaming y uso de tokens', async () => {
  const f = fakeFetch(openaiStream);
  const prov = loadProviders({ OPENAI_API_KEY: SECRET }).openai;
  const chunks = [];
  const out = await chat(prov, { system: 'sys', prompt: 'hola', fetchFn: f, onText: (t) => chunks.push(t) });
  assert.equal(out.text, 'Hola mundo');
  assert.deepEqual(chunks, ['Hola ', 'mundo']);
  assert.deepEqual(out.usage, { input: 11, output: 3 });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
});

test('chat (OpenAI): sin clave no envía Authorization (modelos locales tipo LM Studio) y respeta el modelo pedido', async () => {
  const f = fakeFetch(openaiStream);
  const prov = loadProviders({ CUSTOM_LLM: 'lm|http://127.0.0.1:1234/v1||local-model' }).lm;
  await chat(prov, { model: 'otro-modelo', system: 's', prompt: 'p', fetchFn: f });
  assert.equal('Authorization' in f.calls[0].init.headers, false);
  assert.equal(JSON.parse(f.calls[0].init.body).model, 'otro-modelo');
});

test('chat (Anthropic): cabeceras x-api-key y versión, eventos de texto y tokens', async () => {
  const f = fakeFetch(anthropicStream);
  const prov = loadProviders({ OFICINA_ANTHROPIC_API_KEY: SECRET }).anthropic;
  const out = await chat(prov, { system: 'sys', prompt: 'hola', fetchFn: f });
  assert.equal(out.text, 'Buenos días');
  assert.deepEqual(out.usage, { input: 21, output: 5 });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], SECRET);
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(init.body);
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hola' }]);
  assert.ok(body.max_tokens > 0);
});

test('chat: errores HTTP muestran el motivo del proveedor pero jamás la clave', async () => {
  const prov = loadProviders({ OPENAI_API_KEY: SECRET }).openai;
  const f = fakeFetch(null, { ok: false, status: 401, text: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) });
  await assert.rejects(chat(prov, { system: 's', prompt: 'p', fetchFn: f }), (e) => /openai respondió 401: Incorrect API key/.test(e.message) && !e.message.includes(SECRET));
  const empty = fakeFetch(() => sse([]));
  await assert.rejects(chat(prov, { system: 's', prompt: 'p', fetchFn: empty }), /no devolvió texto/);
  const err = fakeFetch(() => sse([{ type: 'error', error: { message: 'overloaded' } }]));
  await assert.rejects(chat(loadProviders({ OFICINA_ANTHROPIC_API_KEY: SECRET }).anthropic, { system: 's', prompt: 'p', fetchFn: err }), /overloaded/);
});

test('router: los proveedores también editan (con las herramientas de la oficina)', () => {
  assert.equal(route({ agent: 'backend', engine: 'openai', mode: 'read' }).engine, 'openai');
  const r = route({ agent: 'backend', engine: 'openai', mode: 'edit' });
  assert.equal(r.engine, 'openai');
  assert.equal(r.mode, 'edit');
});

test('runner: una tarea con proveedor llega a revisión, registra tokens y no filtra la clave', async () => {
  const db = openDb(':memory:');
  const providers = loadProviders({ OPENAI_API_KEY: SECRET });
  const f = fakeFetch(openaiStream);
  const runner = createRunner(db, () => {}, { providers, fetchFn: f });
  const t = db.createTask({ title: 'Resume esto', agent: 'summarizer', engine: 'openai', model: 'gpt-4o' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  const done = db.getTask(t.id);
  assert.equal(done.result, 'Hola mundo');
  assert.equal(done.engine, 'openai');
  assert.equal(JSON.parse(f.calls[0].init.body).model, 'gpt-4o');
  const events = db.events(t.id).map((e) => e.text).join('\n');
  assert.match(events, /openai\/gpt-4o: 11 tokens de entrada, 3 de salida/);
  assert.equal(events.includes(SECRET) || JSON.stringify(done).includes(SECRET), false);
});

test('runner: proveedor sin configurar o con error HTTP deja la tarea fallida', async () => {
  const db = openDb(':memory:');
  const a = db.createTask({ title: 'x', agent: 'summarizer', engine: 'gemini' });
  createRunner(db, () => {}, { providers: {} }).enqueue(a.id);
  await waitFor(() => db.getTask(a.id).status === 'failed');
  assert.match(db.getTask(a.id).error, /no está activo/);

  const b = db.createTask({ title: 'y', agent: 'summarizer', engine: 'openai' });
  const providers = loadProviders({ OPENAI_API_KEY: SECRET });
  const bad = fakeFetch(null, { ok: false, status: 429, text: JSON.stringify({ error: { message: 'Rate limit' } }) });
  createRunner(db, () => {}, { providers, fetchFn: bad }).enqueue(b.id);
  await waitFor(() => db.getTask(b.id).status === 'failed');
  assert.match(db.getTask(b.id).error, /429.*Rate limit/);
});

test('runner: el proceso claude no hereda claves de proveedores', async () => {
  const saved = { a: process.env.OPENAI_API_KEY, b: process.env.OFICINA_ANTHROPIC_API_KEY };
  process.env.OPENAI_API_KEY = SECRET; process.env.OFICINA_ANTHROPIC_API_KEY = SECRET;
  try {
    const db = openDb(':memory:');
    let seen;
    const spawnFn = (cmd, args, opts) => {
      seen = opts.env;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => {};
      setImmediate(() => { child.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\n'); child.stdout.end(); child.emit('close', 0); });
      return child;
    };
    const t = db.createTask({ title: 'x', agent: 'backend' });
    createRunner(db, () => {}, { spawnFn }).enqueue(t.id);
    await waitFor(() => db.getTask(t.id).status === 'review');
    assert.ok(seen && seen.PATH !== undefined || seen.Path !== undefined, 'conserva el resto del entorno');
    assert.equal(seen.OPENAI_API_KEY, undefined);
    assert.equal(seen.OFICINA_ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, SECRET, 'el entorno propio no se modifica');
  } finally {
    for (const [k, v] of [['OPENAI_API_KEY', saved.a], ['OFICINA_ANTHROPIC_API_KEY', saved.b]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('API: acepta motores configurados, rechaza desconocidos y modelos raros, y no filtra claves', async () => {
  const providers = loadProviders({ OPENAI_API_KEY: SECRET });
  const f = fakeFetch(openaiStream);
  const { server, db } = createApp({ db: openDb(':memory:'), providers, runnerOpts: { fetchFn: f } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };
  try {
    assert.equal((await call('POST', '/api/tasks', { title: 'a', agent: 'summarizer', engine: 'gemini' })).status, 400);
    assert.equal((await call('POST', '/api/tasks', { title: 'a', agent: 'summarizer', engine: 'openai', model: 'mal modelo; rm -rf' })).status, 400);
    const ok = await call('POST', '/api/tasks', { title: 'a', agent: 'summarizer', engine: 'openai', model: 'gpt-4o-mini' });
    assert.equal(ok.status, 201);
    const id = JSON.parse(ok.text).id;
    assert.equal((await call('POST', `/api/tasks/${id}/run`, {})).status, 202);
    await waitFor(() => db.getTask(id).status === 'review');
    const state = await call('GET', '/api/state');
    assert.equal(state.text.includes(SECRET), false, 'la clave no debe salir al navegador');
    assert.deepEqual(JSON.parse(state.text).providers.map((p) => p.name), ['openai', 'lmstudio']);
    assert.equal((await call('GET', `/api/tasks/${id}/events`)).text.includes(SECRET), false);
  } finally { server.close(); server.closeAllConnections?.(); }
});
