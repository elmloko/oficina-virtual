// Métricas de rendimiento por agente, calculadas sobre las misiones ya terminadas (puro, sin DOM).

/** SQLite guarda 'YYYY-MM-DD HH:MM:SS' en UTC sin zona; el runner guarda ISO. Ambos se interpretan bien. */
export const parseTs = (s) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);

const FINISHED = new Set(['review', 'done', 'failed']);

/**
 * Una fila por agente con: misiones terminadas, éxito (review/done frente a failed), tiempo medio,
 * costo total y medio y última actividad. Se ignoran objetivos, canceladas y en curso.
 */
export function agentMetrics(tasks) {
  const by = new Map();
  for (const t of tasks) {
    if (t.kind === 'objective' || !t.finished_at || !FINISHED.has(t.status)) continue;
    const a = by.get(t.agent) ?? { agent: t.agent, tasks: 0, ok: 0, failed: 0, approved: 0, secs: [], cost: 0, lastAt: 0 };
    a.tasks++;
    if (t.status === 'failed') a.failed++; else a.ok++;
    if (t.status === 'done') a.approved++;
    if (t.started_at) {
      const s = (parseTs(t.finished_at) - parseTs(t.started_at)) / 1000;
      if (Number.isFinite(s) && s >= 0) a.secs.push(s);
    }
    a.cost += t.cost_usd || 0;
    a.lastAt = Math.max(a.lastAt, parseTs(t.finished_at).getTime() || 0);
    by.set(t.agent, a);
  }
  return [...by.values()].map((a) => ({
    agent: a.agent, tasks: a.tasks, ok: a.ok, failed: a.failed, approved: a.approved,
    rate: a.ok + a.failed ? a.ok / (a.ok + a.failed) : null,
    avgSecs: a.secs.length ? a.secs.reduce((x, y) => x + y, 0) / a.secs.length : null,
    cost: a.cost, avgCost: a.tasks ? a.cost / a.tasks : 0, lastAt: a.lastAt || null,
  })).sort((x, y) => y.tasks - x.tasks || x.agent.localeCompare(y.agent));
}

/** Resumen corto de un agente para mostrarlo en su panel. */
export function summarize(row, { fmtDur }) {
  if (!row) return 'Sin misiones terminadas todavía';
  return [`${row.tasks} misión(es)`, row.rate == null ? null : `${Math.round(row.rate * 100)} % éxito`, row.avgSecs == null ? null : `${fmtDur(row.avgSecs)} de media`].filter(Boolean).join(' · ');
}
