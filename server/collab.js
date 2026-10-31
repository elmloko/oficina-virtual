// Colaboración entre agentes: un agente puede pedir ayuda a otro terminando su respuesta con
//   [[CONSULTAR nombre-del-agente: pregunta]]
// El sistema crea una misión de solo lectura para ese colega, y cuando responden devuelve las respuestas al agente original.

export const MAX_CONSULTS = 3; // consultas por misión (una sola ronda)
const QUESTION_MAX = 1500;
const ANSWER_MAX = 4000;
const CONTEXT_MAX = 3000;
const RE = /\[\[\s*CONSULTAR\s+([a-z][a-z0-9-]{1,40})\s*:\s*([\s\S]*?)\]\]/gi;

/** Consultas pedidas en un texto, sin repetir agente y sin consultarse a sí mismo. `unknown` lista los nombres que no existen. */
export function parseConsults(text, valid, self) {
  const asks = []; const unknown = []; const seen = new Set();
  for (const m of String(text ?? '').matchAll(RE)) {
    const agent = m[1].toLowerCase(); const question = m[2].replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX);
    if (!question || agent === self || seen.has(agent)) continue;
    if (!valid.has(agent)) { if (!unknown.includes(agent)) unknown.push(agent); continue; }
    seen.add(agent);
    if (asks.length < MAX_CONSULTS) asks.push({ agent, question });
  }
  return { asks, unknown };
}

export const stripConsults = (text) => String(text ?? '').replace(RE, '').replace(/\n{3,}/g, '\n\n').trim();

/** Instrucciones que se añaden al prompt de un agente que puede pedir ayuda. */
export const protocolPrompt = (names, self) => [
  '--- Colaboración con otros agentes ---',
  'Si para hacer bien tu misión necesitas la opinión o el trabajo de otro especialista, no lo inventes: pídeselo terminando tu respuesta con líneas EXACTAS con este formato (máximo ' + MAX_CONSULTS + '):',
  '[[CONSULTAR nombre-del-agente: tu pregunta concreta, con el contexto necesario]]',
  'El sistema le preguntará a ese agente (solo lectura) y te devolverá su respuesta para que completes la misión. Úsalo solo si de verdad hace falta; si puedes resolverlo tú, hazlo.',
  `Agentes disponibles: ${names.filter((n) => n !== self).join(', ')}.`,
].join('\n');

export const alreadyConsultedPrompt = 'Ya recibiste las respuestas de tus colegas: intégralas y completa la misión. No pidas más consultas.';

/** Misión que recibe el colega consultado. */
export function consultBrief(parent, question) {
  return [
    `El agente «${parent.agent}» está trabajando en la misión #${parent.id} («${parent.title}») y necesita tu ayuda como especialista.`,
    `Su pregunta: ${question}`,
    ...(parent.description ? [`Contexto de la misión: ${parent.description.slice(0, CONTEXT_MAX)}`] : []),
    'Responde en español, directo y concreto, solo con lo que te piden. No modifiques archivos.',
  ].filter(Boolean).join('\n\n');
}

/** Texto que se entrega al agente original con las respuestas de sus colegas. */
export function answersPrompt(answers) {
  return ['Respuestas de los colegas que consultaste:', ...answers.map((a) => (a.error
    ? `[${a.agent}] No pudo responder: ${a.error}`
    : `[${a.agent}] ${String(a.text ?? '').slice(0, ANSWER_MAX)}`))].join('\n\n');
}
