// Motor Codex (codex exec): solo lectura, con su propio interruptor y cupo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { route } from './router.js';

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};
const registry = { listAgents: () => [{ name: 'docs', description: 'docs' }], listProjects: () => [] };

/** `codex exec --json` falso: emite los eventos indicados y cierra con el código dado. */
function fakeCodex(lines, code = 0) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts.cwd, prompt: '' };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => child.emit('close', 143);
    child.stdin.on('data', (d) => { call.prompt += d; });
    child.stdin.on('end', () => setImmediate(() => {
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end(); setImmediate(() => child.emit('close', code));
    }));
    return child;
  };
  return { spawnFn, calls };
}

test('route: codex solo lee (editar va a Claude Code) y se puede apagar', () => {
  assert.equal(route({ agent: 'docs', engine: 'codex' }).engine, 'codex');
  assert.equal(route({ agent: 'docs', engine: 'codex', mode: 'edit' }).engine, 'claude');
  assert.match(route({ agent: 'docs', engine: 'codex' }, ['codex']).blocked, /Codex está desactivado/);
  assert.equal(route({ agent: 'docs', engine: 'auto' }, ['codex']).blocked, null); // auto nunca elige Codex
});

test('runner: la misión con Codex corre en sandbox de solo lectura y guarda su última respuesta', async () => {
  const db = openDb(':memory:');
  const { spawnFn, calls } = fakeCodex([
    { type: 'thread.started', thread_id: 'x' },
    { type: 'item.started', item: { type: 'command_execution', command: 'dir' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'pensando' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Resultado final' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } },
  ]);
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  const t = db.createTask({ title: 'con codex', agent: 'docs', engine: 'codex' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  const done = db.getTask(t.id);
  assert.equal(done.engine, 'codex');
  assert.equal(done.result, 'Resultado final');
  assert.equal(done.cost_usd, 0);
  const a = calls[0].args;
  assert.deepEqual([a[0], a.includes('--json'), a.includes('--ephemeral'), a[a.indexOf('-s') + 1], a.at(-1)], ['exec', true, true, 'read-only', '-']);
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.match(calls[0].prompt, /con codex/);
  const info = db.events(t.id).map((e) => e.text).join('\n');
  assert.match(info, /10 tokens de entrada/);
});

test('runner: un fallo de Codex deja la misión en «fallida» con su mensaje; apagado, ni arranca', async () => {
  const db = openDb(':memory:');
  const { spawnFn } = fakeCodex([{ type: 'turn.failed', error: { message: 'sesión caducada' } }], 1);
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  const t = db.createTask({ title: 'falla', agent: 'docs', engine: 'codex' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'failed');
  assert.match(db.getTask(t.id).error, /sesión caducada/);

  db.setEngineEnabled('codex', false);
  const u = db.createTask({ title: 'apagado', agent: 'docs', engine: 'codex' });
  assert.throws(() => runner.enqueue(u.id), /Codex está desactivado/);
  assert.deepEqual(runner.snapshot().off, ['codex']);
  assert.equal(runner.snapshot().limit.codex, 1);
});

test('modelo por motor: el predeterminado se elige por motor, la misión manda y se registra el modelo usado', async () => {
  const db = openDb(':memory:');
  assert.deepEqual(db.engineModels(), { claude: '', codex: '', ollama: '', lmstudio: '' });
  db.setEngineModel('codex', 'gpt-6-sol');
  const { spawnFn, calls } = fakeCodex([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]);
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  const a = db.createTask({ title: 'usa el del motor', agent: 'docs', engine: 'codex' });
  runner.enqueue(a.id);
  await waitFor(() => db.getTask(a.id).status === 'review');
  assert.equal(calls[0].args[calls[0].args.indexOf('-m') + 1], 'gpt-6-sol');
  assert.equal(db.getTask(a.id).used_model, 'gpt-6-sol');
  const b = db.createTask({ title: 'elige la misión', agent: 'docs', engine: 'codex', model: 'gpt-6-luna' });
  runner.enqueue(b.id);
  await waitFor(() => db.getTask(b.id).status === 'review');
  assert.equal(calls[1].args[calls[1].args.indexOf('-m') + 1], 'gpt-6-luna');
  db.setEngineModel('codex', '');
  const c = db.createTask({ title: 'predeterminado', agent: 'docs', engine: 'codex' });
  runner.enqueue(c.id);
  await waitFor(() => db.getTask(c.id).status === 'review');
  assert.ok(!calls[2].args.includes('-m'), 'sin elección no se pasa -m: manda el de tu sesión');
});

test('Claude Code: --model solo si hay elección y se guarda el modelo que reporta el init', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => child.emit('close', 143);
    child.stdin.on('data', () => {});
    child.stdin.on('end', () => setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' })}\n${JSON.stringify({ type: 'result', result: 'hecho', total_cost_usd: 0 })}\n`);
      child.stdout.end(); setImmediate(() => child.emit('close', 0));
    }));
    return child;
  };
  const runner = createRunner(db, () => {}, { spawnFn, registry });
  const a = db.createTask({ title: 'sin elegir', agent: 'docs', engine: 'claude' });
  runner.enqueue(a.id);
  await waitFor(() => db.getTask(a.id).status === 'review');
  assert.ok(!calls[0].includes('--model'));
  assert.equal(db.getTask(a.id).used_model, 'claude-sonnet-5-5');
  assert.equal(db.defaultSeen().claude, 'claude-sonnet-5-5'); // así la lista puede decir «predeterminado · hoy: …»
  db.setEngineModel('claude', 'haiku');
  const b = db.createTask({ title: 'del motor', agent: 'docs', engine: 'claude' });
  runner.enqueue(b.id);
  await waitFor(() => db.getTask(b.id).status === 'review');
  assert.equal(calls[1][calls[1].indexOf('--model') + 1], 'haiku');
  const c = db.createTask({ title: 'de la misión', agent: 'docs', engine: 'claude', model: 'opus' });
  runner.enqueue(c.id);
  await waitFor(() => db.getTask(c.id).status === 'review');
  assert.equal(calls[2][calls[2].indexOf('--model') + 1], 'opus');
});
