import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preview, chatThread, seenKey, agentHue } from './inbox.js';

test('bandeja: la vista previa muestra el final de la respuesta, sin markdown, o el error si falló', () => {
  assert.equal(preview('review', { result: '**Listo**: hice   los\ncambios en `create_envios`' }), 'Listo: hice los cambios en create_envios'); // los _ de los nombres se conservan
  const long = `${'x'.repeat(300)} ¿Cuál prefieres?`;
  const p = preview('question', { result: long });
  assert.ok(p.startsWith('…') && p.endsWith('¿Cuál prefieres?'));
  assert.equal(preview('failed', { error: 'Ollama respondió 500', result: 'viejo' }), 'Ollama respondió 500');
  assert.equal(preview('plan', {}, 3), '3 paso(s) pendientes de lanzar');
});

test('bandeja: la conversación alterna tus mensajes y las respuestas del agente, y termina en el estado actual', () => {
  const events = [
    { kind: 'info', text: 'arrancando' },
    { kind: 'answer', text: 'Primera respuesta' },
    { kind: 'user', text: 'Hazlo más corto' },
    { kind: 'text', text: 'parcial' },
  ];
  const done = chatThread({ title: 'T', description: 'Escribe un resumen', status: 'review', result: 'Versión corta' }, events);
  assert.deepEqual(done.map((b) => [b.who, b.text]), [['me', 'Escribe un resumen'], ['agent', 'Primera respuesta'], ['me', 'Hazlo más corto'], ['agent', 'Versión corta']]);
  assert.equal(chatThread({ title: 'Solo título', status: 'running' }).at(-1).who, 'typing');
  assert.equal(chatThread({ title: 'Solo título', status: 'running' })[0].text, 'Solo título');
  assert.deepEqual(chatThread({ title: 'x', status: 'failed', error: 'boom' }).at(-1), { who: 'error', text: 'boom' });
});

test('bandeja: «leído» cambia cuando el agente vuelve a terminar; el color del agente es estable', () => {
  assert.notEqual(seenKey({ id: 1, finished_at: 'a' }), seenKey({ id: 1, finished_at: 'b' }));
  assert.equal(agentHue('devops'), agentHue('devops'));
  assert.ok(agentHue('devops') >= 0 && agentHue('devops') < 360);
});
