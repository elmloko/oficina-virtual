import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { nextRun } from './scheduler.js';
import { knownProviders, secretEnvNames } from './providers.js';
import { listProjects } from './registry.js';
import { OLLAMA_MODELS } from './router.js';
import { chatModels } from './ollama-models.js';

/** `get.reset()` olvida lo guardado (p. ej. tras encender o apagar un servidor); una consulta que ya iba en curso no lo vuelve a guardar. */
const cached = (ttlMs, fn) => {
  let at = 0;
  let value;
  let pending = null;
  let gen = 0;
  const get = () => {
    if (Date.now() - at < ttlMs) return Promise.resolve(value);
    if (!pending) {
      const mine = gen;
      pending = fn().then((v) => { if (mine === gen) { value = v; at = Date.now(); } return v; }).finally(() => { if (mine === gen) pending = null; });
    }
    return pending;
  };
  get.reset = () => { gen++; at = 0; pending = null; };
  return get;
};

/** Modelos que acepta `claude --model` (alias que siempre apuntan al más reciente de su familia). */
export const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Sonnet · equilibrado' },
  { value: 'opus', label: 'Opus · el más capaz (gasta más cupo)' },
  { value: 'haiku', label: 'Haiku · rápido y ligero' },
];

/** Modelos de chat de Ollama: sin los de embeddings (no conversan). */
export const ollamaChatModels = (models = [], recommended = OLLAMA_MODELS.light) => chatModels(models).map((m) => ({ value: m.name, label: `${m.name} · ${(m.size / 1e9).toFixed(1)} GB`, recommended: m.name === recommended }));

/** Sondas del entorno con caché corta para que el panel pueda refrescarse cada pocos segundos. */
export function createProbe({ config, fetchFn = fetch, exec = execFile } = {}) {
  const claude = cached(60_000, () => new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of secretEnvNames()) delete env[k];
    exec('claude', ['--version'], { timeout: 5000, windowsHide: true, env }, (err, stdout) => {
      resolve(err ? { ok: false, error: 'No se encontró el CLI `claude` en el PATH' } : { ok: true, version: String(stdout).trim() });
    });
  }));

  const ollama = cached(4_000, async () => {
    const get = async (path) => (await fetchFn(`${config.ollamaUrl}${path}`, { signal: AbortSignal.timeout(1500) })).json();
    try {
      const [tags, ps] = await Promise.all([get('/api/tags'), get('/api/ps').catch(() => ({ models: [] }))]);
      return {
        ok: true,
        models: (tags.models ?? []).map((m) => ({ name: m.name, size: m.size })),
        loaded: (ps.models ?? []).map((m) => ({ name: m.name, size: m.size, expires_at: m.expires_at })),
      };
    } catch { return { ok: false, error: 'Ollama no responde (¿está iniciado?)' }; }
  });

  const codex = cached(60_000, () => new Promise((resolve) => {
    exec(config.codexBin, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(err ? { ok: false, error: 'No se encontró el CLI de Codex (instala la app de Codex o define CODEX_BIN)' } : { ok: true, version: String(stdout).trim() });
    });
  }));

  // Catálogo de modelos de Codex (el mismo que ve la app): solo los visibles en su lista.
  const codexModels = cached(600_000, () => new Promise((resolve) => {
    exec(config.codexBin, ['debug', 'models'], { timeout: 15000, windowsHide: true, maxBuffer: 20_000_000 }, (err, stdout) => {
      try {
        const list = JSON.parse(String(stdout)).models ?? [];
        resolve(err ? [] : list.filter((m) => m.visibility === 'list').map((m) => ({ value: m.slug, label: m.display_name || m.slug })));
      } catch { resolve([]); }
    });
  }));

  return { claude, ollama, codex, codexModels };
}

const fileSize = (f) => { try { return statSync(f).size; } catch { return null; } };

/** Reúne todo lo que muestra la pestaña Sistema. */
export async function collectSystem({ db, runner, probe, config, startedAt, env = process.env, now = new Date() }) {
  const [claude, ollama, codex] = await Promise.all([probe.claude(), probe.ollama(), probe.codex?.() ?? { ok: false, error: 'sin sonda' }]);
  return {
    server: { uptime_s: Math.round((now - startedAt) / 1000), started_at: startedAt.toISOString(), node: process.version, pid: process.pid, platform: process.platform, host: config.host, port: config.port },
    memory: { free_gb: Math.round((freemem() / 1e9) * 10) / 10, total_gb: Math.round((totalmem() / 1e9) * 10) / 10 },
    db: { file: config.dbFile, size_bytes: fileSize(config.dbFile), tasks: db.countsByStatus() },
    claude: { ...claude, enabled: !db.disabledEngines().includes('claude') },
    ollama: { ...ollama, enabled: !db.disabledEngines().includes('ollama') },
    codex: { ...codex, enabled: !db.disabledEngines().includes('codex') },
    providers: knownProviders(env, db.disabledProviders()),
    paths: {
      htdocs: { path: config.htdocs, exists: existsSync(config.htdocs), projects: listProjects().filter((p) => !p.extra && !p.docs).length },
      docs: { path: config.docsRoot, exists: existsSync(config.docsRoot) },
      extra: Object.entries(config.extraRoots).map(([name, path]) => ({ name, path, exists: existsSync(path) })),
    },
    queue: runner.snapshot(),
    schedules: db.schedules().map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, agent: s.agent, project: s.project, last_run: s.last_run, next_run: nextRun(s, now)?.toISOString() ?? null })),
    activity: { ...db.activityToday(), cost_today: db.costToday() },
    failures: db.recentFailures(8),
    settings: db.settings(),
  };
}
