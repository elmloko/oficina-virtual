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
