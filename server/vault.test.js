// Bóveda de secretos: el agente usa tokens y contraseñas sin verlos; tú puedes verlos y nada queda en los registros.
import './test-agents.js'; // primero: fija AGENTS_DIR antes de cargar config.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, expandCommand } from './vault.js';
import { runSsh } from './infra.js';
import { openDb } from './db.js';
import { createApp } from './index.js';
import { listAgents } from './registry.js';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-vault-'));
const envFile = join(tmp, '.env');
writeFileSync(envFile, '# prueba\n');
after(() => rmSync(tmp, { recursive: true, force: true }));
const TOKEN = "3|abc'def\"$x`y\\z";

test('expandCommand: el valor siempre queda como texto, esté sin comillas, entre \'…\' o entre "…"', () => {
  const get = (n) => (n === 'TK' ? TOKEN : null);
  const sh = (s) => s; // documentación: lo que verá la shell remota
  assert.equal(expandCommand('echo {{secreto:TK}}', get).script, sh(`echo '3|abc'\\''def"$x\`y\\z'`));
  assert.equal(expandCommand("echo 'K={{secreto:TK}}'", get).script, sh(`echo 'K=3|abc'\\''def"$x\`y\\z'`));
  assert.equal(expandCommand('echo "K={{secreto:TK}}"', get).script, sh('echo "K=3|abc\'def\\"\\$x\\`y\\\\z"'));
  const r = expandCommand('a {{secreto:NO}} {{secreto:TK}}', get);
  assert.deepEqual([r.missing, r.used], [['NO'], ['TK']]);
  assert.deepEqual(expandCommand('ls', get), { script: 'ls', missing: [], used: [] });
});

test('vault: guarda codificado en .env, lista solo nombres, tapa valores y captura NOMBRE_TOKEN=valor de lo que escribes', () => {
  const env = {};
  const v = createVault({ envFile, env });
  v.set('API_TOKEN', 'abcd1234');
  assert.match(readFileSync(envFile, 'utf8'), /^VAULT_API_TOKEN=b64:/m);
  assert.ok(!readFileSync(envFile, 'utf8').includes('abcd1234'), 'en el .env no queda en claro');
  assert.deepEqual(v.names(), ['API_TOKEN']);
  assert.equal(v.mask('Bearer abcd1234 ok'), 'Bearer {{secreto:API_TOKEN}} ok');
  assert.throws(() => v.set('minusculas', 'x'), /inválido/);
  assert.throws(() => v.set('X_TOKEN', 'a\nb'), /saltos/);

  const c = v.capture('en el .env pon esto\nSITRA_IPS_BASE_URL=https://x.example\nSITRA_IPS_TOKEN=3|6zqSecreto\nDB_PASSWORD="con comillas"\nTIMEOUT=15\nMI_TOKEN=<token>');
  assert.deepEqual(c.saved.map((s) => s.name), ['SITRA_IPS_TOKEN', 'DB_PASSWORD']);
  assert.equal(c.text, 'en el .env pon esto\nSITRA_IPS_BASE_URL=https://x.example\nSITRA_IPS_TOKEN={{secreto:SITRA_IPS_TOKEN}}\nDB_PASSWORD={{secreto:DB_PASSWORD}}\nTIMEOUT=15\nMI_TOKEN=<token>');
  assert.equal(v.get('DB_PASSWORD'), 'con comillas');
  v.remove('DB_PASSWORD');
  assert.equal(v.get('DB_PASSWORD'), null);
});

test('runSsh: con secretos el guion va por stdin, no en los argumentos', async () => {
  let seen; let input = '';
  const spawnFn = (cmd, args, opts) => {
    seen = { args, opts };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('finish', () => { child.stdout.end(); child.emit('close', 0); });
    return child;
  };
  await runSsh({ server: { host: 'h' }, command: 'exec sh -s', stdin: 'echo secreto\n', spawnFn });
  assert.equal(seen.opts.stdio[0], 'pipe');
  assert.ok(!seen.args.join(' ').includes('secreto'));
  assert.equal(input, 'echo secreto\n');
});

// ---------- API ----------
const hang = () => () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.stdout.end(); child.emit('close', 143); };
  return child;
};
const sshCalls = [];
const app = createApp({ db: openDb(':memory:'), envFile, runnerOpts: { spawnFn: hang() }, approvalWaitMs: 1500,
  runSshFn: async ({ command, stdin }) => {
    sshCalls.push({ command, stdin });
    if (command.startsWith('cat /srv/.env')) return { code: 0, stdout: 'DB_PASSWORD=MuySecreta99\n', stderr: '', timedOut: false };
    if (command.startsWith('printenv DB_PASSWORD')) return { code: 0, stdout: 'MuySecreta99\n', stderr: '', timedOut: false };
    return { code: 0, stdout: `eco: ${stdin ?? command} y abcd1234`, stderr: '', timedOut: false };
  } });
app.db.setSettings({ secrets_direct: 0 }); // estas pruebas son del modo Protegido; el Directo va al final
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
after(() => { app.runner.cancelAll(); app.server.close(); app.server.closeAllConnections?.(); for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_')) delete process.env[k]; });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };

test('API bóveda: guardar, listar sin valores, ver solo a pedido y borrar el valor de los registros', async () => {
  const agent = listAgents()[0].name;
  const t = (await call('POST', '/api/tasks', { title: 'Nota', agent })).body;
  app.db.addEvent(t.id, 'user', 'mi token es abcd1234'); // como pasó en la misión #2: el valor ya estaba escrito
  assert.equal((await call('PUT', '/api/vault/API_TOKEN', { value: 'abcd1234' })).status, 200);
  assert.ok(app.db.events(t.id).every((e) => !e.text.includes('abcd1234')), 'el valor desaparece del registro');
  assert.ok(app.db.events(t.id).some((e) => e.text.includes('{{secreto:API_TOKEN}}')));
  const list = (await call('GET', '/api/vault')).body;
  assert.deepEqual(list.map((x) => x.name), ['API_TOKEN']);
  assert.ok(!JSON.stringify(list).includes('abcd1234'), 'la lista no trae valores');
  assert.equal((await call('GET', '/api/vault/API_TOKEN/value')).body.value, 'abcd1234');
  assert.ok(app.db.auditLog(20).every((a) => !a.detail.includes('abcd1234')));
  assert.equal((await call('PUT', '/api/vault/mal', { value: 'x' })).status, 404); // nombre fuera del patrón: no es ruta de la bóveda

  const conDesc = (await call('POST', '/api/tasks', { title: 'Actualizar env', agent, description: 'pon esto\nOTRO_TOKEN=zzzz9999' })).body;
  assert.deepEqual(conDesc.vaulted, ['OTRO_TOKEN']);
  assert.equal(app.db.getTask(conDesc.id).description, 'pon esto\nOTRO_TOKEN={{secreto:OTRO_TOKEN}}');
  assert.equal((await call('DELETE', '/api/vault/OTRO_TOKEN')).status, 200);
});

test('/api/infra/exec con secretos: se usan sin verse, se revisan, y --solo-usuario / --guardar-secreto no llegan al modelo', async () => {
  const agent = listAgents()[0].name;
  assert.equal((await call('PUT', '/api/servers', { servers: [{ name: 'prod', host: '10.0.0.9', user: 'deploy', env: 'dev' }] })).status, 200);
  const t = (await call('POST', '/api/tasks', { title: 'Poner token', agent, project: 'srv:prod', mode: 'infra', engine: 'claude' })).body;
  assert.equal((await call('POST', `/api/tasks/${t.id}/run`, { confirm: true })).status, 202);
  const token = await waitFor(() => app.runner.infraToken(t.id));
  const exec = (command, extra = {}) => call('POST', '/api/infra/exec', { task_id: t.id, token, command, ...extra });

  const falta = await exec('printf %s {{secreto:NO_EXISTE}}');
  assert.equal(falta.status, 400); assert.match(falta.body.error, /NO_EXISTE.*Disponibles: API_TOKEN/);

  // usar un secreto siempre pasa por tu revisión: aquí se rechaza por tiempo y no se ejecuta
  const n0 = sshCalls.length;
  const espera = await exec("printf '%s\\n' API_TOKEN={{secreto:API_TOKEN}} >> /tmp/x.env");
  assert.equal(espera.body.denied, true);
  assert.equal(sshCalls.length, n0);
  const ap = app.db.auditLog(50).find((a) => a.action === 'infra.ask');
  assert.match(ap.detail, /\{\{secreto:API_TOKEN\}\}/);

  await call('POST', `/api/tasks/${t.id}/allow-all`, { enabled: true });
  const r = await exec("printf '%s\\n' API_TOKEN={{secreto:API_TOKEN}} >> /tmp/x.env");
  assert.equal(r.status, 200);
  const last = sshCalls.at(-1);
  assert.equal(last.command, 'exec "${SHELL:-/bin/sh}" -s', 'en la línea de comandos no va el secreto');
  assert.equal(last.stdin, "printf '%s\\n' API_TOKEN='abcd1234' >> /tmp/x.env\n");
  assert.ok(!r.body.stdout.includes('abcd1234'), 'la salida que vuelve al modelo lo tapa');
  assert.match(r.body.stdout, /\{\{secreto:API_TOKEN\}\}/);

  const solo = await exec('cat /srv/.env', { output: 'user' });
  assert.equal(solo.body.stdout, '');
  assert.match(solo.body.note, /solo al usuario/);
  const priv = app.db.events(t.id).find((e) => e.kind === 'private');
  assert.equal(priv.text, 'DB_PASSWORD=MuySecreta99', 'tú sí lo ves en el registro');

  const g = await exec('printenv DB_PASSWORD', { output: 'secret', secret_name: 'DB_PASSWORD' });
  assert.equal(g.body.ok, true);
  assert.ok(!JSON.stringify(g.body).includes('MuySecreta99'));
  assert.equal((await call('GET', '/api/vault/DB_PASSWORD/value')).body.value, 'MuySecreta99');
  assert.equal(app.db.events(t.id).find((e) => e.kind === 'private').text, 'DB_PASSWORD={{secreto:DB_PASSWORD}}', 'al guardarlo se limpia también de los registros');
  assert.equal((await exec('printenv DB_PASSWORD', { output: 'secret', secret_name: 'DB_PASSWORD' })).status, 409, 'no pisa un secreto existente');

  const visibles = app.db.events(t.id).filter((e) => e.kind !== 'private').map((e) => e.text).join('\n');
  assert.ok(!visibles.includes('abcd1234') && !visibles.includes('MuySecreta99'), 'ningún valor en el registro');
});

test('modo Directo (por defecto): lo que escribes llega tal cual, el agente lee y muestra .env sin trabas ni tapar valores', async () => {
  assert.equal(openDb(':memory:').settings().secrets_direct, 1, 'Directo es el valor por defecto');
  assert.throws(() => app.db.setSettings({ secrets_direct: 2 }), /0 o 1/);
  app.db.setSettings({ secrets_direct: 1 });
  try {
    const agent = listAgents()[0].name;
    const t = (await call('POST', '/api/tasks', { title: 'Token directo', agent, project: 'srv:prod', mode: 'infra', engine: 'claude', description: 'pon esto\nNUEVO_TOKEN=valor-visible-77' })).body;
    assert.equal(t.vaulted, undefined);
    assert.equal(app.db.getTask(t.id).description, 'pon esto\nNUEVO_TOKEN=valor-visible-77', 'no se reemplaza por marcador');
    assert.equal((await call('GET', '/api/vault')).body.some((s) => s.name === 'NUEVO_TOKEN'), false);
    assert.equal((await call('POST', `/api/tasks/${t.id}/run`, { confirm: true })).status, 202);
    const token = await waitFor(() => app.runner.infraToken(t.id));
    const n0 = sshCalls.length;
    const r = await call('POST', '/api/infra/exec', { task_id: t.id, token, command: 'cat /srv/.env' });
    assert.equal(sshCalls.length, n0 + 1, 'leer un .env es lectura normal: no espera aprobación');
    assert.equal(r.body.stdout, 'DB_PASSWORD=MuySecreta99\n', 'el agente ve el valor para poder mostrártelo');
    const r2 = await call('POST', '/api/infra/exec', { task_id: t.id, token, command: 'echo abcd1234' });
    assert.match(r2.body.stdout, /abcd1234/, 'tampoco se tapan los valores guardados');
  } finally { app.db.setSettings({ secrets_direct: 0 }); }
});
