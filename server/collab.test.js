// Colaboración entre agentes: protocolo [[CONSULTAR …]], misiones de consulta, reanudación y límites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { parseConsults, stripConsults, protocolPrompt, answersPrompt } from './collab.js';

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};
const NAMES = new Set(['backend', 'security', 'dba']);
const registry = { listAgents: () => [...NAMES].map((name) => ({ name, description: name })), listProjects: () => [] };

/** `claude -p` falso: la respuesta depende del prompt recibido. */
function fakeClaude(decide, { hangOn } = {}) {
  const prompts = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let input = '';
    let killed = false;
    child.kill = () => { killed = true; child.emit('close', 143); };
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('end', () => {
      prompts.push(input);
      if (hangOn?.(input)) return; // se queda colgado hasta que lo cancelen
      setImmediate(() => {
        if (killed) return;
        const out = decide(input);
        child.stdout.write(JSON.stringify(typeof out === 'object' ? { type: 'result', is_error: true, result: out.error } : { type: 'result', result: out, total_cost_usd: 0.01 }) + '\n');
        child.stdout.end();
        setImmediate(() => child.emit('close', 0));
      });
    });
    return child;
  };
  return { spawnFn, prompts };
}
const setup = (decide, opts, settings = {}) => {
  const db = openDb(':memory:');
  db.setSettings({ max_claude: 2, ...settings });
  const emitted = [];
  const f = fakeClaude(decide, opts);
  const runner = createRunner(db, (id, extra) => emitted.push({ id, ...extra }), { spawnFn: f.spawnFn, registry });
  return { db, runner, emitted, ...f };
};
const ask = (agent, q) => `[[CONSULTAR ${agent}: ${q}]]`;

test('parseConsults: extrae consultas válidas, ignora duplicadas, a sí mismo y agentes inexistentes, y limita a 3', () => {
  const text = `Pienso…\n${ask('security', '¿Es seguro?')}\n${ask('SECURITY', 'repetida')}\n${ask('backend', 'a mí mismo')}\n${ask('fantasma', 'no existe')}\n[[CONSULTAR dba:  ¿Qué índice\n usar? ]]`;
  const r = parseConsults(text, NAMES, 'backend');
  assert.deepEqual(r.asks, [{ agent: 'security', question: '¿Es seguro?' }, { agent: 'dba', question: '¿Qué índice usar?' }]);
  assert.deepEqual(r.unknown, ['fantasma']);
  const many = parseConsults(['a1', 'a2', 'a3', 'a4', 'a5'].map((n) => ask(n, 'x')).join('\n'), new Set(['a1', 'a2', 'a3', 'a4', 'a5']), 'z');
  assert.equal(many.asks.length, 3);
  assert.deepEqual(parseConsults('sin etiquetas', NAMES, 'x').asks, []);
  assert.equal(stripConsults(`Texto\n\n${ask('security', 'x')}\n\n\n\nFin`), 'Texto\n\nFin');
  assert.match(protocolPrompt(['backend', 'security'], 'backend'), /\[\[CONSULTAR[\s\S]*Agentes disponibles: security\./);
  assert.match(answersPrompt([{ agent: 'a', text: 'ok' }, { agent: 'b', error: 'cayó' }]), /\[a\] ok[\s\S]*\[b\] No pudo responder: cayó/);
});

test('flujo completo: el agente pide ayuda, el colega responde y el agente original termina integrando la respuesta', async () => {
  const { db, runner, emitted, prompts } = setup((p) => {
    if (p.includes('Respuestas de los colegas')) return 'FINAL integrado con lo que dijo security';
    if (p.includes('necesita tu ayuda')) return 'Usa un token con rotación y guárdalo en una variable de entorno.';
    return `Reviso el código.\n${ask('security', '¿Cómo guardo el token?')}`;
  });
  const t = db.createTask({ title: 'Guardar token de courier', agent: 'backend' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');

  const done = db.getTask(t.id);
  assert.equal(done.result, 'FINAL integrado con lo que dijo security'); // sin etiquetas
  assert.ok(Math.abs(done.cost_usd - 0.02) < 1e-9, `costo acumulado de las dos fases: ${done.cost_usd}`);
  const kids = db.listTasks().filter((x) => x.consult_of === t.id);
  assert.equal(kids.length, 1);
  assert.deepEqual([kids[0].agent, kids[0].status, kids[0].mode], ['security', 'done', 'read']);
  assert.match(kids[0].description, /backend.*necesita tu ayuda[\s\S]*Cómo guardo el token/);

  const msgs = db.messages();
  assert.deepEqual(msgs.map((m) => [m.kind, m.from_agent, m.to_agent]), [['request', 'backend', 'security'], ['answer', 'security', 'backend']]);
  assert.match(msgs[1].text, /rotación/);
  assert.equal(db.taskMessages(kids[0].id).length, 2); // también se ve desde la misión del colega
  assert.ok(emitted.some((e) => e.message?.kind === 'request') && emitted.some((e) => e.message?.kind === 'answer'), 'la UI recibe cada mensaje');

  assert.ok(db.events(t.id).some((e) => e.kind === 'consult' && /Respuestas de los colegas[\s\S]*\[security\]/.test(e.text)));
  const last = prompts.at(-1);
  assert.match(last, /Respuestas de los colegas[\s\S]*rotación/);
  assert.match(last, /No pidas más consultas/); // segunda fase: no se permite otra ronda
  assert.match(prompts[0], /Colaboración con otros agentes[\s\S]*Agentes disponibles: security, dba/);
  assert.doesNotMatch(prompts[1], /Colaboración con otros agentes/); // el colega no puede consultar a otros
  assert.ok(db.auditLog(20).some((a) => a.action === 'consult.create'));
});

test('con un solo cupo de Claude no hay bloqueo: el agente en espera libera su lugar para su colega', async () => {
  const { db, runner } = setup((p) => (p.includes('Respuestas de los colegas') ? 'listo' : p.includes('necesita tu ayuda') ? 'respuesta' : ask('dba', '¿índice?')), {}, { max_claude: 1 });
  const t = db.createTask({ title: 'Consulta con cupo único', agent: 'backend' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(db.getTask(t.id).result, 'listo');
});

test('segunda ronda no permitida, agentes inexistentes ignorados y etiquetas siempre retiradas', async () => {
  const always = setup((p) => `Sigo necesitando ayuda ${ask('security', 'otra vez')}`);
  const t = always.db.createTask({ title: 'Insistente', agent: 'backend' });
  always.runner.enqueue(t.id);
  await waitFor(() => always.db.getTask(t.id).status === 'review');
  assert.equal(always.db.listTasks().filter((x) => x.consult_of === t.id).length, 1, 'solo una ronda de consultas');
  assert.doesNotMatch(always.db.getTask(t.id).result, /CONSULTAR/);

  const ghost = setup(() => `Hola ${ask('fantasma', '¿?')}`);
  const g = ghost.db.createTask({ title: 'Fantasma', agent: 'backend' });
  ghost.runner.enqueue(g.id);
  await waitFor(() => ghost.db.getTask(g.id).status === 'review');
  assert.equal(ghost.db.listTasks().length, 1);
  assert.ok(ghost.db.events(g.id).some((e) => /no existen.*fantasma/.test(e.text)));
});

test('se puede desactivar; rutinas, revisiones y consultas no pueden pedir ayuda', async () => {
  const off = setup(() => `Texto ${ask('security', '¿?')}`, {}, { collab: 0 });
  const a = off.db.createTask({ title: 'Sin colaboración', agent: 'backend' });
  off.runner.enqueue(a.id);
  await waitFor(() => off.db.getTask(a.id).status === 'review');
  assert.equal(off.db.listTasks().length, 1);
  assert.doesNotMatch(off.prompts[0], /Colaboración con otros agentes/);
  assert.doesNotMatch(off.db.getTask(a.id).result, /CONSULTAR/);

  const on = setup(() => `Texto ${ask('security', '¿?')}`);
  const routine = on.db.createTask({ title: 'Rutina', agent: 'backend', schedule_id: 1 });
  const review = on.db.createTask({ title: 'Revisión', agent: 'backend', review_of: routine.id });
  for (const t of [routine, review]) { on.runner.enqueue(t.id); await waitFor(() => on.db.getTask(t.id).status === 'review'); }
  assert.equal(on.db.listTasks().length, 2);
  assert.doesNotMatch(on.prompts.join('\n'), /Colaboración con otros agentes/);
});

test('cancelar al agente que espera cancela también a los colegas consultados', async () => {
  const { db, runner } = setup(() => ask('security', 'lenta'), { hangOn: (p) => p.includes('necesita tu ayuda') });
  const t = db.createTask({ title: 'Se cancela', agent: 'backend' });
  runner.enqueue(t.id);
  const kid = await waitFor(() => db.listTasks().find((x) => x.consult_of === t.id && x.status === 'running'));
  assert.equal(db.getTask(t.id).status, 'running'); // en espera de su colega
  runner.cancel(t.id);
  await waitFor(() => db.getTask(kid.id).status === 'backlog');
  assert.equal(db.getTask(t.id).status, 'backlog');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(db.getTask(t.id).status, 'backlog', 'no se reanuda tras cancelar');
});

test('un colega que falla no bloquea: el agente original recibe el aviso y termina', async () => {
  const { db, runner, prompts } = setup((p) => {
    if (p.includes('Respuestas de los colegas')) return 'terminé sin la ayuda';
    if (p.includes('necesita tu ayuda')) return { error: 'boom' };
    return ask('security', '¿?');
  });
  const t = db.createTask({ title: 'Colega caído', agent: 'backend' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(db.getTask(t.id).result, 'terminé sin la ayuda');
  const kid = db.listTasks().find((x) => x.consult_of === t.id);
  assert.equal(kid.status, 'failed');
  assert.match(prompts.at(-1), /\[security\] No pudo responder: boom/);
  assert.match(db.messages().at(-1).text, /No pudo responder: boom/);
});
