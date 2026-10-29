// Registro en memoria (anillo) para ver desde la web qué hace el servidor. No guarda secretos:
// los mensajes los redactan quienes llaman y solo incluyen ids, nombres y motivos.
export function createLogger({ max = 500, echo = false } = {}) {
  const entries = [];
  const listeners = new Set();
  let seq = 0;

  function add(level, msg, meta) {
    const entry = { id: ++seq, ts: new Date().toISOString(), level, msg: String(msg).slice(0, 500), ...(meta ? { meta } : {}) };
    entries.push(entry);
    if (entries.length > max) entries.shift();
    if (echo) console[level === 'error' ? 'error' : 'log'](`[${entry.ts}] ${level.toUpperCase()} ${entry.msg}`);
    for (const fn of listeners) fn(entry);
    return entry;
  }

  return {
    info: (m, meta) => add('info', m, meta),
    warn: (m, meta) => add('warn', m, meta),
    error: (m, meta) => add('error', m, meta),
    /** Entradas con id mayor a `after`, opcionalmente solo de cierto nivel. */
    list: ({ after = 0, level = null, limit = 200 } = {}) => entries.filter((e) => e.id > after && (!level || e.level === level)).slice(-limit),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export const noopLogger = { info() {}, warn() {}, error() {}, list: () => [], subscribe: () => () => {} };
