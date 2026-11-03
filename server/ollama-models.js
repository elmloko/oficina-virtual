// Modelos locales de Ollama: cuáles sirven para chatear, cuál usar por defecto en ESTA computadora y cómo medirlos.
// Nada aquí descarga modelos: solo lee lo instalado y pregunta lo mismo a cada uno.

/** Preferencia cuando no hay medición: pequeños y buenos en español (probados en un equipo sin GPU). */
export const PREFERRED = ['gemma3:4b', 'llama3.2:3b', 'phi4-mini', 'qwen3:4b', 'gemma3:1b', 'llama3.2:1b'];

export const BENCH_PROMPT = 'Resume en 2 frases en español por qué conviene hacer copias de seguridad.';
export const USABLE_TPS = 4; // por debajo de esto (tokens/s) una respuesta larga se siente demasiado lenta

const NOT_CHAT = /embed|bge-|nomic/i; // embeddings: no conversan
const SPECIALIZED = /coder|vl\b|vl:|r1|embed|bge-|nomic/i; // código, visión o razonamiento: no son para el día a día

export const isChatModel = (m) => !NOT_CHAT.test(m.name);
export const chatModels = (models = []) => models.filter(isChatModel);

const sameName = (a, b) => a === b || a === `${b}:latest` || `${a}:latest` === b;
export const hasModel = (models, name) => models.some((m) => sameName(m.name, name));

/** Modelo a usar cuando el usuario no eligió uno: el recomendado por la medición, si no el preferido instalado, si no el más pequeño. */
export function pickDefault(models, bench = null) {
  const chat = chatModels(models);
  if (!chat.length) return null;
  if (bench?.best && hasModel(chat, bench.best)) return chat.find((m) => sameName(m.name, bench.best)).name;
  for (const p of PREFERRED) { const m = chat.find((x) => sameName(x.name, p)); if (m) return m.name; }
  return [...chat].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0].name;
}

/**
 * Modelos que vale la pena medir: de chat, no especializados y que caben en la RAM libre (uno ya cargado no necesita más RAM).
 * `force`: el usuario pidió medirlos todos; solo se quitan los que no conversan (embeddings).
 */
export function benchCandidates(models, freeGb, { force = false } = {}) {
  const out = []; const skipped = [];
  for (const m of chatModels(models)) {
    const gb = (m.size ?? 0) / 1e9;
    if (force) out.push(m);
    else if (SPECIALIZED.test(m.name)) skipped.push({ name: m.name, size: m.size, reason: 'especializado (código, visión o razonamiento)' });
    else if (m.state !== 'loaded' && freeGb != null && gb > freeGb * 0.9) skipped.push({ name: m.name, size: m.size, reason: `no cabe en la RAM libre (${freeGb.toFixed(1)} GB)` });
    else out.push(m);
  }
  return { candidates: out, skipped };
}

/**
 * Recomendado: de los que responden bien y a una velocidad usable, el MÁS GRANDE (mejor calidad);
 * si ninguno llega a la velocidad usable, el más rápido.
 */
export function recommend(results) {
  const valid = results.filter((r) => r.ok && !SPECIALIZED.test(r.name));
  if (!valid.length) return null;
  const usable = valid.filter((r) => r.tps >= USABLE_TPS);
  if (usable.length) return [...usable].sort((a, b) => b.size - a.size || b.tps - a.tps)[0].name;
  return [...valid].sort((a, b) => b.tps - a.tps)[0].name;
}

/** Pregunta lo mismo a un modelo y mide. `keep_alive: 0` lo descarga después para no ocupar la RAM. */
export async function measure(model, { url, fetchFn = fetch, signal, timeoutMs = 180_000 }) {
  const t0 = Date.now();
  try {
    const res = await fetchFn(`${url}/api/chat`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: model.name, stream: false, keep_alive: 0, options: { num_predict: 200, temperature: 0 }, messages: [{ role: 'user', content: BENCH_PROMPT }] }),
    });
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
    const j = await res.json();
    const text = String(j.message?.content ?? '').trim();
    const tokens = j.eval_count ?? 0;
    const tps = j.eval_duration > 0 ? tokens / (j.eval_duration / 1e9) : 0;
    const ok = text.length >= 30;
    return {
      name: model.name, size: model.size, ok, tps: Math.round(tps * 10) / 10, tokens,
      seconds: Math.round(((j.total_duration ?? 0) / 1e9) * 10) / 10 || Math.round((Date.now() - t0) / 100) / 10,
      load_seconds: Math.round(((j.load_duration ?? 0) / 1e9) * 10) / 10,
      text: text.slice(0, 220),
      error: ok ? null : (j.message?.thinking ? 'se quedó «pensando» sin llegar a responder' : 'respuesta vacía o demasiado corta'),
    };
  } catch (e) {
    const aborted = e.name === 'AbortError' || signal?.aborted;
    return { name: model.name, size: model.size, ok: false, tps: 0, tokens: 0, seconds: Math.round((Date.now() - t0) / 100) / 10, load_seconds: 0, text: '', error: aborted ? 'cancelado o demasiado lento (más de 3 min)' : e.message };
  }
}

// ---------- LM Studio (servidor local compatible con OpenAI) ----------
/** Parámetros en miles de millones según el nombre («qwen2.5-7b-instruct» → 7); LM Studio no informa el tamaño en disco. */
export const paramsB = (name) => { const m = /(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(String(name)); return m ? Number(m[1]) : 0; };
const lmNative = (url) => url.replace(/\/v1\/?$/, '');

/** Modelos de chat que LM Studio ofrece: [{name, size(estimado), state}]. Sin servidor encendido lanza error. */
export async function listLmStudio({ url, fetchFn = fetch }) {
  let list;
  try { list = (await (await fetchFn(`${lmNative(url)}/api/v0/models`, { signal: AbortSignal.timeout(2500) })).json()).data; } catch { list = null; }
  if (!Array.isArray(list)) list = (await (await fetchFn(`${url}/models`, { signal: AbortSignal.timeout(2500) })).json()).data ?? []; // versiones sin la API nativa
  return list
    .filter((m) => !/embed/i.test(m.id) && !['embeddings', 'embedding'].includes(m.type))
    .map((m) => ({ name: m.id, size: Math.round(paramsB(m.id) * 0.55e9), size_est: true, state: m.state ?? null }));
}

/** Tokens de margen para los modelos que razonan antes de responder (Qwen3, DeepSeek-R1…): con 200 se quedan a medio pensar. */
export const THINKING_MAX_TOKENS = 1200;

/** Igual que measure() pero contra LM Studio: usa sus estadísticas nativas si las trae; si no, mide el reloj (aproximado). */
export async function measureLmStudio(model, { url, fetchFn = fetch, signal, timeoutMs = 240_000 }) {
  const t0 = Date.now();
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const ask = async (maxTokens) => {
    const body = JSON.stringify({ model: model.name, stream: false, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content: BENCH_PROMPT }] });
    let res = await fetchFn(`${lmNative(url)}/api/v0/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: sig });
    if (res.status === 404) res = await fetchFn(`${url}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: sig });
    if (!res.ok) throw new Error(`LM Studio respondió ${res.status}`);
    return res.json();
  };
  try {
    let tAsk = t0;
    let j = await ask(200);
    const thinks = (r) => String(r.choices?.[0]?.message?.reasoning_content ?? '').trim().length > 0;
    const answer = (r) => String(r.choices?.[0]?.message?.content ?? '').trim();
    if (answer(j).length < 30 && thinks(j)) { tAsk = Date.now(); j = await ask(THINKING_MAX_TOKENS); } // razonó y se quedó sin tokens: otra vez con margen
    const text = answer(j);
    const tokens = j.usage?.completion_tokens ?? 0;
    const seconds = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
    const askSeconds = (Date.now() - tAsk) / 1000; // la velocidad aproximada se calcula solo con la última petición
    const native = j.stats?.tokens_per_second;
    const tps = native ?? (tokens && askSeconds ? tokens / askSeconds : 0);
    const ok = text.length >= 30;
    return {
      name: model.name, size: model.size, size_est: model.size_est ?? true, ok, tps: Math.round(tps * 10) / 10, tokens, seconds, load_seconds: 0, approx: native == null,
      text: text.slice(0, 220), error: ok ? null : (thinks(j) ? 'se quedó «pensando» sin llegar a responder' : 'respuesta vacía o demasiado corta'),
    };
  } catch (e) {
    const aborted = e.name === 'AbortError' || signal?.aborted;
    return { name: model.name, size: model.size, size_est: model.size_est ?? true, ok: false, tps: 0, tokens: 0, seconds: Math.round((Date.now() - t0) / 100) / 10, load_seconds: 0, text: '', error: aborted ? 'cancelado o demasiado lento (más de 4 min)' : e.message };
  }
}

/** Mide uno tras otro (no a la vez: se falsearía la velocidad). `onProgress(resultsHastaAhora, actual)`. */
export async function runBenchmark(models, { url, fetchFn, signal, onProgress = () => {}, measureFn = measure }) {
  const results = [];
  for (const m of models) {
    if (signal?.aborted) break;
    onProgress(results, m.name);
    results.push(await measureFn(m, { url, fetchFn, signal }));
  }
  onProgress(results, null);
  return results;
}
