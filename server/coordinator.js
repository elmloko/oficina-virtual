// Agente coordinador: convierte un objetivo en un plan de tareas con dependencias.
// Claude propone el plan en JSON; aquí se valida de forma estricta antes de crear nada.
export const MAX_STEPS = 12;

export function buildPlanPrompt(objective, agents, projects) {
  const roster = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  const projs = projects.map((p) => p.name).join(', ');
  return `Eres el coordinador de una oficina de agentes. Divide el OBJETIVO en pasos ejecutables y asigna cada uno al agente más adecuado.

OBJETIVO:
${objective}

AGENTES DISPONIBLES:
${roster}

PROYECTOS VÁLIDOS (carpetas): ${projs}

Reglas:
- Máximo ${MAX_STEPS} pasos. Cada paso debe ser concreto y verificable.
- "depends_on" lista los índices (desde 0) de pasos anteriores cuyo resultado necesita. Solo índices menores al del paso.
- Usa "mode":"edit" solo si el paso debe modificar archivos; en cualquier otro caso "read".
- Los pasos de infraestructura (despliegues, apply, borrados) deben ser solo de planificación ("read").
- Responde SOLO con JSON válido, sin texto adicional, con esta forma:
{"steps":[{"title":"...","description":"...","agent":"nombre","project":"carpeta o null","mode":"read|edit","depends_on":[]}]}`;
}

/** Extrae el primer objeto JSON del texto (tolera ```json ... ``` y texto alrededor). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  if (start < 0) throw new Error('El coordinador no devolvió JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(src.slice(start, i + 1)); } catch { throw new Error('JSON del plan inválido'); }
    }
  }
  throw new Error('JSON del plan incompleto');
}

/**
 * Valida el plan. Devuelve pasos normalizados o lanza un Error con el motivo.
 * agentNames: Set<string>; projectNames: Set<string>.
 */
export function parsePlan(text, agentNames, projectNames) {
  const data = extractJson(text);
  const steps = data.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('El plan no tiene pasos');
  if (steps.length > MAX_STEPS) throw new Error(`El plan excede ${MAX_STEPS} pasos`);
  return steps.map((s, i) => {
    if (typeof s.title !== 'string' || !s.title.trim()) throw new Error(`Paso ${i}: falta el título`);
    if (!agentNames.has(s.agent)) throw new Error(`Paso ${i}: agente desconocido "${s.agent}"`);
    const project = s.project || null;
    if (project && !projectNames.has(project)) throw new Error(`Paso ${i}: proyecto desconocido "${project}"`);
    const mode = s.mode === 'edit' ? 'edit' : 'read';
    if (mode === 'edit' && !project) throw new Error(`Paso ${i}: editar requiere proyecto`);
    const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
    for (const d of deps) {
      if (!Number.isInteger(d) || d < 0 || d >= i) throw new Error(`Paso ${i}: dependencia inválida (${d})`);
    }
    return { title: s.title.trim().slice(0, 200), description: String(s.description ?? '').slice(0, 5000), agent: s.agent, project, mode, depends_on: [...new Set(deps)] };
  });
}
