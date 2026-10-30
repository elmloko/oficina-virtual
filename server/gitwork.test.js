// Misiones que editan: copia aislada en rama git, diff, aplicar, conflictos, descartar y cancelar. Usa git real en carpetas temporales.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasGit = spawnSync('git', ['--version']).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'oficina-git-'));
const htdocs = join(tmp, 'htdocs');
const agentsDir = join(tmp, 'agents');
const worktrees = join(tmp, 'worktrees');
mkdirSync(agentsDir); mkdirSync(htdocs);
for (const a of ['backend', 'reviewer']) writeFileSync(join(agentsDir, `${a}.md`), `---\nname: ${a}\ndescription: "Agente ${a}"\n---\ncuerpo\n`);
process.env.HTDOCS_ROOT = htdocs;
process.env.EXTRA_ROOTS = '';
process.env.AGENTS_DIR = agentsDir;
process.env.WORKTREES_DIR = worktrees;

const { openDb } = await import('./db.js');
const { createRunner } = await import('./runner.js');
const { createApp } = await import('./index.js');
const { listAgents, listProjects } = await import('./registry.js');
const registry = { listAgents, listProjects };

const rd = (f) => readFileSync(f, 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)); // git en Windows puede convertir a CRLF
const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const repoDir = join(htdocs, 'proj');
const plainDir = join(htdocs, 'plano');
const waitFor = async (fn, ms = 20000) => { // git en Windows es lento si corre junto a otros tests
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('timeout esperando condición');
};

before(() => {
  if (!hasGit) return;
  mkdirSync(repoDir);
  G(repoDir, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'a.txt'), 'uno\ndos\ntres\n');
  G(repoDir, 'add', '-A'); G(repoDir, 'commit', '-q', '-m', 'inicial');
  mkdirSync(plainDir);
  writeFileSync(join(plainDir, 'composer.json'), '{}'); // proyecto sin git
  mkdirSync(join(plainDir, '.git')); // carpeta .git vacía: no es un repo válido ni tiene commits
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** `claude` falso que edita archivos en su cwd. hang: deja el proceso vivo (para cancelar). */
function editingClaude(edit, { hang = false } = {}) {
  const calls = [];
  const spawnFn = (_cmd, _args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const call = { cwd: opts.cwd, input: '' }; calls.push(call);
    let timer;
    child.stdin.on('data', (d) => { call.input += d; });
    child.kill = () => { clearTimeout(timer); child.stdout.end(); child.emit('close', 143); };
    child.stdin.on('end', () => {
      edit(opts.cwd);
      if (hang) return;
      timer = setTimeout(() => {
        child.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'hecho', total_cost_usd: 0.01 }) + '\n');
        child.stdout.end(); child.emit('close', 0);
      }, 10);
    });
    return child;
  };
  return { spawnFn, calls };
}
const editFiles = (cwd) => {
  writeFileSync(join(cwd, 'a.txt'), 'uno\nDOS EDITADO\ntres\n');
  writeFileSync(join(cwd, 'nuevo.txt'), 'archivo nuevo\n');
};

let app; let base; let calls;
before(async () => {
  if (!hasGit) return;
  const f = editingClaude(editFiles);
  calls = f.calls;
  app = createApp({ db: openDb(':memory:'), runnerOpts: { spawnFn: f.spawnFn } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app?.server.close(); app?.server.closeAllConnections?.(); });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const edit = async (title) => {
  const t = (await call('POST', '/api/tasks', { title, agent: 'backend', project: 'proj', mode: 'edit', engine: 'claude' })).body;
  assert.equal((await call('POST', `/api/tasks/${t.id}/run`, { confirm: true })).status, 202);
  await waitFor(() => app.db.getTask(t.id).status === 'review');
  return app.db.getTask(t.id);
};
const opts = { skip: !hasGit && 'git no está instalado' };

test('una misión que edita trabaja en una rama aislada y el proyecto real no cambia', opts, async () => {
  const head = G(repoDir, 'rev-parse', 'HEAD');
  const t = await edit('Corregir línea dos');
  assert.equal(t.branch, `oficina/m${t.id}`);
  assert.equal(t.change_state, 'pending');
  assert.equal(t.base_sha, head);
  assert.ok(calls.at(-1).cwd.startsWith(worktrees), 'el agente trabajó fuera del proyecto');
  assert.notEqual(calls.at(-1).cwd, repoDir);
  assert.equal(rd(join(repoDir, 'a.txt')), 'uno\ndos\ntres\n'); // intacto
  assert.ok(!existsSync(join(repoDir, 'nuevo.txt')));
  assert.equal(G(repoDir, 'rev-parse', 'HEAD'), head);
  assert.equal(G(repoDir, 'status', '--porcelain'), '');

  const c = (await call('GET', `/api/tasks/${t.id}/changes`)).body;
  assert.equal(c.state, 'pending');
  assert.deepEqual(c.files.map((f) => [f.path, f.status, f.additions, f.deletions]).sort(), [['a.txt', 'M', 1, 1], ['nuevo.txt', 'A', 1, 0]]);
  assert.match(c.patch, /\+DOS EDITADO/);
  assert.match(c.patch, /\+archivo nuevo/);
  assert.ok(app.db.events(t.id).some((e) => /rama oficina\/m\d+/.test(e.text)));
});

test('aplicar y descartar exigen confirmación; aplicar une la rama al proyecto y limpia', opts, async () => {
  const t = await edit('Aplicar esto');
  for (const act of ['apply', 'discard']) {
    const sin = await call('POST', `/api/tasks/${t.id}/${act}`, {});
    assert.equal(sin.status, 409); assert.equal(sin.body.needsConfirm, true);
  }
  assert.equal(rd(join(repoDir, 'a.txt')), 'uno\ndos\ntres\n');

  // cambios sin guardar en el proyecto: se rechaza y no se toca nada
  writeFileSync(join(repoDir, 'a.txt'), 'uno\ndos\ntres\ncuatro\n');
  const dirty = await call('POST', `/api/tasks/${t.id}/apply`, { confirm: true });
  assert.equal(dirty.status, 409); assert.equal(dirty.body.reason, 'dirty');
  assert.equal(app.db.getTask(t.id).change_state, 'pending');
  G(repoDir, 'checkout', '--', 'a.txt');

  const r = await call('POST', `/api/tasks/${t.id}/apply`, { confirm: true });
  assert.equal(r.status, 200);
  assert.equal(rd(join(repoDir, 'a.txt')), 'uno\nDOS EDITADO\ntres\n');
  assert.ok(existsSync(join(repoDir, 'nuevo.txt')));
  const after = app.db.getTask(t.id);
  assert.equal(after.change_state, 'applied'); assert.equal(after.status, 'done'); assert.equal(after.worktree, null);
  assert.ok(!existsSync(join(worktrees, String(t.id))), 'la copia aislada se borra');
  assert.equal(G(repoDir, 'branch', '--list', `oficina/m${t.id}`), '');
  assert.match(G(repoDir, 'log', '-1', '--format=%s'), new RegExp(`Misión #${t.id}`)); // commit de merge
  assert.ok(app.db.auditLog(50).some((a) => a.action === 'task.apply' && a.task_id === t.id));
  assert.equal((await call('POST', `/api/tasks/${t.id}/apply`, { confirm: true })).status, 409); // ya no hay nada pendiente
  G(repoDir, 'reset', '-q', '--hard', 'HEAD~1'); G(repoDir, 'clean', '-fdq'); // deja el repo como al inicio
});

test('descartar elimina la rama y la copia sin tocar el proyecto', opts, async () => {
  const head = G(repoDir, 'rev-parse', 'HEAD');
  const t = await edit('Descartar esto');
  const wt = join(worktrees, String(t.id));
  assert.ok(existsSync(wt));
  assert.equal((await call('POST', `/api/tasks/${t.id}/discard`, { confirm: true })).status, 200);
  assert.ok(!existsSync(wt));
  assert.equal(G(repoDir, 'branch', '--list', `oficina/m${t.id}`), '');
  assert.equal(app.db.getTask(t.id).change_state, 'discarded');
  assert.equal(G(repoDir, 'rev-parse', 'HEAD'), head);
  assert.equal(rd(join(repoDir, 'a.txt')), 'uno\ndos\ntres\n');
});

test('un conflicto al aplicar deshace el merge y deja todo como estaba', opts, async () => {
  const t = await edit('Va a chocar');
  writeFileSync(join(repoDir, 'a.txt'), 'uno\nDOS DISTINTO\ntres\n'); // el usuario cambia la misma línea y la guarda
  G(repoDir, 'commit', '-q', '-am', 'cambio del usuario');
  const r = await call('POST', `/api/tasks/${t.id}/apply`, { confirm: true });
  assert.equal(r.status, 409); assert.equal(r.body.reason, 'conflict');
  assert.equal(G(repoDir, 'status', '--porcelain'), ''); // merge abortado: sin marcas de conflicto
  assert.equal(rd(join(repoDir, 'a.txt')), 'uno\nDOS DISTINTO\ntres\n');
  assert.equal(app.db.getTask(t.id).change_state, 'pending'); // se puede resolver o descartar
  await call('POST', `/api/tasks/${t.id}/discard`, { confirm: true });
  G(repoDir, 'reset', '-q', '--hard', 'HEAD~1');
});

test('borrar una misión con cambios pendientes también elimina su rama y su copia', opts, async () => {
  const t = await edit('Se borra');
  const wt = join(worktrees, String(t.id));
  assert.ok(existsSync(wt));
  assert.equal((await call('DELETE', `/api/tasks/${t.id}`)).status, 200);
  assert.ok(!existsSync(wt));
  assert.equal(G(repoDir, 'branch', '--list', `oficina/m${t.id}`), '');
});

test('si la misión no modificó nada, no queda rama ni copia', opts, async () => {
  const db = openDb(':memory:');
  const f = editingClaude(() => {});
  const runner = createRunner(db, () => {}, { spawnFn: f.spawnFn, registry });
  const t = db.createTask({ title: 'No toca nada', agent: 'backend', project: 'proj', mode: 'edit', engine: 'claude' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  const done = db.getTask(t.id);
  assert.equal(done.change_state, null); assert.equal(done.branch, null);
  assert.ok(!existsSync(join(worktrees, String(t.id))));
  assert.equal(G(repoDir, 'branch', '--list', `oficina/m${t.id}`), '');
  assert.ok(db.events(t.id).some((e) => /no modificó archivos/.test(e.text)));
  db.raw.close();
});

test('cancelar una edición a medias descarta lo escrito en la copia', opts, async () => {
  const db = openDb(':memory:');
  const f = editingClaude((cwd) => writeFileSync(join(cwd, 'a-medias.txt'), 'parcial'), { hang: true });
  const runner = createRunner(db, () => {}, { spawnFn: f.spawnFn, registry });
  const t = db.createTask({ title: 'Se cancela', agent: 'backend', project: 'proj', mode: 'edit', engine: 'claude' });
  runner.enqueue(t.id);
  await waitFor(() => existsSync(join(worktrees, String(t.id), 'a-medias.txt')));
  runner.cancel(t.id);
  await waitFor(() => !existsSync(join(worktrees, String(t.id), 'a-medias.txt'))); // reset de la copia
  assert.equal(db.getTask(t.id).status, 'backlog');
  assert.equal(G(repoDir, 'status', '--porcelain'), ''); // y el proyecto real jamás se tocó
  await new Promise((r) => setTimeout(r, 100));
  await runner.discardChanges(t.id);
  db.raw.close();
});

test('un proyecto sin git (o sin commits) se edita en su sitio, avisándolo', opts, async () => {
  const db = openDb(':memory:');
  const f = editingClaude((cwd) => writeFileSync(join(cwd, 'tocado.txt'), 'x'));
  const runner = createRunner(db, () => {}, { spawnFn: f.spawnFn, registry });
  const t = db.createTask({ title: 'Sin git', agent: 'backend', project: 'plano', mode: 'edit', engine: 'claude' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(f.calls[0].cwd, plainDir);
  assert.ok(existsSync(join(plainDir, 'tocado.txt')));
  assert.equal(db.getTask(t.id).branch, null);
  assert.ok(db.events(t.id).some((e) => /no se podrá revertir/.test(e.text)));
  db.raw.close();
});

test('una misión de solo lectura no crea copias ni ramas', opts, async () => {
  const db = openDb(':memory:');
  const f = editingClaude(() => {});
  const runner = createRunner(db, () => {}, { spawnFn: f.spawnFn, registry });
  const t = db.createTask({ title: 'Solo mirar', agent: 'backend', project: 'proj', mode: 'read', engine: 'claude' });
  runner.enqueue(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  assert.equal(f.calls[0].cwd, repoDir);
  assert.equal(db.getTask(t.id).worktree, null);
  db.raw.close();
});
