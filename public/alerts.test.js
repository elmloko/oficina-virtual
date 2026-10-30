import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from './alerts.js';

// Notification falsa: registra cada notificación creada
function fakeNotify(permission) {
  const made = [];
  class N { constructor(title, opts) { this.title = title; this.opts = opts; made.push(this); } close() {} }
  N.permission = permission;
  N.requestPermission = async () => { N.permission = 'granted'; return 'granted'; };
  return { N, made };
}
const withDom = async (hidden, fn) => {
  globalThis.document = { hidden };
  globalThis.window = { focus() {} };
  try { return await fn(); } finally { delete globalThis.document; delete globalThis.window; }
};
const task = { id: 7, title: 'Auditar permisos', agent: 'security', kind: 'task' };

test('avisos desactivados: no hacen nada', () => withDom(true, () => {
  const { N, made } = fakeNotify('granted');
  const a = createAlerts({ skinId: () => 'imperio', notify: N });
  assert.equal(a.enabled, false);
  assert.equal(a.fire({ kind: 'done', task }), false);
  assert.equal(made.length, 0);
}));

test('avisos activados: notifican con la pestaña oculta y no cuando está a la vista', () => withDom(true, () => {
  const { N, made } = fakeNotify('granted');
  const a = createAlerts({ skinId: () => 'sith', notify: N });
  a.setEnabled(true);
  assert.equal(a.fire({ kind: 'question', task }), true);
  assert.equal(made.length, 1);
  assert.match(made[0].title, /pregunta.*security/i);
  assert.equal(made[0].opts.body, '#7 Auditar permisos');
  assert.equal(made[0].opts.tag, 'task-7'); // un aviso por misión, no se apilan

  globalThis.document.hidden = false;
  assert.equal(a.fire({ kind: 'done', task }), true); // suena, pero sin notificación de escritorio
  assert.equal(made.length, 1);
}));

test('sin permiso o sin soporte de notificaciones no revienta y la petición de permiso es aparte', async () => {
  await withDom(true, async () => {
    const { N, made } = fakeNotify('default');
    const a = createAlerts({ skinId: () => 'clasico', notify: N });
    a.setEnabled(true);
    assert.equal(a.fire({ kind: 'failed', task }), true);
    assert.equal(made.length, 0); // permiso aún no concedido
    assert.equal(await a.ensurePermission(), 'granted');
    a.fire({ kind: 'failed', task });
    assert.equal(made.length, 1);

    const none = createAlerts({ skinId: () => 'clasico', notify: null });
    none.setEnabled(true);
    assert.equal(none.fire({ kind: 'done', task }), true);
    assert.equal(await none.ensurePermission(), 'unsupported');
  });
});
