// Bot de Telegram con Telegram simulado (no se puede probar contra el servicio real sin un token) y la API real en memoria.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-tg-'));
mkdirSync(join(tmp, 'agents')); mkdirSync(join(tmp, 'htdocs', 'proj'), { recursive: true });
writeFileSync(join(tmp, 'htdocs', 'proj', 'composer.json'), '{}');
for (const a of ['reviewer', 'backend']) writeFileSync(join(tmp, 'agents', `${a}.md`), `---\nname: ${a}\ndescription: "${a}"\n---\ncuerpo\n`);
process.env.HTDOCS_ROOT = join(tmp, 'htdocs');
process.env.AGENTS_DIR = join(tmp, 'agents');

const { openDb } = await import('./db.js');
const { createApp } = await import('./index.js');
const { createTelegramBot, parseAllowed, telegramFromEnv, HELP } = await import('./telegram.js');

after(() => rmSync(tmp, { recursive: true, force: true }));
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout esperando condición');
};

const TOKEN = '123456:SECRET-TOKEN';

/** Telegram falso: guarda los mensajes enviados y entrega las actualizaciones que se le encolen. */
function fakeTelegram() {
  const sent = []; const queue = []; const calls = [];
  const fetchFn = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (method === 'sendMessage') { sent.push(body); return Response.json({ ok: true, result: {} }); }
    if (method === 'getUpdates') { await new Promise((r) => setTimeout(r, 5)); return Response.json({ ok: true, result: queue.splice(0) }); }
    return Response.json({ ok: false, description: 'método desconocido' }, { status: 404 });
  };
  const msg = (text, chatId = 42, type = 'private') => ({ update_id: calls.length + 1, message: { text, chat: { id: chatId, type } } });
  return { fetchFn, sent, queue, calls, msg };
}

// ---------- configuración ----------
test('parseAllowed: solo ids numéricos; telegramFromEnv no arranca sin token ni sin chats autorizados', () => {
  assert.deepEqual([...parseAllowed('123, 456;-789 abc 1x')], ['123', '456', '-789']);
  assert.equal(parseAllowed(undefined).size, 0);
  const warns = [];
  const logger = { warn: (m) => warns.push(m), info() {}, error() {} };
  assert.equal(telegramFromEnv({ env: {}, api: () => {}, logger }), null);
  assert.equal(telegramFromEnv({ env: { TELEGRAM_BOT_TOKEN: TOKEN }, api: () => {}, logger }), null); // sin lista: apagado
  assert.match(warns[0], /TELEGRAM_ALLOWED_CHATS está vacío/);
  assert.ok(telegramFromEnv({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_CHATS: '42' }, api: () => {}, logger }));
});

// ---------- seguridad ----------
test('ignora a desconocidos, grupos y mensajes sin texto; solo el log del servidor ve el id', async () => {
  const tg = fakeTelegram();
  const warns = [];
  let apiCalls = 0;
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api: async () => { apiCalls++; return { status: 200, body: {} }; }, fetchFn: tg.fetchFn, logger: { warn: (m) => warns.push(m), info() {}, error() {} } });
  assert.equal(await bot.handleUpdate(tg.msg('/estado', 999)), null);
  assert.equal(await bot.handleUpdate(tg.msg('/estado', 42, 'group')), null); // aunque el id coincida, solo chats privados
  assert.equal(await bot.handleUpdate({ update_id: 1, message: { chat: { id: 42, type: 'private' } } }), null);
  assert.equal(await bot.handleUpdate({ update_id: 2, edited_message: { text: '/estado', chat: { id: 42, type: 'private' } } }), null);
  assert.equal(tg.sent.length, 0, 'a un desconocido no se le responde nada');
  assert.equal(apiCalls, 0);
  assert.match(warns[0], /id 999/);
});

// ---------- comandos con una API simulada ----------
function fakeApi(handlers) {
  const log = [];
  const api = async (method, path, body) => { log.push({ method, path, body }); const h = handlers[`${method} ${path}`] ?? handlers.default; return h ? h(body) : { status: 404, body: { error: 'No existe' } }; };
  return { api, log };
}
const state = (tasks, extra = {}) => ({ status: 200, body: { tasks, stats: { active: { claude: 1, ollama: 0 }, limit: { claude: 2, ollama: 1 }, waiting: 3, paused: false }, costs: { today: 1.234, daily_budget_usd: 5 }, ...extra } });
const T = (id, o = {}) => ({ id, title: `t${id}`, agent: 'reviewer', status: 'review', kind: 'task', result: 'ok', error: null, cost_usd: 0, finished_at: 'x', ...o });

test('/ayuda, texto libre, /estado y /pendientes', async () => {
  const tg = fakeTelegram();
  const { api } = fakeApi({ 'GET /api/state': () => state([T(1), T(2, { result: '¿Cuál tenant uso?' }), T(3, { status: 'failed' }), T(4, { status: 'done' })]) });
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api, fetchFn: tg.fetchFn });
  assert.equal(await bot.handleUpdate(tg.msg('/ayuda')), HELP);
  assert.match(await bot.handleUpdate(tg.msg('hola')), /No entendí/);
  assert.match(await bot.handleUpdate(tg.msg('/ayuda@MiBot')), /Comandos/); // formato de los grupos/menú
  const estado = await bot.handleUpdate(tg.msg('/estado'));
  assert.match(estado, /Claude 1\/2 · Ollama 0\/1 · 3 en espera/);
  assert.match(estado, /Hoy: \$1\.23 de \$5/);
  assert.match(estado, /3 misión\(es\) esperan/);
  const pend = await bot.handleUpdate(tg.msg('/pendientes'));
  assert.ok(pend.indexOf('#2') < pend.indexOf('#3') && pend.indexOf('#3') < pend.indexOf('#1'), 'pregunta, luego fallida, luego por revisar');
  assert.doesNotMatch(pend, /#4/);
  assert.equal(tg.sent.at(-1).chat_id, 42);
  assert.equal(tg.sent.at(-1).parse_mode, undefined, 'texto plano: el contenido de las misiones nunca se interpreta');
});

test('/nueva crea una misión de SOLO LECTURA y la lanza; valida el formato y limita el ritmo', async () => {
  const tg = fakeTelegram();
  let id = 10; let t0 = 1_000_000;
  const { api, log } = fakeApi({
    'POST /api/tasks': () => ({ status: 201, body: { id: ++id } }),
    default: () => ({ status: 202, body: {} }),
  });
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api, fetchFn: tg.fetchFn, now: () => t0 });
  assert.match(await bot.handleUpdate(tg.msg('/nueva solo texto')), /Uso:/);
  const r = await bot.handleUpdate(tg.msg('/nueva reviewer @proj: revisar guías'));
  assert.match(r, /Misión #11 lanzada/);
  assert.deepEqual(log[0], { method: 'POST', path: '/api/tasks', body: { title: 'revisar guías', description: '', agent: 'reviewer', project: 'proj', mode: 'read', engine: 'auto' } });
  assert.deepEqual(log[1], { method: 'POST', path: '/api/tasks/11/run', body: {} }); // sin confirm:true, jamás
  await bot.handleUpdate(tg.msg('/nueva backend: sin proyecto'));
  assert.equal(log.at(-2).body.project, '');
  for (let i = 0; i < 3; i++) await bot.handleUpdate(tg.msg(`/nueva reviewer: n${i}`));
  assert.match(await bot.handleUpdate(tg.msg('/nueva reviewer: demasiadas')), /Límite alcanzado/);
  t0 += 11 * 60_000; // pasada la ventana vuelve a funcionar
  assert.match(await bot.handleUpdate(tg.msg('/nueva reviewer: ahora sí')), /lanzada/);
});

test('/nueva muestra los errores de la API (agente desconocido, proyecto inválido)', async () => {
  const tg = fakeTelegram();
  const { api } = fakeApi({ 'POST /api/tasks': () => ({ status: 400, body: { error: 'Agente desconocido' } }) });
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api, fetchFn: tg.fetchFn });
  assert.equal(await bot.handleUpdate(tg.msg('/nueva fantasma: x')), '✖ Agente desconocido');
});

test('/ver, /responder, /aprobar y /cancelar; responder a una misión que edita pide confirmar en la oficina', async () => {
  const tg = fakeTelegram();
  const long = 'x'.repeat(6000);
  const { api, log } = fakeApi({
    'GET /api/state': () => state([T(5, { result: long, cost_usd: 0.5 }), T(6, { status: 'failed', error: 'boom', result: null })]),
    'POST /api/tasks/5/reply': () => ({ status: 202, body: {} }),
    'POST /api/tasks/6/reply': () => ({ status: 409, body: { needsConfirm: true, error: 'x' } }),
    'PATCH /api/tasks/5': () => ({ status: 200, body: {} }),
    'POST /api/tasks/5/cancel': () => ({ status: 200, body: {} }),
    'PATCH /api/tasks/9': () => ({ status: 400, body: { error: 'Cambio de estado no permitido' } }),
  });
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api, fetchFn: tg.fetchFn });
  await bot.handleUpdate(tg.msg('/ver #5'));
  assert.ok(tg.sent.at(-1).text.length < 4096, 'cabe en un mensaje de Telegram');
  assert.match(tg.sent.at(-1).text, /recortado/);
  assert.match(await bot.handleUpdate(tg.msg('/ver 6')), /Error: boom[\s\S]*sin resultado/);
  assert.match(await bot.handleUpdate(tg.msg('/ver 99')), /No existe/);
  assert.match(await bot.handleUpdate(tg.msg('/ver')), /Uso/);
  assert.match(await bot.handleUpdate(tg.msg('/responder 5 sí, el tenant 7')), /Respuesta enviada/);
  assert.deepEqual(log.find((l) => l.path === '/api/tasks/5/reply').body, { text: 'sí, el tenant 7' }); // nunca confirm:true
  assert.match(await bot.handleUpdate(tg.msg('/responder 6 hola')), /confirmarlo en la oficina/);
  assert.match(await bot.handleUpdate(tg.msg('/responder 5')), /Uso/);
  assert.match(await bot.handleUpdate(tg.msg('/aprobar 5')), /completada/);
  assert.equal(await bot.handleUpdate(tg.msg('/aprobar 9')), '✖ Cambio de estado no permitido');
  assert.match(await bot.handleUpdate(tg.msg('/cancelar 5')), /cancelada/);
  assert.equal(log.some((l) => /apply|discard/.test(l.path)), false, 'desde Telegram no se aplican ni descartan cambios');
});

// ---------- avisos ----------
test('avisos: solo al cambiar de estado, sin repetir, preguntas con su texto y sin filtrar resultados largos', async () => {
  const tg = fakeTelegram();
  let tasks = [T(1, { status: 'running', finished_at: null }), T(2, { status: 'running', finished_at: null }), T(3, { status: 'review', result: 'viejo' })];
  const { api } = fakeApi({ 'GET /api/state': () => state(tasks) });
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42', '43']), api, fetchFn: tg.fetchFn });
  await bot.notifyOnce(); // primera lectura: solo toma nota, no avisa de lo que ya estaba
  assert.equal(tg.sent.length, 0);
  tasks = [T(1, { status: 'review', result: 'SECRETO del resultado largo', finished_at: 'a' }), T(2, { status: 'review', result: 'Hecho.\n\n¿Cuál tenant uso?', finished_at: 'b' }), T(3, { status: 'review', result: 'viejo' })];
  await bot.notifyOnce();
  await bot.notifyOnce(); // sin cambios: no repite
  const texts = tg.sent.map((s) => s.text);
  assert.equal(tg.sent.length, 4, '2 misiones x 2 chats autorizados');
  assert.ok(texts.some((x) => /Terminó · #1/.test(x) && /\/ver 1/.test(x)));
  assert.ok(texts.every((x) => !/SECRETO/.test(x)), 'el resultado no sale sin que lo pidas');
  assert.ok(texts.some((x) => /Te hace una pregunta · #2/.test(x) && /¿Cuál tenant uso\?/.test(x) && /\/responder 2/.test(x)));
  assert.deepEqual(new Set(tg.sent.map((s) => s.chat_id)), new Set(['42', '43']));
});

// ---------- el token no se filtra ----------
test('un fallo de Telegram no deja el token en los logs ni en la respuesta', async () => {
  const logs = [];
  const fetchFn = async (url) => { throw new Error(`fallo conectando a ${url}`); };
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api: async () => state([]), fetchFn, logger: { warn: (m) => logs.push(m), info() {}, error: (m) => logs.push(m) } });
  await bot.handleUpdate({ update_id: 1, message: { text: '/ayuda', chat: { id: 42, type: 'private' } } });
  await assert.rejects(bot.pollOnce(0));
  await bot.handleUpdate({ update_id: 1, message: { text: '/ayuda', chat: { id: 42, type: 'private' } } });
  assert.ok(logs.length >= 1);
  assert.ok(logs.every((l) => !l.includes('SECRET-TOKEN')), logs.join('|'));
});

// ---------- bucle de sondeo ----------
test('pollOnce procesa las actualizaciones y avanza el offset; start omite los mensajes anteriores al arranque', async () => {
  const tg = fakeTelegram();
  const { api } = fakeApi({ 'GET /api/state': () => state([]) });
  const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api, fetchFn: tg.fetchFn });
  tg.queue.push({ update_id: 50, message: { text: '/ayuda', chat: { id: 42, type: 'private' } } });
  assert.equal(await bot.pollOnce(0), 1);
  assert.equal(tg.sent.length, 1);
  await bot.pollOnce(0);
  assert.equal(tg.calls.filter((c) => c.method === 'getUpdates').at(-1).body.offset, 51);

  const tg2 = fakeTelegram();
  tg2.queue.push({ update_id: 7, message: { text: '/nueva reviewer: viejo', chat: { id: 42, type: 'private' } } });
  let created = 0;
  const bot2 = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api: async (m, p) => { if (m === 'POST') created++; return { status: 200, body: {} }; }, fetchFn: tg2.fetchFn, pollSeconds: 0 });
  await bot2.start();
  await new Promise((r) => setTimeout(r, 100));
  bot2.stop();
  assert.equal(created, 0, 'el mensaje anterior al arranque no se ejecuta');
  assert.equal(tg2.sent.length, 0);
});

// ---------- integración con la API real ----------
test('integración: /nueva sobre la API real crea una misión de lectura y la ejecuta', async () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    calls.push(args);
    child.stdin.on('data', () => {}); // sin consumir el flujo, 'end' nunca se emite
    child.kill = () => { child.stdout.end(); child.emit('close', 143); };
    child.stdin.on('end', () => setImmediate(() => { child.stdout.write(JSON.stringify({ type: 'result', result: 'Sin hallazgos', total_cost_usd: 0.01 }) + '\n'); child.stdout.end(); child.emit('close', 0); }));
    return child;
  };
  const app = createApp({ db: openDb(':memory:'), runnerOpts: { spawnFn }, attachmentsDir: join(tmp, 'att') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const api = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
    const tg = fakeTelegram();
    const bot = createTelegramBot({ token: TOKEN, allowed: new Set(['42']), api, fetchFn: tg.fetchFn });
    assert.match(await bot.handleUpdate(tg.msg('/nueva reviewer @proj: revisar el módulo de guías')), /Misión #1 lanzada/);
    await waitFor(() => ['review', 'failed'].includes(app.db.getTask(1).status));
    assert.equal(app.db.getTask(1).status, 'review', String(app.db.getTask(1).error));
    const t = app.db.getTask(1);
    assert.deepEqual([t.mode, t.project, t.agent], ['read', 'proj', 'reviewer']);
    assert.equal(calls[0][calls[0].indexOf('--permission-mode') + 1], 'plan');
    assert.match(await bot.handleUpdate(tg.msg('/nueva fantasma: x')), /Agente desconocido/);
    assert.match(await bot.handleUpdate(tg.msg('/nueva reviewer @noexiste: x')), /Proyecto/);
    assert.match(await bot.handleUpdate(tg.msg('/ver 1')), /Sin hallazgos/);
    assert.match(await bot.handleUpdate(tg.msg('/aprobar 1')), /completada/);
    assert.equal(app.db.getTask(1).status, 'done');
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});
