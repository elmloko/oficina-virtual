// Importar y exportar agentes (archivos .md de Claude Code) sin repetir: compara por nombre y por contenido.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename, relative, sep } from 'node:path';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const MAX_AGENT_BYTES = 64 * 1024;
export const MAX_IMPORT = 200;
export const BUNDLE_FORMAT = 'oficina-agentes';

/** Contenido comparable: sin BOM, saltos de línea de Windows ni espacios al final (el mismo agente copiado entre equipos da igual). */
export const normalize = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
/** Huella del agente sin su línea `name:`: el mismo agente guardado con otro nombre cuenta como repetido. */
export const hashOf = (text) => createHash('sha256').update(normalize(text).replace(/^name:.*\n/m, '')).digest('hex');

/** Lee un agente: exige frontmatter con description; el nombre sale del frontmatter o del nombre del archivo. */
export function parseAgent(text, filename = '') {
  const content = normalize(text);
  if (Buffer.byteLength(content) > MAX_AGENT_BYTES) return { error: 'Archivo demasiado grande (máx. 64 KB)' };
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(content);
  if (!m) return { error: 'No es un agente: falta el encabezado --- name / description ---' };
  const get = (k) => {
    const line = new RegExp(`^${k}:[ \\t]*(.*)$((?:\\n[ \\t]+.*)*)`, 'm').exec(m[1]);
    if (!line) return '';
    const v = line[1].trim();
    if (/^[|>][+-]?$/.test(v)) return line[2].split('\n').map((s) => s.trim()).filter(Boolean).join(' '); // YAML de varias líneas (description: |)
    return v.replace(/^(["'])(.*)\1$/, '$2');
  };
  const name = (get('name') || basename(filename).replace(/\.md$/i, '')).toLowerCase();
  if (!NAME_RE.test(name)) return { error: `Nombre de agente inválido: «${name.slice(0, 40)}»` };
  const description = get('description');
  if (!description) return { error: 'Falta la descripción (description) del agente' };
  return { name, description: description.slice(0, 300), tools: get('tools') || '*', content, hash: hashOf(content) };
}

/** Agentes que ya tienes: nombre → hash, y el conjunto de hashes (para detectar el mismo agente con otro nombre). */
export function localIndex(dir) {
  const byName = new Map(); const byHash = new Map();
  if (!existsSync(dir)) return { byName, byHash };
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.md'))) {
    try {
      const a = parseAgent(readFileSync(join(dir, f), 'utf8'), f);
      const name = a.error ? f.slice(0, -3).toLowerCase() : a.name;
      const hash = a.error ? hashOf(readFileSync(join(dir, f), 'utf8')) : a.hash;
      byName.set(name, hash); byHash.set(hash, name);
    } catch { /* archivo ilegible: se ignora */ }
  }
  return { byName, byHash };
}

/**
 * Qué pasaría al importar, sin tocar nada. Estado de cada agente:
 * nuevo (se guarda) · igual (ya lo tienes, idéntico) · conflicto (ya hay otro distinto con ese nombre: no se pisa)
 * · repetido (aparece dos veces en lo que importas) · invalido.
 */
export function planImport(items, dir) {
  const { byName, byHash } = localIndex(dir);
  const seenNames = new Set(); const seenHashes = new Set();
  return items.map((it) => {
    const a = parseAgent(it.content, it.filename);
    const base = { source: it.source ?? it.filename ?? null, id: it.id ?? null };
    if (a.error) return { ...base, name: it.name ?? basename(it.filename ?? '') ?? '?', status: 'invalido', reason: a.error };
    const info = { ...base, name: a.name, description: a.description, tools: a.tools };
    if (byHash.has(a.hash)) return { ...info, status: 'igual', reason: byHash.get(a.hash) === a.name ? 'Ya lo tienes' : `Ya lo tienes como «${byHash.get(a.hash)}»` };
    if (byName.has(a.name)) return { ...info, status: 'conflicto', reason: 'Ya tienes otro agente distinto con ese nombre (no se reemplaza)' };
    if (seenHashes.has(a.hash) || seenNames.has(a.name)) return { ...info, status: 'repetido', reason: 'Aparece más de una vez: se importa solo el primero' };
    seenNames.add(a.name); seenHashes.add(a.hash);
    return { ...info, status: 'nuevo', content: a.content };
  });
}

/** Importa los «nuevo». `wx`: si otro proceso creó el archivo mientras tanto, no se pisa (queda como conflicto). */
export async function applyImport(items, dir) {
  const plan = planImport(items, dir);
  // En una PC recién instalada ~/.claude/agents puede no existir: se crea en vez de fallar con ENOENT.
  if (plan.some((p) => p.status === 'nuevo')) await mkdir(dir, { recursive: true });
  for (const p of plan) {
    if (p.status !== 'nuevo') continue;
    try { await writeFile(join(dir, `${p.name}.md`), p.content, { flag: 'wx' }); p.status = 'importado'; } catch (e) {
      Object.assign(p, e.code === 'EEXIST' ? { status: 'conflicto', reason: 'Apareció un archivo con ese nombre mientras importabas' } : { status: 'invalido', reason: `No se pudo guardar: ${e.code || e.message}` });
    }
  }
  return plan.map(({ content, ...p }) => p);
}

/** Paquete para llevar tus agentes a otro equipo (o guardarlos de respaldo). */
export function exportBundle(dir, names = null, now = new Date()) {
  const want = names?.length ? new Set(names) : null;
  const agents = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.md')).sort()) {
      const a = parseAgent(readFileSync(join(dir, f), 'utf8'), f);
      if (!a.error && (!want || want.has(a.name))) agents.push({ name: a.name, content: a.content });
    }
  }
  return { format: BUNDLE_FORMAT, version: 1, exported_at: now.toISOString(), agents };
}

/** Lo que llega a importar: un paquete exportado, o archivos .md sueltos. */
export function readUpload(body) {
  const list = Array.isArray(body?.agents) ? body.agents : null;
  if (!list) return { error: 'No hay agentes que importar' };
  if (list.length > MAX_IMPORT) return { error: `Como máximo ${MAX_IMPORT} agentes por vez` };
  const items = [];
  for (const x of list) {
    if (x && typeof x.content === 'string') items.push({ content: x.content, filename: typeof x.filename === 'string' ? x.filename.slice(0, 200) : `${x.name ?? ''}.md`, name: x.name });
  }
  return items.length ? { items } : { error: 'Ningún archivo trae un agente' };
}

/** Busca carpetas «agents» con .md dentro de cada raíz (profundidad limitada; sin seguir enlaces ni carpetas ocultas pesadas). */
function findAgentFiles(root, { maxDepth = 8, maxFiles = 500 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === 'node_modules' || e.name === '.git' || e.name === 'vendor') continue;
      const sub = join(dir, e.name);
      if (e.name === 'agents') {
        let files = []; try { files = readdirSync(sub, { withFileTypes: true }).filter((f) => f.isFile() && f.name.toLowerCase().endsWith('.md')); } catch { /* sin permiso */ }
        for (const f of files) { if (out.length < maxFiles) out.push(join(sub, f.name)); }
      } else walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Nombre legible del origen: el plugin o el proyecto al que pertenece la carpeta. */
function sourceLabel(rootLabel, root, file) {
  const parts = relative(root, file).split(sep);
  const i = parts.lastIndexOf('agents');
  const owner = parts.lastIndexOf('plugins', i) >= 0 ? parts[parts.lastIndexOf('plugins', i) + 1] : parts[i - 1] === '.claude' ? parts[i - 2] : parts[i - 1];
  return owner && owner !== 'agents' ? `${rootLabel} · ${owner}` : rootLabel;
}

/** Agentes de otras carpetas del equipo (plugins, proyectos...) que aún no tienes. Cada uno lleva un id = hash del contenido. */
export function scanSources(roots, dir) {
  const items = []; const seen = new Set();
  for (const { label, path } of roots) {
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) continue;
    for (const file of findAgentFiles(path)) {
      let text; try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const a = parseAgent(text, file);
      if (a.error || seen.has(a.hash)) continue; // los plugins suelen estar copiados en varias carpetas: uno solo
      seen.add(a.hash);
      items.push({ id: a.hash, content: text, filename: basename(file), source: sourceLabel(label, path, file), path: file });
    }
  }
  const plan = planImport(items, dir);
  return plan.map(({ content, ...p }, i) => ({ ...p, path: items[i].path }));
}

/** Para importar desde el escaneo: se vuelve a leer del disco solo lo que el escaneo encontró (nunca rutas que mande el navegador). */
export function pickScanned(roots, ids) {
  const want = new Set(ids);
  const out = [];
  for (const { label, path } of roots) {
    if (!path || !existsSync(path)) continue;
    for (const file of findAgentFiles(path)) {
      let text; try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const h = hashOf(text);
      if (want.has(h)) { want.delete(h); out.push({ id: h, content: text, filename: basename(file), source: sourceLabel(label, path, file) }); }
    }
  }
  return out;
}
