import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// «Documentos» real de Windows (suele estar dentro de OneDrive): la primera ruta que exista.
const docsCandidates = [join(homedir(), 'OneDrive', 'Documentos'), join(homedir(), 'OneDrive', 'Documents'), join(homedir(), 'Documents'), join(homedir(), 'Documentos')];

/** Programa de un servidor local: variable de entorno, o la ruta habitual si existe, o el nombre (del PATH). */
const localBin = (envVar, candidate, name) => process.env[envVar] || (existsSync(candidate) ? candidate : name);

/** Codex CLI: CODEX_BIN, o el que instala la app de Codex/ChatGPT en ~/.codex (la versión más nueva), o «codex» del PATH. */
function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const releases = join(homedir(), '.codex', 'packages', 'app-server-daemon', 'releases');
  try {
    for (const v of readdirSync(releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const bin = join(releases, v, 'bin', 'codex.exe');
      if (existsSync(bin)) return bin;
    }
  } catch { /* sin app de Codex: se intenta el instalador de escritorio o el PATH */ }
  const desktop = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return existsSync(desktop) ? desktop : 'codex';
}

export const config = {
  // Se busca en cada uso: la app de Codex se actualiza sola y cambia la carpeta de la versión.
  get codexBin() { return findCodex(); },
  get lmsBin() { return localBin('LMS_BIN', join(homedir(), '.lmstudio', 'bin', 'lms.exe'), 'lms'); },
  get ollamaBin() { return localBin('OLLAMA_BIN', join(homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'), 'ollama'); },
  root,
  port: Number(process.env.PORT || 4000),
  host: '127.0.0.1', // solo local: la oficina puede ejecutar agentes sobre tus carpetas
  htdocs: process.env.HTDOCS_ROOT || 'C:\\xampp\\htdocs',
  // Carpetas extra fuera de htdocs, SOLO LECTURA. Formato: Nombre=Ruta;Otro=Ruta2 (se exponen como "@Nombre").
  extraRoots: parseExtraRoots(process.env.EXTRA_ROOTS ?? `Descargas=${join(homedir(), 'Downloads')}`),
  // Espacio «+Documentos»: cada misión que guarda archivos crea ahí una carpeta nueva con el nombre de su tema.
  docsRoot: process.env.DOCS_ROOT || docsCandidates.find((p) => existsSync(p)) || join(homedir(), 'Documents'),
  agentsDir: process.env.AGENTS_DIR || join(homedir(), '.claude', 'agents'),
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  maxClaude: Number(process.env.MAX_CLAUDE_CONCURRENCY || 2),
  maxOllama: Number(process.env.MAX_OLLAMA_CONCURRENCY || 1),
  maxApi: Number(process.env.MAX_API_CONCURRENCY || 3),
  envFile: process.env.ENV_FILE || join(root, '.env'),
  dbFile: process.env.DB_FILE || join(root, 'data', 'oficina.db'),
  // Copias aisladas (git worktree) de las misiones que editan archivos; fuera de los proyectos.
  worktreesDir: process.env.WORKTREES_DIR || join(root, 'data', 'worktrees'),
  attachmentsDir: process.env.ATTACHMENTS_DIR || join(root, 'data', 'attachments'),
};
