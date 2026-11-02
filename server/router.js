// Elige motor y modo de ejecución. Reglas conservadoras: lo que toca infraestructura
// real nunca se ejecuta con permisos de edición (skill infra-safety).
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
  const forcedRead = INFRA.has(agent) || extra;
  const finalMode = forcedRead ? 'read' : mode === 'edit' ? 'edit' : 'read';
  let finalEngine = engine;
  if (engine === 'auto') {
    finalEngine = LIGHT.has(agent) && finalMode === 'read' ? 'ollama' : 'claude';
    // En automático se esquiva el motor apagado si el otro puede hacer el trabajo (Ollama solo lee).
    const out = [...off, ...down];
    if (finalEngine === 'ollama' && out.includes('ollama')) finalEngine = 'claude';
    else if (finalEngine === 'claude' && off.includes('claude') && finalMode === 'read' && !out.includes('ollama')) finalEngine = 'ollama';
  }
  // Ollama y los proveedores en internet son solo chat (sin archivos): si piden edición, va a Claude.
  if (finalEngine !== 'claude' && finalMode === 'edit') finalEngine = 'claude';
  const blocked = off.includes(finalEngine)
    ? `${ENGINE_NAME[finalEngine]} está desactivado en Sistema${finalEngine === 'claude' && finalMode === 'edit' ? ' (editar archivos solo lo hace Claude Code)' : ''}`
    : null;
  return {
    blocked,
    engine: finalEngine,
    mode: finalMode,
    model: finalEngine === 'ollama' ? (agent === 'copywriter' ? OLLAMA_MODELS.writer : OLLAMA_MODELS.light) : null,
    note: forcedRead && mode === 'edit' ? (extra ? 'Carpeta extra: solo lectura.' : 'Agente de infraestructura: solo lectura/plan.') : null,
  };
}
