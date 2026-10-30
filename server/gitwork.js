// Aislamiento de misiones que editan archivos: cada una trabaja en su propio git worktree (rama oficina/m<id>),
// fuera del proyecto. El proyecto real solo cambia cuando el usuario aplica los cambios (merge con confirmación).
// Todo se ejecuta con spawn y argumentos (sin shell); las rutas y ramas salen de ids numéricos y de resolveProject.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_LIMIT = 150_000;
const IDENT = ['-c', 'user.name=Oficina Virtual', '-c', 'user.email=oficina@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=off'];

export const branchFor = (id) => `oficina/m${Number(id)}`;

/** Ejecuta git y devuelve { code, stdout, stderr }; nunca rechaza salvo que git no exista. */
export function git(cwd, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...IDENT, ...args], { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`No se pudo ejecutar git: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const ok = async (cwd, args) => { const r = await git(cwd, args); if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} falló`); return r.stdout.trim(); };

/** ¿Se puede aislar? Necesita un repositorio con al menos un commit. */
export async function canIsolate(repo) {
  if (!existsSync(join(repo, '.git'))) return false;
  try { return (await git(repo, ['rev-parse', '--verify', 'HEAD'])).code === 0; } catch { return false; }
}

/** Crea (o reutiliza) la copia aislada de la misión. Devuelve { path, branch, base, reused }. */
export async function createWorktree({ repo, id, root }) {
  const path = join(root, String(Number(id)));
  const branch = branchFor(id);
  if (existsSync(path)) return { path, branch, base: await ok(path, ['merge-base', 'HEAD', branch]).catch(() => null), reused: true };
  const base = await ok(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['worktree', 'prune']);
  let r = await git(repo, ['worktree', 'add', '-b', branch, path, base]);
  if (r.code !== 0) r = await git(repo, ['worktree', 'add', path, branch]); // la rama quedó de un intento anterior
  if (r.code !== 0) throw new Error(`No se pudo crear la copia aislada: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  return { path, branch, base, reused: false };
}

/** Guarda en un commit todo lo editado en la copia aislada. Devuelve { changed }. */
export async function commitAll(wt, message) {
  await ok(wt, ['add', '-A']);
  const quiet = await git(wt, ['diff', '--cached', '--quiet']);
  if (quiet.code === 0) return { changed: false };
  await ok(wt, ['commit', '-q', '-m', message.slice(0, 200)]);
  return { changed: true };
}

/** Descarta lo editado sin guardar (tras cancelar una ejecución): vuelve al último commit de la rama. */
export async function reset(wt) {
  if (!existsSync(wt)) return;
  await git(wt, ['reset', '--hard', 'HEAD']);
  await git(wt, ['clean', '-fd']);
}

/** Cambios de la misión respecto a su base (incluye lo editado aún sin commit). */
export async function changes(wt, base) {
  await ok(wt, ['add', '-A']);
  const [numstat, names, patch] = await Promise.all([
    ok(wt, ['diff', '--cached', '--no-renames', '--numstat', base]),
    ok(wt, ['diff', '--cached', '--no-renames', '--name-status', base]),
    git(wt, ['diff', '--cached', '--no-renames', '--no-color', base]).then((r) => r.stdout),
  ]);
  const status = new Map(names.split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split('\t'); return [p.at(-1), s[0]]; }));
  const files = numstat.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t');
    const path = p.at(-1);
    return { path, status: status.get(path) ?? 'M', additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d), binary: a === '-' };
  });
  const truncated = patch.length > PATCH_LIMIT;
  return { files, patch: truncated ? patch.slice(0, PATCH_LIMIT) : patch, truncated };
}

/** Une la rama de la misión al proyecto real. Rechaza si hay cambios sin guardar; ante conflicto deshace el merge. */
export async function apply({ repo, branch, message }) {
  const dirty = (await ok(repo, ['status', '--porcelain', '-uno'])).trim();
  if (dirty) return { ok: false, reason: 'dirty', message: 'Tu proyecto tiene cambios sin guardar. Guárdalos (commit o stash) y vuelve a intentarlo.' };
  const head = await git(repo, ['symbolic-ref', '-q', 'HEAD']);
  if (head.code !== 0) return { ok: false, reason: 'detached', message: 'Tu proyecto está en HEAD desacoplado (sin rama). Cambia a una rama y vuelve a intentarlo.' };
  const r = await git(repo, ['merge', '--no-ff', '-m', message.slice(0, 200), branch]);
  if (r.code !== 0) {
    await git(repo, ['merge', '--abort']);
    return { ok: false, reason: 'conflict', message: `Conflicto al unir con tu rama actual; no se cambió nada. ${(r.stdout + r.stderr).trim().split('\n').slice(-2).join(' ')}` };
  }
  return { ok: true, branch: head.stdout.trim().replace(/^refs\/heads\//, '') };
}

/** Elimina la copia aislada y su rama. */
export async function discard({ repo, wt, branch }) {
  if (wt && existsSync(wt)) await git(repo, ['worktree', 'remove', '--force', wt]);
  await git(repo, ['worktree', 'prune']);
  await git(repo, ['branch', '-D', branch]);
}
