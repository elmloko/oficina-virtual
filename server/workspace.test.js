// Espacio «+Documentos»: carpeta nueva por tema, sin pisar nada, sin escapar de Documentos.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createApp } from './index.js';
import { topicName, createTopicFolder, insideBase, listFiles, removeIfEmpty } from './workspace.js';
import { listProjects, resolveProject, DOCS_PROJECT } from './registry.js';
import { route } from './router.js';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-docs-'));
const docs = join(tmp, 'Documentos');
mkdirSync(docs);
after(() => rmSync(tmp, { recursive: true, force: true }));

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

test('topicName: nombre válido en Windows a partir del título', () => {
  assert.equal(topicName('Informe de ventas — octubre'), 'Informe de ventas — octubre');
  assert.equal(topicName('Plan: A/B <test> "x" ?*'), 'Plan A B test x');
  assert.equal(topicName('  muchos    espacios...  '), 'muchos espacios');
  assert.equal(topicName('CON'), 'Tema CON');
  assert.equal(topicName('...'), 'Tema');
  assert.equal(topicName(''), 'Tema');
  assert.equal(topicName('x'.repeat(200)).length, 60);
  assert.equal(topicName('../../Windows'), '.. .. Windows'.replace(/[\s.]+$/, ''));
});

test('createTopicFolder: crea una carpeta nueva, nunca reutiliza una existente y no sale de Documentos', () => {
  const a = createTopicFolder(docs, 'Informe de ventas');
  const b = createTopicFolder(docs, 'Informe de ventas');
  const c = createTopicFolder(docs, 'Informe de ventas');
  assert.deepEqual([a, b, c].map((p) => p.slice(docs.length + 1)), ['Informe de ventas', 'Informe de ventas (2)', 'Informe de ventas (3)']);
  const evil = createTopicFolder(docs, '..\\..\\escape');
  assert.ok(insideBase(evil, docs), evil);
  assert.ok(!existsSync(join(tmp, 'escape')));
  assert.throws(() => createTopicFolder(join(tmp, 'no-existe'), 'x'), /no existe/);
  assert.equal(insideBase(docs, docs), false); // la propia carpeta Documentos no cuenta
  assert.equal(insideBase(join(docs, '..', 'otra'), docs), false);
  assert.equal(insideBase(join(docs, 'ok', 'sub'), docs), true);
});

test('listFiles y removeIfEmpty: cuentan archivos y solo retiran carpetas vacías', () => {
  const d = createTopicFolder(docs, 'Conteo');
  assert.deepEqual(listFiles(d), { files: [], total: 0 });
  mkdirSync(join(d, 'sub'));
  writeFileSync(join(d, 'a.md'), 'x'); writeFileSync(join(d, 'sub', 'b.csv'), 'y');
  assert.deepEqual(listFiles(d), { files: ['a.md', 'sub/b.csv'], total: 2 });
  assert.equal(listFiles(d, { max: 1 }).files.length, 1);
  assert.equal(removeIfEmpty(d), false); // tiene contenido: nunca se borra
  assert.ok(existsSync(join(d, 'a.md')));
  const empty = createTopicFolder(docs, 'Vacía');
  assert.equal(removeIfEmpty(empty), true);
});

test('registry y router: «+Documentos» es un proyecto editable, aparte de htdocs y de las carpetas extra', () => {
  const htdocs = join(tmp, 'htdocs'); mkdirSync(join(htdocs, 'p'), { recursive: true }); writeFileSync(join(htdocs, 'p', 'composer.json'), '{}');
  const list = listProjects(htdocs, {}, docs);
  assert.deepEqual(list.map((p) => p.name), ['p', DOCS_PROJECT]);
  assert.equal(list[1].docs, true);
  assert.equal(resolveProject(DOCS_PROJECT, htdocs, {}, docs).toLowerCase(), docs.toLowerCase());
  assert.equal(resolveProject(DOCS_PROJECT, htdocs, {}, join(tmp, 'nada')), null);
  assert.equal(resolveProject('+Documentos/../x', htdocs, {}, docs), null); // sin subrutas
  assert.equal(route({ agent: 'backend', mode: 'edit', project: DOCS_PROJECT }).mode, 'edit');
  assert.equal(route({ agent: 'devops', mode: 'edit', project: DOCS_PROJECT }).mode, 'read'); // infraestructura sigue forzada a lectura
});

/** `claude -p` falso que guarda un archivo en su carpeta de trabajo (cwd) como lo haría el agente. */
function writerClaude(filename) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => child.emit('close', 143);
    child.stdin.on('data', () => {});
    child.stdin.on('end', () => setImmediate(() => {
      if (filename) writeFileSync(join(opts.cwd, filename), 'contenido');
      child.stdout.write(JSON.stringify({ type: 'result', result: 'hecho', total_cost_usd: 0.01 }) + '\n');
      child.stdout.end(); setImmediate(() => child.emit('close', 0));
    }));
    return child;
  };
  return { spawnFn, calls };
}
const registry = { listAgents: () => [{ name: 'docs', description: 'docs' }], listProjects: () => [] };

test('misión que edita en Documentos: trabaja en una carpeta nueva con el nombre del tema y avisa qué guardó', async () => {
  const db = openDb(':memory:');
  const { spawnFn, calls } = writerClaude('informe.md');
  const runner = createRunner(db, () => {}, { spawnFn, registry, docsRoot: docs });
  const t = db.createTask({ title: 'Manual de usuario del módulo de guías', agent: 'docs', project: DOCS_PROJECT, mode: 'edit' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  const done = db.getTask(t.id);
  const expected = join(docs, 'Manual de usuario del módulo de guías');
  assert.equal(done.workdir, expected);
  assert.equal(calls[0].cwd, expected);
  assert.ok(calls[0].args.includes('acceptEdits'));
  assert.ok(existsSync(join(expected, 'informe.md')));
  const info = db.events(t.id).map((e) => e.text).join('\n');
  assert.match(info, /Carpeta nueva para este tema/);
  assert.match(info, /1 archivo\(s\) guardados[\s\S]*- informe\.md/);

  // una respuesta continúa en la MISMA carpeta (no crea otra)
  runner.reply(t.id, 'añade un índice');
  await waitFor(() => db.getTask(t.id).status === 'review' && calls.length === 2);
  assert.equal(calls[1].cwd, expected);
  assert.equal(readdirSync(docs).filter((n) => n.startsWith('Manual de usuario')).length, 1);
});

test('misión en Documentos que no guarda nada o falla: no deja carpetas vacías; en solo lectura no crea carpeta', async () => {
  const before = readdirSync(docs).length;
  const db = openDb(':memory:');
  const { spawnFn, calls } = writerClaude(null);
  const runner = createRunner(db, () => {}, { spawnFn, registry, docsRoot: docs });
  const t = db.createTask({ title: 'Sin archivos', agent: 'docs', project: DOCS_PROJECT, mode: 'edit' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(db.getTask(t.id).workdir, null);
  assert.match(db.events(t.id).map((e) => e.text).join('\n'), /no guardó ningún archivo/);
  assert.equal(readdirSync(docs).length, before);

  const r = db.createTask({ title: 'Solo leer', agent: 'docs', project: DOCS_PROJECT, mode: 'read' });
  runner.enqueue(r.id);
  await waitFor(() => db.getTask(r.id).status === 'review');
  assert.equal(readdirSync(docs).length, before);
  assert.notEqual(calls.at(-1).cwd, docs); // nunca se le da acceso a toda la carpeta Documentos
  assert.ok(calls.at(-1).args.includes('plan'));
});

test('API: abrir la carpeta de una misión solo funciona si está dentro de Documentos', async () => {
  const opened = [];
  const db = openDb(':memory:');
  const app = createApp({ db, docsRoot: docs, openFolder: (d) => opened.push(d) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const open = (id) => fetch(`${base}/api/tasks/${id}/open-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  try {
    const dir = createTopicFolder(docs, 'Para abrir');
    const ok = db.createTask({ title: 'ok', agent: 'docs' }); db.updateTask(ok.id, { workdir: dir });
    const res = await open(ok.id);
    assert.equal(res.status, 200);
    assert.deepEqual(opened, [dir]);
    const outside = db.createTask({ title: 'fuera', agent: 'docs' }); db.updateTask(outside.id, { workdir: tmp }); // fuera de Documentos
    assert.equal((await open(outside.id)).status, 404);
    const same = db.createTask({ title: 'raíz', agent: 'docs' }); db.updateTask(same.id, { workdir: docs }); // la propia Documentos tampoco
    assert.equal((await open(same.id)).status, 404);
    const none = db.createTask({ title: 'sin carpeta', agent: 'docs' });
    assert.equal((await open(none.id)).status, 404);
    assert.equal(opened.length, 1);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});
