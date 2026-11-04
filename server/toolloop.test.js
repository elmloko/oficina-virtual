// Bucle de herramientas: los motores de chat (Ollama, LM Studio, API) también editan, operan y tienen control total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAction, localTools, runToolLoop, guardReason, toolsPrompt } from './toolloop.js';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { loadProviders } from './providers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'loop-'));
const act = (o) => `Voy.\n\`\`\`accion\n${JSON.stringify(o)}\n\`\`\``;

test('parseAction: lee el último bloque, avisa del JSON roto y sin bloque es la respuesta final', () => {
  assert.deepEqual(parseAction(act({ herramienta: 'leer', ruta: 'a.txt' })), { herramienta: 'leer', ruta: 'a.txt' });
  assert.match(parseAction('```accion\n{roto}\n```').error, /JSON válido/);
  assert.match(parseAction('```accion\n{"ruta":"x"}\n```').error, /herramienta/);
  assert.equal(parseAction('Listo, terminé.'), null);
  // Modelos pequeños: ```json``` y varias acciones seguidas → solo la primera, avisando
  const two = '```json\n{"herramienta":"listar","ruta":"."}\n```\ny luego\n```json\n{"herramienta":"leer","ruta":"a"}\n```';
  assert.deepEqual(parseAction(two), { herramienta: 'listar', ruta: '.', extra: true });
  assert.equal(parseAction('Ejemplo:\n```json\n{"a":1}\n```'), null, 'un JSON cualquiera no es una acción');
});

test('localTools (editar): lee, escribe y reemplaza dentro del proyecto; fuera, .git y comandos no', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), 'hola mundo');
    const exec = localTools({ mode: 'edit', root: dir });
    assert.equal(await exec({ herramienta: 'leer', ruta: 'a.txt' }), 'hola mundo');
    await exec({ herramienta: 'reemplazar', ruta: 'a.txt', buscar: 'mundo', poner: 'oficina' });
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hola oficina');
    await exec({ herramienta: 'escribir', ruta: 'sub/b.txt', contenido: 'nuevo' });
    assert.equal(readFileSync(join(dir, 'sub', 'b.txt'), 'utf8'), 'nuevo');
    assert.match(await exec({ herramienta: 'listar', ruta: '.' }), /sub\//);
    assert.match(await exec({ herramienta: 'buscar', ruta: '.', texto: 'oficina' }), /a\.txt:1/);
    await assert.rejects(exec({ herramienta: 'leer', ruta: '../fuera.txt' }), /Fuera del proyecto/);
    await assert.rejects(exec({ herramienta: 'escribir', ruta: '.git/config', contenido: 'x' }), /\.git/);
    await assert.rejects(exec({ herramienta: 'comando', comando: 'dir' }), /no puedes ejecutar comandos/);
    await assert.rejects(exec({ herramienta: 'reemplazar', ruta: 'a.txt', buscar: 'nada', poner: 'x' }), /No se encontró/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('localTools (control total): copia .bak antes de reemplazar y el guard bloquea lo catastrófico', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'c.txt'), 'viejo');
    const exec = localTools({ mode: 'full', root: dir });
    await exec({ herramienta: 'escribir', ruta: 'c.txt', contenido: 'nuevo' });
    assert.equal(readFileSync(join(dir, 'c.txt.bak'), 'utf8'), 'viejo');
    assert.match(await exec({ herramienta: 'comando', comando: 'Stop-Computer -Force' }), /Bloqueado/);
    assert.ok(guardReason('format C: /q'));
    assert.equal(guardReason('git status'), null);
    assert.match(toolsPrompt('full', dir), /"herramienta":"comando"/);
    assert.doesNotMatch(toolsPrompt('edit', dir), /"herramienta":"comando"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runToolLoop: ejecuta las acciones, devuelve los errores al modelo y termina con su respuesta', async () => {
  const replies = [act({ herramienta: 'leer', ruta: 'x' }), '```accion\n{mal}\n```', 'Terminado.'];
  const seen = [];
  const out = await runToolLoop({
    system: 's', prompt: 'p',
    send: async (msgs) => { seen.push(msgs.at(-1).content); return replies.shift(); },
    exec: async () => 'contenido de x',
  });
  assert.equal(out, 'Terminado.');
  assert.match(seen[1], /contenido de x/);
  assert.match(seen[2], /JSON válido/);
  await assert.rejects(runToolLoop({ system: 's', prompt: 'p', send: async () => act({ herramienta: 'leer', ruta: 'x' }), exec: async () => 'y', maxSteps: 3 }), /máximo de pasos/);
});

test('runner: un proveedor de chat con control total crea el archivo pedido usando las herramientas de la oficina', async () => {
  const dir = tmp();
  const target = join(dir, 'informe.txt').replace(/\\/g, '/');
  try {
    const replies = [act({ herramienta: 'escribir', ruta: target, contenido: 'listo' }), 'Creé el informe.'];
    const bodies = [];
    const fetchFn = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      const text = replies.shift();
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const db = openDb(':memory:');
    const providers = loadProviders({ OPENAI_API_KEY: 'sk-test-000' });
    const runner = createRunner(db, () => {}, { providers, fetchFn, registry: { listAgents: () => [{ name: 'backend', description: '' }], listProjects: () => [] } });
    const t = db.createTask({ title: 'Haz un informe', agent: 'backend', engine: 'openai', mode: 'full' });
    runner.enqueue(t.id);
    const end = Date.now() + 5000;
    while (!['review', 'failed'].includes(db.getTask(t.id).status) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const done = db.getTask(t.id);
    assert.equal(done.status, 'review', done.error ?? '');
    assert.equal(done.result, 'Creé el informe.');
    assert.ok(existsSync(target));
    assert.equal(bodies.length, 2);
    assert.match(bodies[0].messages.at(-1).content, /Herramientas \(la oficina las ejecuta por ti\)/);
    assert.match(bodies[1].messages.at(-1).content, /Creado/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
