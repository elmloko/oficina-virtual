// Bot de Telegram para mandar y seguir misiones desde el celular (long polling: el PC solo hace conexiones de salida,
// no hay que abrir puertos ni exponer la oficina a internet).
// Seguridad: el token viene de TELEGRAM_BOT_TOKEN; solo responde a los chats privados listados en
// TELEGRAM_ALLOWED_CHATS (vacío = bot apagado); desde aquí solo se crean misiones de SOLO LECTURA y nunca se
// aplican cambios ni se confirman ediciones.
import { attentionItems, transition, KIND_LABEL } from '../public/attention.js';

const API = 'https://api.telegram.org';
const MAX_TEXT = 3800; // el límite de Telegram es 4096; se deja margen
const NEW_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 }; // /nueva por ventana: si algo se desboca, no llena la cola

export const HELP = [
  'Comandos:',
  '/estado — cola y costo de hoy',
  '/pendientes — lo que espera tu atención',
  '/nueva agente [@proyecto]: título — crea y lanza una misión de solo lectura',
  '/ver 12 — estado y resultado de la misión #12',
  '/responder 12 texto — responde al agente y sigue trabajando',
  '/aprobar 12 — marca la misión como completada',
  '/cancelar 12 — detiene la misión',
  '',
  'Editar archivos, aplicar cambios y borrar solo se hace desde la oficina.',
].join('\n');

const clip = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n…(recortado: ábrelo en la oficina para ver todo)` : s);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const STATUS = { backlog: 'pendiente', queued: 'en cola', running: 'en misión', review: 'por revisar', done: 'completada', failed: 'fallida' };

/** Lista de ids de chat permitidos a partir de "123, 456". Descarta todo lo que no sea numérico. */
export function parseAllowed(raw) {
  return new Set(String(raw ?? '').split(/[,\s;]+/).filter((x) => /^-?\d+$/.test(x)));
}

export function createTelegramBot({ token, allowed, api, fetchFn = fetch, logger = { info() {}, warn() {}, error() {} }, now = Date.now, pollSeconds = 25 }) {
  if (!token) throw new Error('Falta el token del bot');
  const redact = (s) => String(s).split(token).join('***');
  let running = false;
  let offset = 0;
  let abort = null;
  const prev = new Map(); // id de misión -> último estado visto
  const notified = new Set();
  const newTimes = [];

  async function tg(method, params = {}, signal) {
    const res = await fetchFn(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(redact(`Telegram ${method}: ${data.description ?? res.status}`));
    return data.result;
  }
  const say = (chatId, text) => tg('sendMessage', { chat_id: chatId, text: clip(text), disable_web_page_preview: true }).catch((e) => logger.warn(`No se pudo enviar a Telegram: ${redact(e.message)}`));

  const idOf = (arg) => { const m = /^#?(\d+)\b/.exec(arg ?? ''); return m ? Number(m[1]) : null; };
  const failMsg = (r) => `✖ ${r.body?.error ?? `Error ${r.status}`}`;

  const commands = {
    async ayuda() { return HELP; },
    async start() { return `Hola, soy la Base Rebelde.\n\n${HELP}`; },
    async estado() {
      const r = await api('GET', '/api/state');
      if (r.status !== 200) return failMsg(r);
      const { stats: s, costs: c, tasks } = r.body;
      const attn = attentionItems(tasks).length;
      return [
        `Claude ${s.active.claude}/${s.limit?.claude ?? '?'} · Ollama ${s.active.ollama}/${s.limit?.ollama ?? '?'} · ${s.waiting} en espera${s.paused ? ' · COLA EN PAUSA' : ''}`,
        `Hoy: $${(c?.today ?? 0).toFixed(2)}${c?.daily_budget_usd ? ` de $${c.daily_budget_usd}` : ''}`,
        attn ? `${attn} misión(es) esperan tu atención (/pendientes)` : 'Nada espera tu atención',
      ].join('\n');
    },
    async pendientes() {
      const r = await api('GET', '/api/state');
      if (r.status !== 200) return failMsg(r);
      const items = attentionItems(r.body.tasks);
      if (!items.length) return 'Nada espera tu atención ✔';
      return items.slice(0, 12).map((i) => `#${i.task.id} · ${KIND_LABEL[i.kind]} · ${i.task.agent}\n   ${oneLine(i.task.title).slice(0, 90)}`).join('\n')
        + (items.length > 12 ? `\n…y ${items.length - 12} más` : '');
    },
    async nueva(arg) {
      const m = /^(\S+)(?:\s+@(\S+))?\s*:\s*([\s\S]+)$/.exec(arg ?? '');
      if (!m) return 'Uso: /nueva agente [@proyecto]: título\nEj.: /nueva reviewer @syspaqueteria: revisar el módulo de guías';
      const t = now();
      while (newTimes.length && t - newTimes[0] > NEW_LIMIT.windowMs) newTimes.shift();
      if (newTimes.length >= NEW_LIMIT.max) return `Límite alcanzado: máximo ${NEW_LIMIT.max} misiones nuevas cada ${NEW_LIMIT.windowMs / 60000} min desde Telegram.`;
      const text = m[3].trim();
      const created = await api('POST', '/api/tasks', { title: text.slice(0, 200), description: text.length > 200 ? text : '', agent: m[1], project: m[2] ?? '', mode: 'read', engine: 'auto' });
      if (created.status !== 201) return failMsg(created);
      newTimes.push(t);
      const id = created.body.id;
      const run = await api('POST', `/api/tasks/${id}/run`, {});
      if (run.status !== 202) return `Misión #${id} creada, pero no se pudo lanzar: ${run.body?.error ?? run.status}`;
      return `✔ Misión #${id} lanzada (${m[1]}${m[2] ? ` · ${m[2]}` : ''}, solo lectura). Te aviso cuando termine.`;
    },
    async ver(arg) {
      const id = idOf(arg);
      if (!id) return 'Uso: /ver 12';
      const state = await api('GET', '/api/state');
      const t = state.body?.tasks?.find((x) => x.id === id);
      if (!t) return `No existe la misión #${id}`;
      return [`#${t.id} ${oneLine(t.title)}`, `${t.kind === 'objective' ? 'coordinador' : t.agent}${t.project ? ` · ${t.project}` : ''} · ${STATUS[t.status] ?? t.status}${t.cost_usd ? ` · $${t.cost_usd.toFixed(3)}` : ''}`,
        ...(t.error ? [`Error: ${t.error}`] : []), '', t.result?.trim() || '(sin resultado todavía)'].join('\n');
    },
    async responder(arg) {
      const m = /^#?(\d+)\s+([\s\S]+)$/.exec(arg ?? '');
      if (!m) return 'Uso: /responder 12 tu mensaje';
      const r = await api('POST', `/api/tasks/${m[1]}/reply`, { text: m[2].trim() });
      if (r.status === 409 && r.body?.needsConfirm) return `✖ La misión #${m[1]} puede editar archivos y eso hay que confirmarlo en la oficina.`;
      return r.status === 202 ? `✔ Respuesta enviada a #${m[1]}: el agente sigue trabajando.` : failMsg(r);
    },
    async aprobar(arg) {
      const id = idOf(arg);
      if (!id) return 'Uso: /aprobar 12';
      const r = await api('PATCH', `/api/tasks/${id}`, { status: 'done' });
      return r.status === 200 ? `✔ Misión #${id} marcada como completada.` : failMsg(r);
    },
    async cancelar(arg) {
      const id = idOf(arg);
      if (!id) return 'Uso: /cancelar 12';
      const r = await api('POST', `/api/tasks/${id}/cancel`, {});
      return r.status === 200 ? `✔ Misión #${id} cancelada.` : failMsg(r);
    },
  };

  /** Procesa una actualización de Telegram. Devuelve la respuesta enviada (o null si se ignoró). */
  async function handleUpdate(u) {
    const msg = u.message;
    if (!msg?.text || !msg.chat) return null;
    if (msg.chat.type !== 'private' || !allowed.has(String(msg.chat.id))) {
      logger.warn(`Telegram: mensaje ignorado de un chat no autorizado (id ${msg.chat.id}). Para autorizarlo, añade ese id a TELEGRAM_ALLOWED_CHATS.`);
      return null;
    }
    const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(msg.text.trim());
    const cmd = m && commands[m[1].toLowerCase()];
    let reply;
    if (!cmd) reply = 'No entendí. Escribe /ayuda para ver los comandos.';
    else {
      try { reply = await cmd(m[2]?.trim()); } catch (e) { logger.error(`Telegram /${m[1]}: ${redact(e.message)}`); reply = '✖ Error interno al procesar el comando.'; }
    }
    await say(msg.chat.id, reply);
    return reply;
  }

  /** Avisa cuando una misión termina, falla o pregunta. Los textos largos no salen del PC salvo que los pidas con /ver. */
  async function notifyOnce() {
    const r = await api('GET', '/api/state');
    if (r.status !== 200) return;
    const first = prev.size === 0 && !notifyOnce.seeded;
    notifyOnce.seeded = true;
    for (const t of r.body.tasks) {
      const ev = first ? null : transition(prev.get(t.id), t);
      prev.set(t.id, t.status);
      if (!ev) continue;
      const key = `${t.id}:${t.status}:${t.finished_at}`;
      if (notified.has(key)) continue;
      notified.add(key);
      const body = ev.kind === 'question' ? `\n\n${(t.result ?? '').trim().slice(-500)}\n\nResponde con /responder ${t.id} …` : `\n\n/ver ${t.id} para leer el resultado`;
      for (const chat of allowed) await say(chat, `${KIND_LABEL[ev.kind]} · #${t.id} ${oneLine(t.title).slice(0, 100)}${body}`);
    }
  }

  async function pollOnce(timeout = pollSeconds) {
    abort = new AbortController();
    const updates = await tg('getUpdates', { offset, timeout, allowed_updates: ['message'] }, abort.signal);
    for (const u of updates) { offset = Math.max(offset, u.update_id + 1); await handleUpdate(u); }
    return updates.length;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function start() {
    if (running) return;
    running = true;
    try { // lo que se escribió con el PC apagado no se ejecuta al volver: podría estar desactualizado
      const old = await tg('getUpdates', { offset: -1, timeout: 0 });
      if (old.length) { offset = old.at(-1).update_id + 1; logger.info('Telegram: se omitieron los mensajes anteriores al arranque'); }
    } catch (e) { logger.warn(`Telegram: no se pudo conectar (${redact(e.message)}). Reintentando…`); }
    const timer = setInterval(() => notifyOnce().catch((e) => logger.warn(`Telegram aviso: ${redact(e.message)}`)), 8000);
    timer.unref?.();
    start.timer = timer;
    logger.info(`Bot de Telegram activo para ${allowed.size} chat(s)`);
    (async () => {
      let wait = 2000;
      while (running) {
        const t0 = Date.now();
        try { if (!(await pollOnce()) && Date.now() - t0 < 1000) await sleep(1000 - (Date.now() - t0)); wait = 2000; } catch (e) { // sin mensajes y sin espera: pausa mínima para no girar en vacío
          if (!running) break;
          logger.warn(`Telegram: ${redact(e.message)}`);
          await sleep(wait); wait = Math.min(wait * 2, 60_000);
        }
      }
    })();
  }
  function stop() { running = false; abort?.abort(); clearInterval(start.timer); }

  return { start, stop, handleUpdate, notifyOnce, pollOnce };
}

/** Crea el bot desde variables de entorno, o devuelve null (con un aviso) si no está configurado. */
export function telegramFromEnv({ env = process.env, api, logger, fetchFn }) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  const allowed = parseAllowed(env.TELEGRAM_ALLOWED_CHATS);
  if (!allowed.size) {
    logger?.warn('TELEGRAM_BOT_TOKEN está definido pero TELEGRAM_ALLOWED_CHATS está vacío: el bot queda apagado (no responde a nadie).');
    return null;
  }
  return createTelegramBot({ token, allowed, api, logger, fetchFn });
}
