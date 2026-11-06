// Elige motor y modo de ejecución. Reglas conservadoras: lo que toca infraestructura
// real nunca se ejecuta con permisos de edición (skill infra-safety).
import { READ_MODES } from './modes.js';

const INFRA = new Set(['devops', 'cicd', 'iac', 'k8s', 'cloud', 'sre', 'netsec', 'backup-dr', 'windows-admin']);
const LIGHT = new Set(['summarizer', 'translator', 'copywriter']);

// Probado en este equipo (CPU, sin GPU): gemma3:4b responde directo y en buen español, sin relleno ni «pensar» largo.
export const OLLAMA_MODELS = {
  light: 'gemma3:4b',
  writer: 'gemma3:4b',
};

const ENGINE_NAME = { claude: 'Claude Code', ollama: 'Ollama', codex: 'Codex' };

/** `down`: motores encendidos en Sistema pero con el servidor apagado: Auto los esquiva (si se elige a mano, falla con mensaje claro).
 * `off`: motores locales apagados por el usuario ('claude', 'ollama'). Si el elegido está apagado, devuelve `blocked`. */
export function route({ agent, engine = 'auto', mode = 'read', project = null }, off = [], down = []) {
  const extra = typeof project === 'string' && project.startsWith('@'); // carpetas extra: solo lectura
  const server = typeof project === 'string' && project.startsWith('srv:'); // servidor: modo infraestructura (plan y comandos)
  const forcedRead = INFRA.has(agent) || extra;
  // «infra»: con servidor de destino opera por la oficina (lo fuerte se aprueba); sin servidor, solo entrega un plan.
  // «full»: control total de este equipo; lo eliges tú a propósito, así que ningún agente lo rebaja a solo lectura.
  // Los modos que no cambian nada (analizar, explicar, revisar, redactar…) se conservan tal cual: valen con cualquier motor.
  const readMode = READ_MODES.has(mode) ? mode : 'read';
  const finalMode = server || mode === 'infra' ? 'infra' : mode === 'full' && !extra ? 'full' : forcedRead ? readMode : mode === 'edit' ? 'edit' : readMode;
  // Editar, operar un servidor y control total valen con cualquier motor: Claude Code y Codex usan sus propias
  // herramientas y los motores de chat las de la oficina (toolloop.js). En automático, lo que actúa va a Claude Code.
  const acting = finalMode === 'edit' || finalMode === 'full';
  let finalEngine = engine;
  if (engine === 'auto') {
    finalEngine = LIGHT.has(agent) && !acting ? 'ollama' : 'claude';
    // En automático se esquiva el motor apagado si el otro puede hacer el trabajo.
    const out = [...off, ...down];
    if (finalEngine === 'ollama' && out.includes('ollama')) finalEngine = 'claude';
    else if (finalEngine === 'claude' && out.includes('claude') && !out.includes('ollama')) finalEngine = 'ollama'; // apagado o sin instalar (p. ej. en Docker)
  }
  const noEngine = engine === 'auto' && ['claude', 'ollama'].every((e) => [...off, ...down].includes(e));
  const blocked = off.includes(finalEngine) ? `${ENGINE_NAME[finalEngine]} está desactivado en Sistema`
    : noEngine && down.includes(finalEngine) ? `No hay motor disponible: ${down.includes('claude') ? 'Claude Code no está instalado aquí' : 'Claude Code está desactivado'} y Ollama está ${down.includes('ollama') ? 'apagado' : 'desactivado'}. Enciende Ollama en tu PC (o elige otro motor en la misión) y vuelve a lanzarla.`
    : null;
  return {
    blocked,
    engine: finalEngine,
    mode: finalMode,
    model: finalEngine === 'ollama' ? (agent === 'copywriter' ? OLLAMA_MODELS.writer : OLLAMA_MODELS.light) : null,
    note: forcedRead && mode === 'edit' ? (extra ? 'Carpeta extra: solo lectura.' : 'Agente de infraestructura: solo lectura/plan.') : null,
  };
}
