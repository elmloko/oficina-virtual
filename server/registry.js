import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from './config.js';
import { parseAgent } from './agents-io.js';

/** Destino «servidor» (modo infraestructura): `srv:nombre`. No es una carpeta: el agente no se conecta, solo planifica. */
export const isServerRef = (name) => typeof name === 'string' && name.startsWith('srv:');
export const isExtraRoot = (name) => typeof name === 'string' && name.startsWith('@');
export const DOCS_PROJECT = '+Documentos';
export const isDocsRoot = (name) => name === DOCS_PROJECT;

/** Proyectos = subcarpetas de htdocs que parecen código (git, artisan o composer.json) + carpetas extra (@Nombre, solo lectura). */
export function listProjects(root = config.htdocs, extras = config.extraRoots, docs = config.docsRoot) {
  const out = [];
  if (docs && existsSync(docs)) out.push({ name: DOCS_PROJECT, path: docs, git: false, stack: 'carpeta nueva por tema', docs: true });
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
  const rank = (p) => (p.docs ? 1 : p.extra ? 2 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Resuelve un proyecto por nombre; rechaza cualquier cosa fuera de htdocs (path traversal). */
export function resolveProject(name, root = config.htdocs, extras = config.extraRoots, docs = config.docsRoot) {
  if (!name) return null;
  if (isDocsRoot(name)) return docs && existsSync(docs) && statSync(docs).isDirectory() ? resolve(docs) : null;
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
    const a = parseAgent(text, f); // entiende también descripciones YAML de varias líneas (description: |)
    if (!a.error) return { name: a.name, description: a.description, tools: a.tools === '*' && !/^tools:/m.test(text) ? '' : a.tools };
    const get = (k) => (text.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm')) || [])[1] || '';
    return { name: get('name') || f.slice(0, -3), description: get('description'), tools: get('tools') };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
