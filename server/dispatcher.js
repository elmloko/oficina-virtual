// Elección automática del agente para una misión nueva.
// 1) Heurística local (gratis e instantánea) sobre palabras clave y descripciones de los agentes.
// 2) Si hay duda, se le pregunta a Claude (modelo rápido) cuál encaja o si hace falta uno nuevo.
// 3) Solo si ninguno encaja, se crea un agente nuevo (archivo .md en la carpeta de agentes), con permisos mínimos.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set('de la el los las un una unos unas y o a en con por para que se su sus al del lo le les es son ser esta este esto estos estas como mas muy sin sobre entre hay ya no si me mi tu nuestro quiero necesito favor hacer haz crear crea revisar revisa'.split(' '));
const tokens = (s) => norm(s).split(/[^a-z0-9+#]+/).filter((t) => t.length >= 3 && !STOP.has(t));

/** Palabras que delatan cada especialidad (sin acentos; se comparan por raíz de 5 letras). */
export const HINTS = {
  backend: 'api endpoint controlador laravel php rest validacion autenticacion servicio eloquent ruta middleware',
  frontend: 'interfaz componente react vue css html boton pantalla formulario javascript tailwind vista modal',
  fullstack: 'funcionalidad completa modulo extremo',
  dba: 'sql mysql postgres indice esquema tabla consulta query base datos migracion',
  devops: 'docker despliegue deploy servidor nginx contenedor entorno',
  cicd: 'pipeline workflow actions gitlab release integracion continua',
  security: 'seguridad vulnerabilidad xss csrf inyeccion permisos secretos owasp autorizacion auditoria tenant',
  netsec: 'firewall tls ssl iam red hardening certificado',
  tester: 'prueba pruebas test tests phpunit pest cobertura unitaria',
  e2e: 'playwright e2e flujo usuario navegador',
  reviewer: 'bugs regresion codigo cambios diff',
  debugger: 'error falla excepcion traza depurar reproducir diagnostico 500 crash',
  refactor: 'refactor simplificar limpiar duplicado legible',
  performance: 'lento rendimiento optimizar velocidad cache memoria latencia',
  docs: 'documentacion readme changelog manual guia tecnica',
  architect: 'arquitectura estructura planificar diseno sistema escalar',
  researcher: 'investigar investiga comparar alternativas estado arte benchmark',
  analyst: 'datos csv metricas analisis excel estadistica',
  reporter: 'informe reporte ejecutivo resumen estado',
  summarizer: 'resumir sintetizar resumen',
  translator: 'traducir traduccion ingles espanol localizacion',
  copywriter: 'texto copy microcopy email redaccion mensaje',
  landing: 'landing conversion marketing',
  designer: 'diseno visual identidad prototipo',
  'ui-designer': 'layout tipografia color interfaz maqueta',
  'design-system': 'tokens sistema diseno componentes biblioteca',
  illustrator: 'icono ilustracion svg logo grafico',
  motion: 'animacion transicion microinteraccion lottie',
  brand: 'marca nombre logotipo paleta voz',
  dataviz: 'grafico dashboard visualizacion panel chart',
  mobile: 'movil android ios native pwa celular',
  integrator: 'integracion courier pago webhook erp externa conexion',
  'api-designer': 'openapi contrato versionado swagger',
  'spec-writer': 'especificacion prd historia usuario requisitos criterios',
  migrator: 'migrar actualizar version upgrade framework',
  'deps-auditor': 'dependencias composer npm licencias obsoleto paquetes',
  'backup-dr': 'respaldo backup recuperacion desastre restaurar',
  sre: 'incidente logs alertas observabilidad postmortem monitoreo',
  'cost-optimizer': 'costo gasto factura ahorro presupuesto nube',
  cloud: 'aws gcp azure cloudflare vercel hosting',
  iac: 'terraform pulumi cloudformation infraestructura codigo',
  k8s: 'kubernetes helm pods cluster',
  a11y: 'accesibilidad wcag lector pantalla contraste',
  responsive: 'compatibilidad dispositivos celular tablet adaptable',
  scraper: 'scraping extraer raspar sitio web',
  'windows-admin': 'windows powershell wsl registro servicio',
  'legal-docs': 'terminos privacidad contrato legal condiciones',
  proposal: 'propuesta cotizacion comercial cliente',
  presentation: 'presentacion diapositivas slides deck',
  'pr-writer': 'commit pull request mensaje cambios',
  'figma-to-code': 'figma diseno codigo componente',
  'ux-researcher': 'usabilidad ux heuristica usuarios flujo',
};
const CATCH_ALL = 'claude';
const HINT_W = 3;
const SEEN = { confident: 3, margin: 2 };

/** ¿El agente puede escribir archivos? (tools vacío o "*" = todas). */
export const canEdit = (a) => !a.tools || a.tools.trim() === '*' || /\b(Edit|Write)\b/.test(a.tools) || /^all/i.test(a.tools);

/** Dos palabras coinciden si comparten un prefijo largo (cubre plurales y conjugaciones, pero no «especialista» ~ «especificación»). */
const same = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= Math.max(5, Math.min(a.length, b.length) - 2);
};

/** Puntúa los agentes para una misión. Devuelve la lista ordenada de { agent, score }. */
export function rank(task, agents) {
  const words = [...new Set(tokens(`${task.title ?? ''} ${task.description ?? ''}`))];
  if (!words.length) return [];
  const descWords = agents.map((a) => [...new Set(tokens(`${a.name.replace(/-/g, ' ')} ${a.description}`))]);
  const df = (w) => descWords.filter((set) => set.some((d) => same(d, w))).length || 1; // lo común a muchos agentes pesa menos
  return agents.map((a, i) => {
    let score = 0;
    const hints = tokens(HINTS[a.name] ?? '');
    for (const w of words) {
      if (hints.some((h) => same(h, w))) score += HINT_W;
      else if (descWords[i].some((d) => same(d, w))) score += 1 / Math.sqrt(df(w));
    }
    return { agent: a.name, score: Math.round(score * 100) / 100 };
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score || x.agent.localeCompare(y.agent));
}

const SLUG_RE = /^[a-z][a-z0-9-]{2,29}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Valida y escribe el archivo de un agente nuevo. `wx`: nunca pisa uno existente. */
export async function createAgentFile(dir, spec, { edit = false, existing = [] } = {}) {
  const name = String(spec?.name ?? '').toLowerCase().trim();
  if (!SLUG_RE.test(name)) throw new Error('Nombre de agente inválido');
  if (existing.includes(name)) throw new Error('Ya existe un agente con ese nombre');
  const description = clean(spec.description, 200);
  const prompt = String(spec.prompt ?? '').replace(/\u0000/g, '').replace(/^---\s*$/gm, '—').trim().slice(0, 1500);
  if (description.length < 10 || prompt.length < 20) throw new Error('La definición del agente es demasiado corta');
  const tools = edit ? 'Read, Grep, Glob, Edit, Write, Bash' : 'Read, Grep, Glob, Bash, WebFetch, WebSearch';
  const body = `---\nname: ${name}\ndescription: "${description}"\ntools: ${tools}\n---\n${prompt}\nMétodo: 1) lee el código o los datos reales antes de opinar; 2) haz lo mínimo que resuelva el problema; 3) verifica con evidencia y reporta resultados reales, incluidos los fallos; 4) cierra con un resumen breve. Responde en español.\n`;
  await writeFile(join(dir, `${name}.md`), body, { flag: 'wx' });
  return { name, description, tools };
}

function askPrompt(task, agents, mode) {
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  return `Eres el despachador de una oficina de agentes. Elige quién debe hacer esta misión.

MISIÓN
Título: ${task.title}
Descripción: ${task.description || '(sin descripción)'}
Proyecto: ${task.project || '(ninguno)'} · Modo: ${mode === 'edit' ? 'puede editar archivos' : 'solo lectura'}

AGENTES EXISTENTES
${list}

Reglas: prefiere SIEMPRE un agente existente. Propón uno nuevo únicamente si ninguno de la lista puede hacer la misión razonablemente.
Responde SOLO con un JSON, sin texto alrededor:
{"agent":"<nombre exacto>","reason":"<una frase>"}
o, si de verdad hace falta uno nuevo:
{"create":{"name":"<minusculas-con-guiones>","description":"<una frase: qué hace>","prompt":"<instrucciones del agente, 2-5 frases>"},"reason":"<por qué ninguno sirve>"}`;
}

export function parseDecision(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Pregunta a `claude -p` (modelo rápido, sin herramientas). Devuelve el texto de respuesta. */
export function askClaude(prompt, { spawnFn = spawn, env = process.env, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('claude', ['-p', '--output-format', 'json', '--model', 'haiku', '--permission-mode', 'plan', '--no-session-persistence'],
      { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('El despachador tardó demasiado')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(`claude terminó con código ${code}`));
      try { const j = JSON.parse(out); resolve(typeof j.result === 'string' ? j.result : out); } catch { resolve(out); }
    });
    child.stdin.end(prompt);
  });
}

/**
 * Crea el despachador. `ask(prompt)` es inyectable para pruebas.
 * choose(task) -> { agent, created?: {name, description}, via: 'heuristica'|'claude'|'respaldo', reason }
 */
export function createDispatcher({ listAgents, agentsDir, ask = (p) => askClaude(p), logger = { warn() {}, info() {} } }) {
  async function choose(task) {
    const mode = task.mode === 'edit' ? 'edit' : 'read';
    const all = listAgents();
    const agents = all.filter((a) => mode !== 'edit' || canEdit(a));
    if (!agents.length) throw new Error('No hay agentes disponibles');
    const ranked = rank(task, agents);
    const [best, second] = ranked;
    if (best && best.score >= SEEN.confident && best.score - (second?.score ?? 0) >= SEEN.margin) {
      return { agent: best.agent, via: 'heuristica', reason: `encaja por palabras clave (${best.agent})` };
    }
    try {
      const d = parseDecision(await ask(askPrompt(task, agents, mode)));
      const names = new Set(agents.map((a) => a.name));
      if (d?.agent && names.has(d.agent)) return { agent: d.agent, via: 'claude', reason: clean(d.reason, 160) };
      if (d?.create) {
        const created = await createAgentFile(agentsDir, d.create, { edit: mode === 'edit', existing: all.map((a) => a.name) });
        return { agent: created.name, created, via: 'claude', reason: clean(d.reason, 160) };
      }
      logger.warn('Despachador: respuesta sin agente válido; se usa el respaldo');
    } catch (e) { logger.warn(`Despachador: ${e.message}; se usa el respaldo`); }
    const fallback = best?.agent ?? (agents.find((a) => a.name === CATCH_ALL) ?? agents[0]).name;
    return { agent: fallback, via: 'respaldo', reason: best ? 'la mejor coincidencia local (no se pudo consultar a Claude)' : 'agente general (no se pudo consultar a Claude)' };
  }
  return { choose };
}
