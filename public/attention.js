// Lógica pura de "qué necesita mi atención" y "qué cambió" (sin DOM, para poder probarla).

const QUESTION_TAIL = 400; // solo se mira el final de la respuesta: ahí el agente deja su pregunta

/** ¿La respuesta del agente termina pidiéndole algo al usuario? Heurística: el último párrafo contiene una pregunta. */
export function isQuestion(text) {
  const tail = String(text ?? '').trim().slice(-QUESTION_TAIL);
  if (!tail) return false;
  const last = tail.split(/\n\s*\n/).pop().trim();
  const stripped = last.replace(/[`*_>\s]+$/g, ''); // negritas/comillas finales no cuentan
  return /[?？]$/.test(stripped) || /¿[^?]{3,}\?/.test(last) || /\b(¿?cuál|¿?quieres que|¿?prefieres|¿?confirmas)\b[^.!]*\?/i.test(last);
}

const ORDER = { question: 0, failed: 1, plan: 2, review: 3 };

/**
 * Misiones que esperan una acción del usuario, ordenadas por urgencia:
 * preguntas del agente, fallidas, planes por lanzar y resultados por revisar.
 */
export function attentionItems(tasks) {
  const all = [...tasks];
  const pendingSteps = (id) => all.some((k) => k.parent_id === id && ['backlog', 'failed'].includes(k.status));
  const items = [];
  for (const t of all) {
    if (t.kind === 'objective') {
      if (t.status === 'review' && pendingSteps(t.id)) items.push({ kind: 'plan', task: t });
    } else if (t.status === 'failed') items.push({ kind: 'failed', task: t });
    else if (t.status === 'review') items.push({ kind: isQuestion(t.result) ? 'question' : 'review', task: t });
  }
  return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.task.id - a.task.id);
}

/**
 * Evento de aviso al pasar una misión de `prevStatus` a su estado actual (o null si no hay nada que avisar).
 * Una misión que aparece por primera vez (prevStatus undefined) o que ya estaba terminada no avisa.
 */
export function transition(prevStatus, task) {
  if (!['queued', 'running'].includes(prevStatus)) return null;
  if (task.kind === 'objective') return task.status === 'review' ? { kind: 'plan', task } : task.status === 'failed' ? { kind: 'failed', task } : null;
  if (task.status === 'failed') return { kind: 'failed', task };
  if (task.status === 'review' || task.status === 'done') return { kind: isQuestion(task.result) ? 'question' : 'done', task };
  return null;
}

export const KIND_LABEL = {
  question: 'Te hace una pregunta',
  failed: 'Falló',
  plan: 'Plan listo para lanzar',
  review: 'Por revisar',
  done: 'Terminó',
};
