import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Carga mínima de .env sin dependencias; las variables reales del entorno ganan.
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function parseExtraRoots(spec) {
  const out = {};
  for (const part of spec.split(';')) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim();
    const path = part.slice(i + 1).trim();
    if (i > 0 && /^[\w-]+$/.test(name) && path) out[`@${name}`] = path;
  }
  return out;
}

export const config = {
  root,
  port: Number(process.env.PORT || 4000),
  host: '127.0.0.1', // solo local: la oficina puede ejecutar agentes sobre tus carpetas
  htdocs: process.env.HTDOCS_ROOT || 'C:\\xampp\\htdocs',
  // Carpetas extra fuera de htdocs, SOLO LECTURA. Formato: Nombre=Ruta;Otro=Ruta2 (se exponen como "@Nombre").
  extraRoots: parseExtraRoots(process.env.EXTRA_ROOTS ?? `Descargas=${join(homedir(), 'Downloads')}`),
  agentsDir: process.env.AGENTS_DIR || join(homedir(), '.claude', 'agents'),
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  maxClaude: Number(process.env.MAX_CLAUDE_CONCURRENCY || 2),
  maxOllama: Number(process.env.MAX_OLLAMA_CONCURRENCY || 1),
  maxApi: Number(process.env.MAX_API_CONCURRENCY || 3),
  dbFile: process.env.DB_FILE || join(root, 'data', 'oficina.db'),
};
