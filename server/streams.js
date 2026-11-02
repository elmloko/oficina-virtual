// «Nueva tarea»: agentes especiales con una tarea y un objetivo que no terminan hasta que tú los finalices.
// Cada ciclo es una misión normal del agente; el primero arranca solo y los siguientes esperan tus instrucciones.
export const STREAM_SKINS = [
  { id: 'centinela', name: 'Centinela', color: '#7cc8ff' },
  { id: 'forjador', name: 'Forjador', color: '#ffd24a' },
  { id: 'espectro', name: 'Espectro', color: '#c08cff' },
  { id: 'vigia', name: 'Vigía', color: '#5be3a0' },
];
export const MAX_CYCLES = 200;
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** Texto que recibe el agente en cada ciclo: la tarea, el objetivo, lo ya entregado y tu instrucción. */
export function buildCyclePrompt(stream, cycles, instruction) {
  const n = cycles.length + 1;
  const done = cycles.filter((c) => c.result).slice(-5);
  const lines = [
    `Eres un agente especial de larga duración. Trabajas por ciclos y no terminas hasta que el usuario te finalice. Este es el ciclo ${n}.`,
    '', `TAREA PERMANENTE: ${stream.title}`, `OBJETIVO: ${stream.goal || '(sin objetivo adicional)'}`,
  ];
  if (done.length) {
    lines.push('', 'LO QUE YA ENTREGASTE EN CICLOS ANTERIORES (no lo repitas):');
    for (const c of done) lines.push(`- Ciclo ${c.cycle}: ${clip(c.result, 700)}`);
  }
  if (instruction) lines.push('', `INSTRUCCIÓN DEL USUARIO PARA ESTE CICLO: ${instruction}`);
  lines.push('', n === 1
    ? 'Haz el primer ciclo: avanza la tarea hacia el objetivo y entrega algo concreto.'
    : 'Haz algo NUEVO que acerque la tarea al objetivo (no repitas entregas previas).',
  'Termina con un resumen corto de lo que entregas en este ciclo y, en una línea, una propuesta de qué hacer en el siguiente.');
  return lines.join('\n');
}
