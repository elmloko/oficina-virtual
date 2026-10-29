// Elige motor y modo de ejecución. Reglas conservadoras: lo que toca infraestructura
// real nunca se ejecuta con permisos de edición (skill infra-safety).
const INFRA = new Set(['devops', 'cicd', 'iac', 'k8s', 'cloud', 'sre', 'netsec', 'backup-dr', 'windows-admin']);
const LIGHT = new Set(['summarizer', 'translator', 'copywriter']);

export const OLLAMA_MODELS = {
  light: 'llama3.2:3b',
  writer: 'qwen3:4b',
};

export function route({ agent, engine = 'auto', mode = 'read', project = null }) {
  const extra = typeof project === 'string' && project.startsWith('@'); // carpetas extra: solo lectura
  const forcedRead = INFRA.has(agent) || extra;
  const finalMode = forcedRead ? 'read' : mode === 'edit' ? 'edit' : 'read';
  let finalEngine = engine;
  if (engine === 'auto') finalEngine = LIGHT.has(agent) && finalMode === 'read' ? 'ollama' : 'claude';
  // Ollama no edita archivos: si piden edición, va a Claude.
  if (finalEngine === 'ollama' && finalMode === 'edit') finalEngine = 'claude';
  return {
    engine: finalEngine,
    mode: finalMode,
    model: finalEngine === 'ollama' ? (agent === 'copywriter' ? OLLAMA_MODELS.writer : OLLAMA_MODELS.light) : null,
    note: forcedRead && mode === 'edit' ? (extra ? 'Carpeta extra: solo lectura.' : 'Agente de infraestructura: solo lectura/plan.') : null,
  };
}
