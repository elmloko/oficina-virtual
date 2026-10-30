// Búsqueda y filtros del historial de misiones (puro, sin DOM).

/** Minúsculas y sin acentos, para que «migracion» encuentre «Migración». */
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const NO_PROJECT = '__none__';

export const isFiltering = (f = {}) => !!(f.q?.trim() || f.agent || f.project || f.status);

/**
 * Filtra misiones por texto (título, descripción, resultado, error, agente, proyecto; «#12» o «12» busca por id),
 * agente, proyecto (NO_PROJECT = sin proyecto) y estado.
 */
export function filterTasks(tasks, f = {}) {
  const q = norm(f.q).trim();
  const idQ = /^#?(\d+)$/.exec(q)?.[1];
  return tasks.filter((t) => {
    if (f.agent && t.agent !== f.agent) return false;
    if (f.project === NO_PROJECT ? t.project : f.project && t.project !== f.project) return false;
    if (f.status && t.status !== f.status) return false;
    if (!q) return true;
    if (idQ && String(t.id) === idQ) return true;
    return [t.title, t.description, t.result, t.error, t.agent, t.project].some((x) => norm(x).includes(q));
  });
}
