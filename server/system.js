import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { nextRun } from './scheduler.js';
import { knownProviders, secretEnvNames } from './providers.js';
import { listProjects } from './registry.js';

const cached = (ttlMs, fn) => {
  let at = 0;
  let value;
  let pending = null;
  return () => {
    if (Date.now() - at < ttlMs) return Promise.resolve(value);
    pending ??= fn().then((v) => { value = v; at = Date.now(); return v; }).finally(() => { pending = null; });
    return pending;
  };
};

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

  return { claude, ollama, codex };
}

const fileSize = (f) => { try { return statSync(f).size; } catch { return null; } };

/** Reúne todo lo que muestra la pestaña Sistema. */
export async function collectSystem({ db, runner, probe, config, startedAt, env = process.env, now = new Date() }) {
  const [claude, ollama, codex] = await Promise.all([probe.claude(), probe.ollama(), probe.codex?.() ?? { ok: false, error: 'sin sonda' }]);
  return {
    server: { uptime_s: Math.round((now - startedAt) / 1000), started_at: startedAt.toISOString(), node: process.version, pid: process.pid, platform: process.platform, host: config.host, port: config.port },
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
