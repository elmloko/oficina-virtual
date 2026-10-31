// Lógica pura de la comunicación entre agentes (sin DOM, para poder probarla).

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** Conversaciones: los mensajes se agrupan por la misión que pidió ayuda. Las más recientes primero. */
export function threads(messages, tasks) {
  const byTask = new Map();
  for (const m of messages) {
    if (!byTask.has(m.task_id)) byTask.set(m.task_id, []);
    byTask.get(m.task_id).push(m);
  }
  const out = [];
  for (const [taskId, items] of byTask) {
    items.sort((a, b) => a.id - b.id);
    const task = tasks.get ? tasks.get(taskId) : tasks.find((t) => t.id === taskId);
    const asker = items.find((m) => m.kind === 'request')?.from_agent ?? task?.agent ?? '?';
    const helpers = [...new Set(items.filter((m) => m.kind === 'request').map((m) => m.to_agent))];
    const answered = new Set(items.filter((m) => m.kind === 'answer').map((m) => m.from_agent));
    out.push({
      taskId, task, asker, helpers, items,
      waiting: helpers.filter((h) => !answered.has(h)), // aún no respondieron
      last: items.at(-1).id,
    });
  }
  return out.sort((a, b) => b.last - a.last);
}

/** Consultas en curso: quién espera a quién ahora mismo. */
export function activeLinks(tasks) {
  const all = tasks.values ? [...tasks.values()] : tasks;
  const byId = new Map(all.map((t) => [t.id, t]));
  const links = [];
  for (const t of all) {
    if (!t.consult_of || !['queued', 'running'].includes(t.status)) continue;
    const parent = byId.get(t.consult_of);
    if (parent) links.push({ from: parent.agent, to: t.agent, parentId: parent.id, childId: t.id, state: t.status });
  }
  return links;
}

/** Texto corto de un mensaje para el rótulo del mapa y los avisos. */
export function ticker(m) {
  return m.kind === 'request'
    ? `${m.from_agent} → ${m.to_agent}: ${clip(m.text, 70)}`
    : `${m.from_agent} → ${m.to_agent}: respondió`;
}

/** Vuelos de sobres: el sobre vuela de quien envía a quien recibe y desaparece pasado un tiempo. */
export const FLIGHT_MS = 2200;
export const prune = (flights, now) => flights.filter((f) => now - f.t0 < FLIGHT_MS);

/** Posición (0..1) del sobre en su trayecto, con aceleración suave. */
export const progress = (flight, now) => {
  const p = Math.min(1, Math.max(0, (now - flight.t0) / (FLIGHT_MS * 0.8)));
  return p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
};

/** Punto de una curva cuadrática (los mensajes viajan en arco, no en línea recta). */
export function arc(a, b, p, lift = 46) {
  const cx = (a.x + b.x) / 2; const cy = Math.min(a.y, b.y) - lift;
  const u = 1 - p;
  return { x: u * u * a.x + 2 * u * p * cx + p * p * b.x, y: u * u * a.y + 2 * u * p * cy + p * p * b.y };
}
