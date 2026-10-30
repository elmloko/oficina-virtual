import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export const STATUSES = ['backlog', 'queued', 'running', 'review', 'done', 'failed'];

export const DEFAULT_SETTINGS = {
  daily_budget_usd: 10, // 0 = sin límite. Con suscripción el costo es referencial, pero sirve de freno.
  task_budget_usd: 2, // tope por tarea (--max-budget-usd)
  task_timeout_min: 20,
  max_claude: config.maxClaude, // concurrencia por motor (editable desde la web)
  max_ollama: config.maxOllama,
  max_api: config.maxApi,
};
const LIMIT_KEYS = new Set(['max_claude', 'max_ollama', 'max_api']);

const TASK_COLUMNS = ['title', 'description', 'project', 'agent', 'engine', 'mode', 'status', 'result', 'error',
  'cost_usd', 'started_at', 'finished_at', 'parent_id', 'depends_on', 'kind', 'schedule_id', 'model', 'reply_text', 'branch', 'worktree', 'base_sha', 'change_state'];

function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project TEXT,
      agent TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'auto',
      mode TEXT NOT NULL DEFAULT 'read',
      status TEXT NOT NULL DEFAULT 'backlog',
      result TEXT,
      error TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      task_id INTEGER,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      project TEXT,
      agent TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'auto',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migraciones aditivas sobre la versión de la Fase 1.
  addColumnIfMissing(db, 'tasks', 'parent_id', 'INTEGER');
  addColumnIfMissing(db, 'tasks', 'depends_on', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'tasks', 'kind', "TEXT NOT NULL DEFAULT 'task'");
  addColumnIfMissing(db, 'tasks', 'schedule_id', 'INTEGER');
  addColumnIfMissing(db, 'tasks', 'model', 'TEXT');
  addColumnIfMissing(db, 'tasks', 'branch', 'TEXT'); // misión que edita: rama y copia aislada donde trabaja
  addColumnIfMissing(db, 'tasks', 'worktree', 'TEXT');
  addColumnIfMissing(db, 'tasks', 'base_sha', 'TEXT');
  addColumnIfMissing(db, 'tasks', 'change_state', 'TEXT'); // pending | applied | discarded
  addColumnIfMissing(db, 'tasks', 'reply_text', 'TEXT'); // respuesta del usuario en vuelo (o cancelada, lista para editar)

  // Una tarea que quedó "running"/"queued" en un reinicio ya no tiene proceso: se marca fallida.
  db.exec(`UPDATE tasks SET status='failed', error='Interrumpida por reinicio del servidor',
           finished_at=datetime('now') WHERE status IN ('running','queued')`);

  const q = {
    get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    list: db.prepare('SELECT * FROM tasks ORDER BY id DESC'),
    children: db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY id'),
    del: db.prepare('DELETE FROM tasks WHERE id = ?'),
    addEvent: db.prepare('INSERT INTO events (task_id, kind, text) VALUES (?, ?, ?) RETURNING *'),
    events: db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id'),
    delEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    costToday: db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM tasks WHERE date(finished_at, 'localtime') = date('now', 'localtime')`),
    costByAgent: db.prepare(`SELECT agent, COUNT(*) AS tasks, ROUND(SUM(cost_usd), 4) AS cost_usd FROM tasks
                             WHERE finished_at IS NOT NULL GROUP BY agent ORDER BY cost_usd DESC, tasks DESC`),
    costByDay: db.prepare(`SELECT date(finished_at, 'localtime') AS day, ROUND(SUM(cost_usd), 4) AS cost_usd, COUNT(*) AS tasks
                           FROM tasks WHERE finished_at IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 14`),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    finishedToday: db.prepare(`SELECT engine, status, COUNT(*) AS n, ROUND(SUM(cost_usd), 4) AS cost,
                               AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_s
                               FROM tasks WHERE finished_at IS NOT NULL AND date(finished_at, 'localtime') = date('now', 'localtime')
                               GROUP BY engine, status`),
    recentFailures: db.prepare(`SELECT id, title, agent, engine, error, finished_at FROM tasks WHERE status = 'failed' ORDER BY id DESC LIMIT ?`),
    byStatus: db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    addAudit: db.prepare('INSERT INTO audit (action, task_id, detail) VALUES (?, ?, ?)'),
    audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
    schedules: db.prepare('SELECT * FROM schedules ORDER BY id'),
    schedule: db.prepare('SELECT * FROM schedules WHERE id = ?'),
    delSchedule: db.prepare('DELETE FROM schedules WHERE id = ?'),
  };

  const parseTask = (t) => (t ? { ...t, depends_on: JSON.parse(t.depends_on || '[]') } : t);

  return {
    raw: db,
    createTask(t) {
      const row = db.prepare(`INSERT INTO tasks (title, description, project, agent, engine, mode, parent_id, depends_on, kind, schedule_id, model)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(t.title, t.description ?? '', t.project ?? null, t.agent, t.engine ?? 'auto', t.mode ?? 'read',
          t.parent_id ?? null, JSON.stringify(t.depends_on ?? []), t.kind ?? 'task', t.schedule_id ?? null, t.model ?? null);
      return parseTask(row);
    },
    getTask: (id) => parseTask(q.get.get(id)),
    listTasks: () => q.list.all().map(parseTask),
    children: (id) => q.children.all(id).map(parseTask),
    deleteTask: (id) => q.del.run(id).changes > 0,
    events: (id) => q.events.all(id),
    deleteEvent: (id) => q.delEvent.run(id).changes > 0,
    addEvent: (id, kind, text) => q.addEvent.get(id, kind, String(text).slice(0, 20000)),
    /** Actualiza solo columnas conocidas; evita SQL dinámico con claves externas. */
    updateTask(id, patch) {
      const keys = Object.keys(patch).filter((k) => TASK_COLUMNS.includes(k));
      if (!keys.length) return parseTask(q.get.get(id));
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      const vals = keys.map((k) => (k === 'depends_on' ? JSON.stringify(patch[k]) : patch[k]));
      return parseTask(db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ? RETURNING *`).get(...vals, id));
    },

    costToday: () => q.costToday.get().c,
    /** Resumen de hoy: totales, tasa de éxito, duración media y desglose por motor. */
    activityToday() {
      const rows = q.finishedToday.all();
      const ok = rows.filter((r) => r.status !== 'failed');
      const total = rows.reduce((a, r) => a + r.n, 0);
      const done = ok.reduce((a, r) => a + r.n, 0);
      const timed = rows.filter((r) => r.avg_s != null && r.avg_s >= 0);
      const timedN = timed.reduce((a, r) => a + r.n, 0);
      const avg = timedN ? timed.reduce((a, r) => a + r.avg_s * r.n, 0) / timedN : null;
      const byEngine = {};
      for (const r of rows) {
        const e = (byEngine[r.engine] ??= { engine: r.engine, ok: 0, failed: 0, cost_usd: 0 });
        if (r.status === 'failed') e.failed += r.n; else e.ok += r.n;
        e.cost_usd += r.cost ?? 0;
      }
      return { total, ok: done, failed: total - done, successRate: total ? done / total : null, avgSeconds: avg, byEngine: Object.values(byEngine) };
    },
    recentFailures: (limit = 10) => q.recentFailures.all(limit),
    countsByStatus: () => Object.fromEntries(q.byStatus.all().map((r) => [r.status, r.n])),
    costByAgent: () => q.costByAgent.all(),
    costByDay: () => q.costByDay.all(),

    settings() {
      const out = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const row = q.getSetting.get(k);
        if (row) out[k] = Number(row.value);
      }
      return out;
    },
    setSettings(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido para ${k}`);
        if (LIMIT_KEYS.has(k) && !(Number.isInteger(n) && n >= 1 && n <= 16)) throw new Error(`${k} debe ser un entero entre 1 y 16`);
        q.setSetting.run(k, String(n));
      }
      return this.settings();
    },

    audit: (action, taskId = null, detail = '') => { q.addAudit.run(action, taskId, String(detail).slice(0, 2000)); },
    auditLog: (limit = 100) => q.audit.all(limit),

    schedules: () => q.schedules.all().map((s) => ({ ...s, spec: JSON.parse(s.spec), enabled: !!s.enabled })),
    getSchedule: (id) => { const s = q.schedule.get(id); return s ? { ...s, spec: JSON.parse(s.spec), enabled: !!s.enabled } : null; },
    createSchedule(s) {
      const row = db.prepare(`INSERT INTO schedules (name, spec, project, agent, engine, title, description, last_run)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(s.name, JSON.stringify(s.spec), s.project ?? null, s.agent, s.engine ?? 'auto', s.title, s.description ?? '', s.last_run ?? new Date().toISOString());
      return this.getSchedule(row.id);
    },
    updateSchedule(id, patch) {
      const sets = [];
      const vals = [];
      for (const k of ['name', 'enabled', 'last_run']) {
        if (k in patch) { sets.push(`${k} = ?`); vals.push(k === 'enabled' ? (patch[k] ? 1 : 0) : patch[k]); }
      }
      if ('spec' in patch) { sets.push('spec = ?'); vals.push(JSON.stringify(patch.spec)); }
      if (sets.length) db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      return this.getSchedule(id);
    },
    deleteSchedule: (id) => q.delSchedule.run(id).changes > 0,
  };
}
