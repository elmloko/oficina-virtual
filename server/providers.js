// Proveedores de modelos en internet (solo chat, sin acceso a archivos ni herramientas).
// Las claves viven únicamente en variables de entorno; nunca se envían al navegador ni a los agentes.
const BUILTIN = [
  { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', keyEnv: 'OFICINA_ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', model: 'claude-haiku-5-5' },
  { name: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', model: 'gpt-4o-mini' },
  { name: 'gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', model: 'gemini-2.0-flash' },
  { name: 'openrouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', model: 'openrouter/auto' },
  { name: 'groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', model: 'llama-3.3-70b-versatile' },
  { name: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', model: 'deepseek-chat' },
];
const RESERVED = new Set(['auto', 'claude', 'ollama']);
export const MODEL_RE = /^[\w.:/@-]{1,100}$/;

/** CUSTOM_LLM="nombre|https://host/v1|NOMBRE_VAR_CLAVE|modelo;otro|..." (cualquier API compatible con OpenAI). */
function parseCustom(spec = '') {
  const out = [];
  for (const part of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, baseUrl, keyEnv, model] = part.split('|').map((s) => s?.trim());
    if (!/^[a-z][\w-]{1,30}$/.test(name ?? '') || RESERVED.has(name) || !/^https?:\/\//.test(baseUrl ?? '') || !model) continue;
    out.push({ name, kind: 'openai', baseUrl: baseUrl.replace(/\/$/, ''), keyEnv: keyEnv || null, model, custom: true });
  }
  return out;
}

/** Devuelve { nombre: {name, kind, baseUrl, key, model} } solo de los proveedores con clave configurada. */
export function loadProviders(env = process.env) {
  const out = {};
  for (const p of [...BUILTIN, ...parseCustom(env.CUSTOM_LLM)]) {
    const key = p.keyEnv ? env[p.keyEnv] : '';
    if (p.keyEnv && !key) continue; // sin clave = proveedor desactivado (los custom sin keyEnv, p. ej. LM Studio local, sí cuentan)
    out[p.name] = { name: p.name, kind: p.kind, baseUrl: p.baseUrl, key: key || '', model: (p.modelEnv && env[p.modelEnv]) || p.model };
  }
  return out;
}

/** Datos seguros para la UI: nunca incluye la clave. */
export const publicProviders = (providers) => Object.values(providers).map(({ name, kind, model }) => ({ name, kind, model }));

/** Nombres de variables con secretos de proveedores: se quitan del entorno de los procesos hijos. */
export function secretEnvNames(env = process.env) {
  return [...BUILTIN.map((p) => p.keyEnv), ...parseCustom(env.CUSTOM_LLM).map((p) => p.keyEnv)].filter(Boolean);
}

async function* sseData(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') yield d; }
    }
  }
}

/**
 * Pregunta al modelo y devuelve { text, usage }. `onText` recibe el texto a medida que llega.
 * Los errores no incluyen la clave ni cabeceras.
 */
export async function chat(provider, { model, system, prompt, signal, fetchFn = fetch, onText }) {
  const m = model || provider.model;
  const anthropic = provider.kind === 'anthropic';
  const url = anthropic ? `${provider.baseUrl}/v1/messages` : `${provider.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (anthropic) { headers['x-api-key'] = provider.key; headers['anthropic-version'] = '2023-06-01'; } else if (provider.key) headers.Authorization = `Bearer ${provider.key}`;
  const body = anthropic
    ? { model: m, max_tokens: 4096, stream: true, system, messages: [{ role: 'user', content: prompt }] }
    : { model: m, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };

  const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let detail = '';
    try { const j = JSON.parse(await res.text()); detail = j.error?.message ?? j.message ?? ''; } catch { /* sin detalle */ }
    throw new Error(`${provider.name} respondió ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
  }
  let text = '';
  const usage = { input: 0, output: 0 };
  for await (const data of sseData(res.body)) {
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    let piece = '';
    if (anthropic) {
      if (ev.type === 'content_block_delta') piece = ev.delta?.text ?? '';
      else if (ev.type === 'message_start') usage.input = ev.message?.usage?.input_tokens ?? 0;
      else if (ev.type === 'message_delta') usage.output = ev.usage?.output_tokens ?? usage.output;
      else if (ev.type === 'error') throw new Error(`${provider.name}: ${String(ev.error?.message ?? 'error').slice(0, 200)}`);
    } else {
      piece = ev.choices?.[0]?.delta?.content ?? '';
      if (ev.usage) { usage.input = ev.usage.prompt_tokens ?? 0; usage.output = ev.usage.completion_tokens ?? 0; }
    }
    if (piece) { text += piece; onText?.(piece); }
  }
  if (!text) throw new Error(`${provider.name} no devolvió texto`);
  return { text, usage, model: m };
}

/** Últimos 4 caracteres de la clave para reconocerla sin exponerla. */
export const maskKey = (key) => (key ? `••••${key.slice(-4)}` : '');

/** Todos los proveedores conocidos (con o sin clave) para administrarlos desde la web. */
export function knownProviders(env = process.env) {
  return [...BUILTIN, ...parseCustom(env.CUSTOM_LLM)].map((p) => {
    const key = p.keyEnv ? env[p.keyEnv] : '';
    return {
      name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: (p.modelEnv && env[p.modelEnv]) || p.model,
      custom: !!p.custom, keyEnv: p.keyEnv ?? null, needsKey: !!p.keyEnv, configured: !p.keyEnv || !!key, keyHint: maskKey(key),
    };
  });
}

/** Comprueba conectividad y validez de la clave con una consulta barata (lista de modelos). Nunca devuelve la clave. */
export async function testProvider(provider, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const anthropic = provider.kind === 'anthropic';
  const url = anthropic ? `${provider.baseUrl}/v1/models` : `${provider.baseUrl}/models`;
  const headers = anthropic ? { 'x-api-key': provider.key, 'anthropic-version': '2023-06-01' } : provider.key ? { Authorization: `Bearer ${provider.key}` } : {};
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t0;
    if (res.ok) return { ok: true, status: res.status, ms };
    return { ok: false, status: res.status, ms, error: res.status === 401 || res.status === 403 ? 'Clave rechazada por el proveedor' : `El proveedor respondió ${res.status}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'Tiempo agotado' : `No se pudo conectar (${e.cause?.code ?? e.name})` };
  }
}
