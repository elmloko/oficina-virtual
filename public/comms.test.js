import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threads, activeLinks, ticker, prune, progress, arc, FLIGHT_MS } from './comms.js';

const msg = (id, task_id, kind, from_agent, to_agent, text = 'x') => ({ id, task_id, kind, from_agent, to_agent, text });
const tasks = new Map([
  [1, { id: 1, agent: 'backend', status: 'running' }],
  [2, { id: 2, agent: 'dba', status: 'review' }],
  [11, { id: 11, agent: 'security', status: 'running', consult_of: 1 }],
  [12, { id: 12, agent: 'dba', status: 'done', consult_of: 1 }],
  [13, { id: 13, agent: 'tester', status: 'queued', consult_of: 2 }],
]);

test('threads: agrupa por misión, ordena por actividad y detecta a quién se espera', () => {
  const t = threads([
    msg(1, 1, 'request', 'backend', 'security'), msg(2, 1, 'request', 'backend', 'dba'), msg(3, 1, 'answer', 'dba', 'backend'),
    msg(4, 2, 'request', 'dba', 'tester'),
  ], tasks);
  assert.deepEqual(t.map((x) => x.taskId), [2, 1]); // la más reciente primero
  const one = t[1];
  assert.equal(one.asker, 'backend');
  assert.deepEqual(one.helpers, ['security', 'dba']);
  assert.deepEqual(one.waiting, ['security']); // dba ya respondió
  assert.equal(one.task.agent, 'backend');
  assert.deepEqual(threads([], tasks), []);
  assert.equal(threads([msg(5, 99, 'request', 'a', 'b')], tasks)[0].task, undefined); // misión borrada: no rompe
});

test('activeLinks: solo las consultas en curso, de quien pide a quien responde', () => {
  assert.deepEqual(activeLinks(tasks).map((l) => `${l.from}>${l.to}:${l.state}`), ['backend>security:running', 'dba>tester:queued']);
  assert.deepEqual(activeLinks([...tasks.values()]).length, 2); // acepta Map o lista
});

test('ticker, vuelos y trayectoria', () => {
  assert.equal(ticker(msg(1, 1, 'request', 'backend', 'security', '¿Cómo guardo el token?')), 'backend → security: ¿Cómo guardo el token?');
  assert.equal(ticker(msg(2, 1, 'answer', 'security', 'backend')), 'security → backend: respondió');
  assert.match(ticker(msg(3, 1, 'request', 'a', 'b', 'z'.repeat(200))), /…$/);
  const fl = [{ t0: 0 }, { t0: 5000 }];
  assert.equal(prune(fl, 5000 + FLIGHT_MS - 1).length, 1);
  assert.equal(prune(fl, 10_000).length, 0);
  assert.equal(progress({ t0: 100 }, 100), 0);
  assert.equal(progress({ t0: 100 }, 100 + FLIGHT_MS), 1);
  const mid = progress({ t0: 0 }, FLIGHT_MS * 0.4);
  assert.ok(mid > 0.4 && mid < 0.6, `a mitad del trayecto: ${mid}`);
  const a = { x: 0, y: 100 }; const b = { x: 100, y: 100 };
  assert.deepEqual(arc(a, b, 0), a);
  assert.deepEqual(arc(a, b, 1), b);
  assert.ok(arc(a, b, 0.5).y < 100, 'el sobre vuela en arco, por encima de los agentes');
});
