import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from './config.js';

export const isExtraRoot = (name) => typeof name === 'string' && name.startsWith('@');

/** Proyectos = subcarpetas de htdocs que parecen código (git, artisan o composer.json) + carpetas extra (@Nombre, solo lectura). */
export function listProjects(root = config.htdocs, extras = config.extraRoots) {
  const out = [];
  for (const [name, path] of Object.entries(extras)) {
    if (existsSync(path)) out.push({ name, path, git: false, stack: 'solo lectura', extra: true });
  }
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }
    const git = existsSync(join(dir, '.git'));
    const laravel = existsSync(join(dir, 'artisan'));
    if (git || laravel || existsSync(join(dir, 'composer.json'))) {
      out.push({ name, path: dir, git, stack: laravel ? 'laravel' : 'php/otro' });
    }
  }
  return out.sort((a, b) => (a.extra === b.extra ? a.name.localeCompare(b.name) : a.extra ? 1 : -1));
}

/** Resuelve un proyecto por nombre; rechaza cualquier cosa fuera de htdocs (path traversal). */
export function resolveProject(name, root = config.htdocs, extras = config.extraRoots) {
  if (!name) return null;
  if (isExtraRoot(name)) { // solo nombres exactos configurados; nunca subrutas
    const path = Object.hasOwn(extras, name) ? extras[name] : null;
    return path && existsSync(path) && statSync(path).isDirectory() ? resolve(path) : null;
  }
  const dir = resolve(root, name);
  const base = resolve(root) + sep;
  if (!dir.startsWith(base)) return null;
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

export function listAgents(dir = config.agentsDir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const get = (k) => (text.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm')) || [])[1] || '';
    return { name: get('name') || f.slice(0, -3), description: get('description') };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
