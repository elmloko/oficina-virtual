// Modo infraestructura: clasificación de comandos, aprobación de lo fuerte y ejecución por SSH.
import './test-agents.js'; // primero: fija AGENTS_DIR antes de cargar config.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { classify, needsApproval, runSsh } from './infra.js';
import { openDb } from './db.js';
import { createApp } from './index.js';
import { listAgents } from './registry.js';

const tier = (c) => classify(c).tier;

test('classify: lectura corre sola; lo que modifica o no se reconoce se pregunta', () => {
  for (const c of ['ls -la /var/log', 'tail -n 50 /var/log/nginx/error.log | grep error', 'df -h && free -m', 'systemctl status nginx', 'docker ps -a', 'docker logs app --tail 100',
    'curl -sI https://example.com', 'journalctl -u nginx -n 100 --no-pager', 'sed -n 1,5p archivo', 'ps aux | awk \'{print $1}\'', 'find /var -name "*.log"', 'nginx -t', 'echo hola 2>&1', 'ls > /dev/null',
    'git log --oneline -5', 'kubectl get pods', 'iptables -L', 'ip addr show']) assert.equal(tier(c), 'read', c);
  for (const c of ['systemctl reload nginx', 'mkdir /tmp/x', 'git pull', 'touch /tmp/a']) assert.equal(tier(c), 'mild', c);
  for (const c of ['rm -rf /tmp/x', 'systemctl restart nginx', 'docker rm app', 'cat /etc/hosts > /tmp/a', 'ls $(whoami)', 'curl -X POST https://x', 'curl -s -o /tmp/a https://x', 'sudo ls', 'sed -i s/a/b/ f',
    'find / -name x -delete', 'apt-get install foo', 'FOO=1 ls', 'ls; reboot', 'iptables -F', 'mysql -e "select 1"', 'terraform apply', 'cp -r a b', 'git reset --hard', 'awk \'BEGIN{system("ls")}\'',
    'cat /var/www/app/.env', 'ls\nrm x', 'ls `whoami`', 'comando-desconocido']) assert.equal(tier(c), 'strong', c);
});

test('classify: lo destructivo se marca como crítico; encadenar no esquiva la revisión', () => {
  for (const c of ['rm -rf /var/www', 'ls; reboot', 'docker system prune -af', 'git push --force', 'DROP TABLE users', 'dd if=/dev/zero of=/dev/sda']) assert.equal(classify(c).critical, true, c);
  assert.equal(classify('systemctl status x && rm y').tier, 'strong');
  assert.equal(classify('ls | tee /tmp/x').tier, 'strong'); // tee no está en la lista
  assert.equal(classify('').tier, 'strong');
  assert.equal(classify('a'.repeat(3000)).tier, 'strong');
});

test('needsApproval: lo fuerte siempre; lo leve solo en producción; la lectura nunca', () => {
  assert.equal(needsApproval('read', 'prod'), false);
  assert.equal(needsApproval('mild', 'prod'), true);
  assert.equal(needsApproval('mild', 'dev'), false);
  assert.equal(needsApproval('strong', 'dev'), true);
});

test('runSsh: usa BatchMode, `--` antes del destino y nunca shell local; recorta la salida', async () => {
  let seen;
  const spawnFn = (cmd, args) => {
    seen = { cmd, args };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setTimeout(() => { child.stdout.write('x'.repeat(100_000)); child.stdout.end(); child.emit('close', 0); }, 5);
    return child;
  };
  const r = await runSsh({ server: { host: 'h.example', user: 'deploy', port: 2222 }, command: 'uptime', spawnFn });
  assert.equal(seen.cmd, 'ssh');
  assert.deepEqual(seen.args.slice(0, 2), ['-o', 'BatchMode=yes']);
  assert.deepEqual(seen.args.slice(-3), ['--', 'deploy@h.example', 'uptime']);
  assert.ok(seen.args.includes('2222'));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /salida cortada/);
  assert.ok(r.stdout.length < 31_000);
  const sin = await runSsh({ server: { host: 'h' }, command: 'x', spawnFn: () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); setTimeout(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })), 1); return c; } });
  assert.match(sin.stderr, /No se encontró «ssh»/);
});

// ---------- endpoint: token, aprobación y ejecución ----------
const hang = () => { // `claude` falso que se queda esperando: la misión sigue «en curso» mientras probamos
  const spawnFn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.stdout.end(); child.emit('close', 143); };
    return child;
  };
  return spawnFn;
};
const sshCalls = [];
const app = createApp({ db: openDb(':memory:'), runnerOpts: { spawnFn: hang() }, approvalWaitMs: 1500,
  runSshFn: async ({ server, command }) => { sshCalls.push({ server: server.name, command }); return { code: 0, stdout: `ok: ${command}`, stderr: '', timedOut: false }; } });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
after(() => { app.runner.cancelAll(); app.server.close(); app.server.closeAllConnections?.(); });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };

test('/api/infra/exec: solo la misión en curso, lectura al instante, lo fuerte espera tu aprobación', async () => {
  const agent = listAgents()[0].name;
  assert.equal((await call('PUT', '/api/servers', { servers: [{ name: 'web', host: '10.0.0.5', user: 'deploy', env: 'dev' }, { name: 'bad', host: '-oProxyCommand=x' }] })).status, 400); // sin inyección de opciones ssh
  assert.equal((await call('PUT', '/api/servers', { servers: [{ name: 'web', host: '10.0.0.5', user: 'deploy', env: 'dev' }] })).status, 200);
  const t = (await call('POST', '/api/tasks', { title: 'Revisar web', agent, project: 'srv:web', mode: 'infra', engine: 'claude' })).body;
  assert.equal((await call('POST', `/api/tasks/${t.id}/run`, { confirm: true })).status, 202);
  const token = await waitFor(() => app.runner.infraToken(t.id));
  const exec = (command, tok = token) => call('POST', '/api/infra/exec', { task_id: t.id, token: tok, command });

  assert.equal((await exec('ls', 'malo')).status, 403); // token falso
  assert.equal((await call('POST', '/api/infra/exec', { task_id: 9999, token, command: 'ls' })).status, 403);

  const lectura = await exec('df -h');
  assert.equal(lectura.status, 200); assert.match(lectura.body.stdout, /ok: df -h/);
  assert.equal((await call('GET', '/api/approvals')).body.length, 0); // no preguntó nada

  const leve = await exec('mkdir /tmp/x'); // en un servidor de desarrollo lo leve corre solo
  assert.match(leve.body.stdout, /ok: mkdir/);

  // lo fuerte: queda pendiente hasta que lo apruebes
  const pendiente = exec('systemctl restart nginx');
  const ap = await waitFor(async () => (await call('GET', '/api/approvals')).body[0]);
  assert.equal(ap.command, 'systemctl restart nginx'); assert.equal(ap.critical, 1);
  assert.equal(sshCalls.some((c) => c.command.includes('restart')), false); // aún no se ejecutó
  assert.equal((await call('POST', `/api/approvals/${ap.id}/approve`)).body.status, 'approved');
  const r1 = await pendiente;
  assert.match(r1.body.stdout, /ok: systemctl restart/);
  assert.equal((await call('POST', `/api/approvals/${ap.id}/approve`)).status, 409); // ya decidido

  // rechazado: no se ejecuta
  const p2 = exec('rm -rf /tmp/x');
  const ap2 = await waitFor(async () => (await call('GET', '/api/approvals')).body[0]);
  await call('POST', `/api/approvals/${ap2.id}/deny`);
  const r2 = await p2;
  assert.equal(r2.body.denied, true);
  assert.equal(sshCalls.some((c) => c.command.includes('rm -rf')), false);

  // sin respuesta a tiempo: caduca y no se ejecuta
  const r3 = await exec('docker rm app');
  assert.equal(r3.body.denied, true); assert.match(r3.body.note, /a tiempo/);
  assert.equal(sshCalls.some((c) => c.command.includes('docker rm')), false);

  // cancelar la misión mientras espera: tampoco se ejecuta
  const p4 = exec('reboot');
  await waitFor(async () => (await call('GET', '/api/approvals')).body[0]);
  app.runner.cancel(t.id);
  assert.equal((await p4).body.denied, true);
  assert.equal(sshCalls.some((c) => c.command === 'reboot'), false);
  assert.equal((await exec('ls')).status, 403); // sin misión en curso, el token ya no vale
  const audit = app.db.audit ? true : false; assert.ok(audit);
});

test('En producción hasta lo leve se pregunta', async () => {
  const agent = listAgents()[0].name;
  await call('PUT', '/api/servers', { servers: [{ name: 'prod', host: '10.0.0.9', env: 'prod' }] });
  const t = (await call('POST', '/api/tasks', { title: 'Producción', agent, project: 'srv:prod', mode: 'infra', engine: 'claude' })).body;
  await call('POST', `/api/tasks/${t.id}/run`, { confirm: true });
  const token = await waitFor(() => app.runner.infraToken(t.id));
  const p = call('POST', '/api/infra/exec', { task_id: t.id, token, command: 'mkdir /tmp/y' });
  const ap = await waitFor(async () => (await call('GET', '/api/approvals')).body[0]);
  assert.equal(ap.tier, 'mild');
  await call('POST', `/api/approvals/${ap.id}/deny`);
  assert.equal((await p).body.denied, true);
  app.runner.cancel(t.id);
});

test('Modo infraestructura con Claude exige un servidor de destino (si no, solo sería un plan)', async () => {
  const agent = listAgents()[0].name;
  const sin = await call('POST', '/api/tasks', { title: 'Docker', agent, mode: 'infra', engine: 'claude' });
  assert.equal(sin.status, 400); assert.match(sin.body.error, /elige uno en «Proyecto»/);
  assert.equal((await call('POST', '/api/tasks', { title: 'Docker', agent, mode: 'infra' })).status, 400); // auto también
  assert.equal((await call('POST', '/api/tasks', { title: 'Docker', agent, mode: 'infra', engine: 'ollama' })).status, 201); // otro motor: plan
});

// ---------- contraseña guardada: cliente SSH propio, huella fijada y nada de secretos hacia el modelo ----------
import { runSsh2, passVar, encodePass, decodePass } from './infra.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('runSsh2: usa la contraseña, fija la huella la primera vez y se niega si cambia', async () => {
  const mk = (behaviour) => class FakeClient extends EventEmitter {
    connect(cfg) {
      this.cfg = cfg; FakeClient.last = this;
      setTimeout(() => {
        if (!cfg.hostVerifier(Buffer.from('clave-publica-del-servidor'))) return this.emit('error', new Error('Handshake failed: signature verification failed'));
        if (behaviour === 'badpass') return this.emit('error', new Error('All configured authentication methods failed'));
        this.emit('ready');
      }, 2);
    }
    exec(cmd, cb) { const s = new EventEmitter(); s.stderr = new EventEmitter(); cb(null, s); setTimeout(() => { s.emit('data', `salida de ${cmd}`); s.emit('close', 0); }, 2); }
    end() {}
  };
  let pinned = null;
  const C1 = mk('ok');
  const r = await runSsh2({ server: { host: 'h', user: 'u', port: 22 }, command: 'uptime', password: 'p4ss word', onPin: (fp) => { pinned = fp; }, ClientCtor: C1 });
  assert.equal(r.code, 0); assert.equal(r.stdout, 'salida de uptime');
  assert.equal(C1.last.cfg.password, 'p4ss word');
  assert.match(pinned, /^SHA256:/);
  // misma huella: conecta; huella distinta: no
  assert.equal((await runSsh2({ server: { host: 'h' }, command: 'x', password: 'p', pinned, ClientCtor: mk('ok') })).code, 0);
  const mal = await runSsh2({ server: { host: 'h' }, command: 'x', password: 'p', pinned: 'SHA256:otra', ClientCtor: mk('ok') });
  assert.equal(mal.code, -1); assert.match(mal.stderr, /huella del servidor cambió/);
  const bad = await runSsh2({ server: { host: 'h' }, command: 'x', password: 'p', ClientCtor: mk('badpass') });
  assert.match(bad.stderr, /Usuario o contraseña incorrectos/);
});

test('contraseña de servidor: se guarda codificada en .env, nunca se devuelve y se usa solo para conectar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oficina-pw-'));
  const envFile = join(dir, '.env');
  const calls2 = [];
  const app2 = createApp({ db: openDb(':memory:'), runnerOpts: { spawnFn: hang() }, envFile, approvalWaitMs: 500,
    runSsh2Fn: async (o) => { calls2.push(o); o.onPin?.('SHA256:abc'); return { code: 0, stdout: 'ok-pw', stderr: '', timedOut: false }; } });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${app2.server.address().port}`;
  const c2 = async (method, path, body) => { const res = await fetch(b2 + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
  try {
    await c2('PUT', '/api/servers', { servers: [{ name: 'pw-web', host: '10.1.1.1', user: 'root', env: 'dev' }] });
    assert.equal((await c2('PUT', '/api/servers/otro/password', { password: 'x' })).status, 404);
    assert.equal((await c2('PUT', '/api/servers/pw-web/password', { password: 'con\nsalto' })).status, 400);
    assert.equal((await c2('PUT', '/api/servers/pw-web/password', { password: 'Secreto con espacios!' })).body.has_password, true);
    const env = readFileSync(envFile, 'utf8');
    assert.ok(env.includes(`${passVar('pw-web')}=b64:`)); assert.ok(!env.includes('Secreto')); // codificada, no en claro
    assert.equal(decodePass(encodePass('Secreto con espacios!')), 'Secreto con espacios!');
    const state = JSON.stringify((await c2('GET', '/api/state')).body) + JSON.stringify((await c2('GET', '/api/servers')).body);
    assert.ok(!state.includes('Secreto') && !state.includes('b64:')); // la web solo sabe que existe
    assert.equal((await c2('GET', '/api/servers')).body[0].has_password, true);

    const agent = listAgents()[0].name;
    const t = (await c2('POST', '/api/tasks', { title: 'x', agent, project: 'srv:pw-web', mode: 'infra', engine: 'claude' })).body;
    await c2('POST', `/api/tasks/${t.id}/run`, { confirm: true });
    const token = await waitFor(() => app2.runner.infraToken(t.id));
    const r = await c2('POST', '/api/infra/exec', { task_id: t.id, token, command: 'df -h' });
    assert.match(r.body.stdout, /ok-pw/);
    assert.equal(calls2[0].password, 'Secreto con espacios!'); // solo la usa el conector
    assert.equal((await c2('GET', '/api/servers')).body[0].hostkey, 'SHA256:abc'); // huella fijada
    assert.ok(!JSON.stringify(app2.db.events(t.id)).includes('Secreto')); // ni en el historial de la misión
    // cambiar el host invalida la huella; quitar el servidor borra la contraseña
    await c2('PUT', '/api/servers', { servers: [{ name: 'pw-web', host: '10.1.1.2', user: 'root', env: 'dev' }] });
    assert.equal((await c2('GET', '/api/servers')).body[0].hostkey, undefined);
    app2.runner.cancel(t.id);
    await c2('PUT', '/api/servers', { servers: [] });
    assert.ok(!readFileSync(envFile, 'utf8').includes(passVar('pw-web')));
  } finally { app2.runner.cancelAll(); app2.server.close(); app2.server.closeAllConnections?.(); rmSync(dir, { recursive: true, force: true }); delete process.env[passVar('pw-web')]; }
});
