// Adjuntos: validación, API (subir, listar, servir, borrar) y prompt hacia claude y hacia motores sin archivos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-att-'));
const agentsDir = join(tmp, 'agents');
mkdirSync(agentsDir);
writeFileSync(join(agentsDir, 'reviewer.md'), '---\nname: reviewer\ndescription: "r"\n---\ncuerpo\n');
process.env.HTDOCS_ROOT = join(tmp, 'htdocs');
process.env.AGENTS_DIR = agentsDir;
mkdirSync(process.env.HTDOCS_ROOT);

const { openDb } = await import('./db.js');
const { createApp } = await import('./index.js');
const { checkUpload, cleanName, promptSection, fileFor, MAX_FILE_BYTES } = await import('./attachments.js');

const attDir = join(tmp, 'att');
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(20)]);
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout esperando condición');
};

after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------- validación pura ----------
test('cleanName: quita rutas, caracteres de control y puntos iniciales', () => {
  assert.equal(cleanName('..\\..\\secreto\\a.txt'), 'a.txt');
  assert.equal(cleanName('/etc/passwd.md'), 'passwd.md');
  assert.equal(cleanName('.env'), 'env');
  assert.equal(cleanName('a\u0000b\n.txt'), 'ab.txt');
  assert.equal(cleanName('x'.repeat(300) + '.txt').length, 100);
  assert.equal(cleanName(null), '');
});

test('checkUpload: tipos permitidos, contenido que coincide con la extensión y límites', () => {
  assert.equal(checkUpload('captura.png', PNG).mime, 'image/png');
  assert.equal(checkUpload('nota.md', Buffer.from('hola')).mime, 'text/plain');
  assert.match(checkUpload('virus.exe', Buffer.from('MZ')).error, /no permitido/);
  assert.match(checkUpload('sin-extension', Buffer.from('x')).error, /no permitido/);
  assert.match(checkUpload('falsa.png', Buffer.from('<script>alert(1)</script>')).error, /no corresponde/);
  assert.match(checkUpload('bin.txt', Buffer.from([65, 0, 66])).error, /binarios/);
  assert.match(checkUpload('vacio.txt', Buffer.alloc(0)).error, /vacío/);
  assert.match(checkUpload('grande.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 97)).error, /supera/);
  assert.match(checkUpload('', Buffer.from('x')).error, /nombre/);
  assert.equal(checkUpload('doc.pdf', Buffer.from('%PDF-1.7 ...')).mime, 'application/pdf');
  assert.match(checkUpload('logo.svg', Buffer.from('<svg/>')).error, /no permitido/); // svg puede llevar scripts
});

test('promptSection: claude recibe rutas; los demás motores, el texto (recortado) y aviso de lo que no leen', async () => {
  const dir = join(tmp, 'ps'); mkdirSync(join(dir, '1'), { recursive: true });
  const atts = [{ id: 1, task_id: 1, name: 'notas.md', mime: 'text/plain', size: 5 }, { id: 2, task_id: 1, name: 'foto.png', mime: 'image/png', size: 20 }, { id: 3, task_id: 1, name: 'grande.txt', mime: 'text/plain', size: 30000 }];
  writeFileSync(fileFor(dir, atts[0]), 'HOLA!');
  writeFileSync(fileFor(dir, atts[2]), 'z'.repeat(30000));
  assert.equal(await promptSection(dir, [], 'claude'), '');
  const c = await promptSection(dir, atts, 'claude');
  assert.ok(c.includes(fileFor(dir, atts[0])) && c.includes(fileFor(dir, atts[1])));
  assert.doesNotMatch(c, /HOLA!/);
  const o = await promptSection(dir, atts, 'ollama');
  assert.match(o, /### notas\.md[\s\S]*HOLA!/);
  assert.match(o, /«foto\.png» \(image\/png\): este motor no puede leer/);
  assert.match(o, /grande\.txt \(recortado\)/);
  assert.ok(o.length < 45000);
});

// ---------- API ----------
const calls = [];
const spawnFn = (cmd, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const call = { args, input: '' }; calls.push(call);
  child.stdin.on('data', (d) => { call.input += d; });
  child.kill = () => { child.stdout.end(); child.emit('close', 143); };
  child.stdin.on('end', () => setImmediate(() => { child.stdout.write(JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0 }) + '\n'); child.stdout.end(); child.emit('close', 0); }));
  return child;
};
let app, base;
before(async () => {
  app = createApp({ db: openDb(':memory:'), runnerOpts: { spawnFn }, attachmentsDir: attDir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.server.closeAllConnections?.(); });

const json = (method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const upload = (id, name, buf) => fetch(`${base}/api/tasks/${id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', body: buf });
const newTask = async (extra = {}) => (await (await json('POST', '/api/tasks', { title: 'Con adjuntos', agent: 'reviewer', ...extra })).json());

test('API: subir, listar, servir (imagen inline, texto como descarga) y borrar un adjunto', async () => {
  const t = await newTask();
  const up = await upload(t.id, 'captura.png', PNG);
  assert.equal(up.status, 201);
  const a = await up.json();
  assert.deepEqual([a.name, a.mime, a.size, a.task_id], ['captura.png', 'image/png', PNG.length, t.id]);
  assert.ok(existsSync(fileFor(attDir, a)));

  const txt = await (await upload(t.id, 'nota.md', Buffer.from('# <b>hola</b>'))).json();
  const list = await (await json('GET', `/api/tasks/${t.id}/attachments`)).json();
  assert.deepEqual(list.map((x) => x.name), ['captura.png', 'nota.md']);

  const img = await fetch(`${base}/api/attachments/${a.id}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-disposition'), /^inline/);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  const doc = await fetch(`${base}/api/attachments/${txt.id}`);
  assert.equal(doc.headers.get('content-type'), 'application/octet-stream'); // nunca se renderiza como página
  assert.match(doc.headers.get('content-disposition'), /^attachment/);
  assert.match(doc.headers.get('content-security-policy'), /sandbox/);

  assert.equal((await json('DELETE', `/api/attachments/${a.id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/attachments/${a.id}`)).status, 404);
  assert.equal(existsSync(fileFor(attDir, a)), false);
  assert.equal((await json('GET', `/api/tasks/${t.id}/attachments`).then((r) => r.json())).length, 1);
});

test('API: rechaza tipos no permitidos, contenido falso, tarea inexistente, objetivos y exceso de archivos', async () => {
  const t = await newTask();
  assert.equal((await upload(t.id, 'x.exe', Buffer.from('MZ'))).status, 400);
  assert.equal((await upload(t.id, 'falsa.png', Buffer.from('no soy png'))).status, 400);
  assert.equal((await upload(9999, 'a.txt', Buffer.from('x'))).status, 404);
  const obj = (await (await json('POST', '/api/objectives', { title: 'Objetivo grande' })).json());
  assert.ok(obj.id);
  assert.equal((await upload(obj.id, 'a.txt', Buffer.from('x'))).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await upload(t.id, `f${i}.txt`, Buffer.from('x'))).status, 201);
  const over = await upload(t.id, 'extra.txt', Buffer.from('x'));
  assert.equal(over.status, 409);
  assert.match((await over.json()).error, /Máximo 10/);
});

test('API: un archivo mayor al tope se corta (413) y no deja nada en disco', async () => {
  const t = await newTask();
  // el servidor responde sin leer todo el cuerpo: el cliente ve el 413 o, según el momento, la conexión cortada
  const r = await upload(t.id, 'enorme.txt', Buffer.alloc(MAX_FILE_BYTES + 10, 97)).catch((e) => ({ status: /ECONNRESET|fetch failed/.test(String(e.cause ?? e)) ? 413 : 0 }));
  assert.equal(r.status, 413);
  assert.equal((await json('GET', `/api/tasks/${t.id}/attachments`).then((x) => x.json())).length, 0);
});

test('API: el total por misión tiene tope y el nombre del cliente no decide la ruta en disco', async () => {
  const t = await newTask();
  const big = Buffer.alloc(MAX_FILE_BYTES - 100, 97);
  for (let i = 0; i < 3; i++) assert.equal((await upload(t.id, `g${i}.txt`, big)).status, 201); // ~24 MB
  const r = await upload(t.id, 'g4.txt', big);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /25 MB/);

  const t2 = await newTask();
  const a = await (await upload(t2.id, '..\\..\\..\\escape.txt', Buffer.from('x'))).json();
  assert.equal(a.name, 'escape.txt');
  assert.ok(fileFor(attDir, a).startsWith(attDir));
  assert.ok(!existsSync(join(tmp, 'escape.txt')));
});

test('ejecutar: claude recibe las rutas en el prompt y --add-dir; un motor local recibe el texto', async () => {
  const t = await newTask({ engine: 'claude' });
  const a = await (await upload(t.id, 'pista.txt', Buffer.from('LA CLAVE ES 42'))).json();
  assert.equal((await json('POST', `/api/tasks/${t.id}/run`, {})).status, 202);
  await waitFor(() => app.db.getTask(t.id).status === 'review');
  const c = calls.at(-1);
  assert.ok(c.input.includes(fileFor(attDir, a)), 'el prompt incluye la ruta absoluta');
  assert.doesNotMatch(c.input, /LA CLAVE ES 42/);
  const i = c.args.indexOf('--add-dir');
  assert.ok(i >= 0 && c.args[i + 1] === join(attDir, String(t.id)));

  const sin = await newTask({ engine: 'claude' });
  await json('POST', `/api/tasks/${sin.id}/run`, {});
  await waitFor(() => app.db.getTask(sin.id).status === 'review');
  assert.equal(calls.at(-1).args.includes('--add-dir'), false); // sin adjuntos no se abre ninguna carpeta extra
  assert.doesNotMatch(calls.at(-1).input, /Archivos adjuntos/);
});

test('eliminar la misión borra sus adjuntos del disco y de la base', async () => {
  const t = await newTask();
  const a = await (await upload(t.id, 'temporal.txt', Buffer.from('x'))).json();
  assert.ok(existsSync(fileFor(attDir, a)));
  assert.equal((await json('DELETE', `/api/tasks/${t.id}`)).status, 200);
  assert.equal(existsSync(fileFor(attDir, a)), false);
  assert.equal(app.db.attachments(t.id).length, 0);
});
