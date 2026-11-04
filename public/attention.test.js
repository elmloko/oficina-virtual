import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuestion, attentionItems, transition } from './attention.js';

test('isQuestion: detecta cuando el agente pide algo al final', () => {
  assert.equal(isQuestion('¿Uso la tarifa nacional o la internacional?'), true);
  assert.equal(isQuestion('Revisé todo.\n\nHallazgos:\n- a\n- b\n\n¿Quieres que corrija el N+1 también?'), true);
  assert.equal(isQuestion('Dime cuál prefieres?'), true);
  assert.equal(isQuestion('Listo. **¿Continúo con los tests?**'), true);
  assert.equal(isQuestion('Terminé el análisis. Todo correcto.'), false);
  assert.equal(isQuestion('¿Por qué falla? Porque falta el índice.\n\nSolución aplicada.'), false); // la pregunta no es lo último
  assert.equal(isQuestion(''), false);
  assert.equal(isQuestion(null), false);
});

const T = (id, status, extra = {}) => ({ id, title: `t${id}`, agent: 'backend', kind: 'task', status, result: '', ...extra });

test('attentionItems: ordena preguntas, fallidas, planes y por revisar; ignora lo demás', () => {
  const tasks = [
    T(1, 'review', { result: 'Todo bien.' }),
    T(2, 'failed', { error: 'x' }),
    T(3, 'review', { result: '¿Sigo con la migración?' }),
    T(4, 'running'), T(5, 'done'), T(6, 'backlog'), T(7, 'queued'),
    T(8, 'review', { kind: 'objective', result: '{}' }),
    T(9, 'backlog', { parent_id: 8 }),
    T(10, 'review', { kind: 'objective', result: '{}' }), // plan sin pasos pendientes: nada que lanzar
    T(11, 'done', { parent_id: 10 }),
    T(12, 'failed'),
  ];
  assert.deepEqual(attentionItems(tasks).map((i) => `${i.kind}:${i.task.id}`), ['question:3', 'failed:12', 'failed:2', 'plan:8', 'review:1']);
});

test('transition: solo avisa al terminar una misión que estaba en curso', () => {
  assert.equal(transition(undefined, T(1, 'review')), null); // apareció ya terminada (carga inicial)
  assert.equal(transition('review', T(1, 'review')), null);
  assert.equal(transition('backlog', T(1, 'queued')), null);
  assert.equal(transition('running', T(1, 'running')), null);
  assert.equal(transition('running', T(1, 'review', { result: 'ok' })).kind, 'done');
  assert.equal(transition('queued', T(1, 'review', { result: '¿Cuál?' })).kind, 'question');
  assert.equal(transition('running', T(1, 'failed')).kind, 'failed');
  assert.equal(transition('running', T(1, 'backlog')), null); // cancelada
  assert.equal(transition('running', T(1, 'review', { kind: 'objective' })).kind, 'plan');
});

test('isQuestion: también cuando pide una instrucción sin signo de pregunta', () => {
  for (const s of ['Listo el diagnóstico.\n\nIndícame qué contenedor reinicio.', 'Dime si aplico el cambio en producción.', 'Quedo a la espera de tu confirmación.', 'Necesito que me indiques el dominio.', 'Avísame cuando cierres el Excel.']) assert.equal(isQuestion(s), true, s);
  assert.equal(isQuestion('Hecho. Reinicié el contenedor y la web responde 200.'), false);
  assert.equal(isQuestion('El servidor indica que todo está bien.'), false);
});
