// Bandeja tipo chat de la vista Oficina: lógica pura (sin DOM) para poder probarla.

const PREVIEW_LEN = 80; // caben ~2 líneas: así se ve el final (la pregunta)

/** Ícono y nombre corto de cada tipo de pendiente. */
export const INBOX_KIND = {
  question: { icon: '❓', label: 'Te pregunta' },
  failed: { icon: '✖', label: 'Falló' },
  plan: { icon: '★', label: 'Plan listo' },
  review: { icon: '✓', label: 'Por revisar' },
};

/** Una línea de vista previa, como en una app de chat: el final de lo último que dijo el agente. */
export function preview(kind, task, pendingSteps = 0) {
  const raw = kind === 'failed' ? task.error || 'Falló sin detalle'
    : kind === 'plan' ? `${pendingSteps} paso(s) pendientes de lanzar`
      : task.result || '(sin respuesta)';
  const flat = String(raw).replace(/[`*#>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LEN ? `…${flat.slice(-PREVIEW_LEN)}` : flat; // de una pregunta importa el final
}

/**
 * La conversación de una misión como burbujas: tus instrucciones y respuestas (me) y las respuestas del agente (agent).
 * Los eventos `answer` son la respuesta del agente anterior a cada mensaje tuyo; `result` es la última.
 */
export function chatThread(task, events = []) {
  const out = [];
  const first = String(task.description || task.title || '').trim();
  if (first) out.push({ who: 'me', text: first, first: true });
  for (const ev of events) {
    if (ev.kind === 'answer') out.push({ who: 'agent', text: ev.text, at: ev.created_at });
    else if (ev.kind === 'user') out.push({ who: 'me', text: ev.text, at: ev.created_at });
  }
  if (['queued', 'running'].includes(task.status)) out.push({ who: 'typing', text: task.status === 'queued' ? 'en cola…' : 'escribiendo…' });
  else if (task.status === 'failed') out.push({ who: 'error', text: task.error || 'Falló sin detalle' });
  else if (task.result) out.push({ who: 'agent', text: task.result, at: task.finished_at });
  return out;
}

/** Clave de «leído»: cambia cada vez que el agente vuelve a terminar. */
export const seenKey = (task) => `${task.id}:${task.finished_at ?? task.updated_at ?? ''}`;

/** Color estable por agente (para su avatar). */
export function agentHue(name = '') {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
