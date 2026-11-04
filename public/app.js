// UI sin build. Todo texto de usuario entra por textContent (nunca innerHTML).
import { createOffice, drawSkinPreview } from './office.js';
import { SKIN_LIST, AUTO, skinById, resolveSkin, deptView } from './skins.js';
import { DEPARTMENTS } from './office-layout.js';
import { attentionItems, transition, KIND_LABEL } from './attention.js';
import { createAlerts, SOUNDS } from './alerts.js';
import { threads, activeLinks, ticker as tickerText, prune } from './comms.js';
import { filterTasks, isFiltering, NO_PROJECT } from './filters.js';
import { agentMetrics, summarize, parseTs } from './metrics.js';
import { taskToMarkdown, tasksToMarkdown, printableHtml, MODE_ES } from './exporter.js';

const COLUMNS = [
  ['backlog', 'Hangar (pendientes)'],
  ['queued', 'En cola'],
  ['running', 'En misión'],
  ['review', 'Por revisar'],
  ['done', 'Completadas'],
  ['failed', 'Fallidas'],
];
const MANUAL = new Set(['backlog', 'review', 'done']);
const REVIEWERS = [['reviewer', 'Calidad del código, bugs y regresiones'], ['security', 'Seguridad, secretos y aislamiento entre tenants'], ['tester', 'Cobertura y casos de prueba que faltan']];
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

const state = {
  tasks: new Map(), agents: [], projects: [], providers: [], system: null, logs: [], stats: null, settings: {}, templates: [], schedules: [], costs: null, messages: [], flights: [], lastMsg: null,
  open: null, view: 'office', agentOpen: null, agentLive: null, booted: false,
};

// ---------- utilidades ----------
function toast(msg, isError = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'show err' : 'show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const d = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.returnValue = 'no';
    d.showModal();
  });
}

/** Ejecuta una acción que puede requerir confirmación de edición (409 needsConfirm). */
async function withConfirm(path, text, body = {}) {
  try { return await post(path, body); } catch (e) {
    if (e.status === 409 && e.data?.needsConfirm) {
      if (await confirmDialog('Permitir acciones', text ?? e.message)) return post(path, { ...body, confirm: true });
      return null;
    }
    throw e;
  }
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };

const money = (n) => `$${(n ?? 0).toFixed(n && n < 0.1 ? 3 : 2)}`;
const children = (id) => [...state.tasks.values()].filter((t) => t.parent_id === id).sort((a, b) => a.id - b.id);

// ---------- vistas ----------
function showView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `view-${v}`;
  requestAnimationFrame(fitOffice);
  if (v === 'costs') refreshCosts();
  clearInterval(showView.timer);
  if (v === 'system') { refreshSystem(); showView.timer = setInterval(refreshSystem, 2000); }
  render();
}

// ---------- Servidores (modo infraestructura): el agente planifica y tú entras a ejecutar ----------
const ENV_ES = { prod: 'producción', staging: 'pruebas', dev: 'desarrollo' };
/** Grupo «Servidores» para el selector de proyecto de Nueva misión. */
const serverOptions = () => (state.servers?.length
  ? [el('optgroup', { label: '🖥 Servidores (infraestructura)' }, ...state.servers.map((s) => el('option', { value: `srv:${s.name}`, textContent: `${s.name} · ${ENV_ES[s.env] ?? s.env}` })))]
  : []);
/** Si el destino es un servidor, el modo pasa a «infraestructura» (no se puede editar un servidor). */
/** Permiso real del modo elegido: los modos de trabajo (arreglar, laravel, srv_pull…) traen el suyo en data-level. */
const modeLevel = (sel) => sel.selectedOptions[0]?.dataset.level ?? sel.value;
function applyServerMode(form) {
  const srv = String(form.project.value).startsWith('srv:');
  for (const o of form.mode.options) if (['edit', 'full'].includes(o.dataset.level ?? o.value)) o.disabled = srv; // en un servidor solo los modos de servidor
  if (srv && modeLevel(form.mode) !== 'infra') form.mode.value = 'infra';
  if (form.engine) for (const o of form.engine.options) o.disabled = false; // editar, operar y control total valen con cualquier motor
}
/** Aviso del modo infraestructura: si falta el servidor de destino, lo dice claro (sin él Claude solo puede dejar un plan). */
function infraHint(node, form) {
  const infra = modeLevel(form.mode) === 'infra';
  const needsServer = infra && !String(form.project.value).startsWith('srv:') && ['auto', 'claude'].includes(form.engine.value);
  node.hidden = !infra;
  node.className = needsServer ? 'error' : 'hint';
  node.textContent = needsServer
    ? (state.servers?.length
      ? '⚠ Falta el servidor de destino: elígelo en «¿Dónde?» (grupo 🖥 Servidores). Sin él, el agente no puede operar nada.'
      : '⚠ Aún no tienes servidores registrados. Agrégalo en Sistema → Ajustes → Servidores (nombre, host, usuario, entorno) y vuelve aquí a elegirlo en «¿Dónde?».')
    : '🖥 Con un servidor de destino, el agente opera el servidor por SSH. Lo de solo lectura corre solo; lo fuerte (borrar, reiniciar, instalar, permisos, firewall, escribir archivos…) te lo pregunta antes, y en producción también los cambios leves. Vale con cualquier motor.';
}
function renderServers() {
  const list = state.servers ?? [];
  const setPassword = (s, password) => guard(async () => {
    const r = await api(`/api/servers/${encodeURIComponent(s.name)}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
    toast(r.has_password ? 'Contraseña guardada' : 'Contraseña quitada: se usará tu llave SSH', false);
    state.servers = await api('/api/servers'); renderServers();
  });
  $('#sys-servers').replaceChildren(...(list.length ? list.map((s) => {
    const pw = el('input', { type: 'password', placeholder: s.has_password ? 'Nueva contraseña' : 'Contraseña del servidor', autocomplete: 'new-password', maxLength: 200 });
    const form = el('form', { className: 'srv-pw', hidden: true }, pw,
      el('button', { type: 'submit', className: 'primary', textContent: 'Guardar' }),
      ...(s.has_password ? [el('button', { type: 'button', className: 'danger', textContent: 'Quitar contraseña', onclick: setPassword(s, '') })] : []));
    form.onsubmit = async (e) => { e.preventDefault(); if (pw.value) { await setPassword(s, pw.value)(); pw.value = ''; } };
    return el('div', { className: 'srv-item' }, el('div', { className: 'srv-row' },
      el('span', { className: `pill ${s.env === 'prod' ? 'bad' : 'ok'}`, textContent: ENV_ES[s.env] ?? s.env }),
      el('strong', { textContent: s.name }),
      el('span', { className: 'muted', title: s.hostkey ? `Huella fijada: ${s.hostkey}` : 'La huella se fija en la primera conexión', textContent: `${s.user ? `${s.user}@` : ''}${s.host}:${s.port} · ${s.has_password ? '🔑 contraseña guardada' : 'llave SSH'}${s.hostkey ? ' · huella ✓' : ''}${s.allow_all ? ' · 🔓 sin preguntar' : ''}${s.notes ? ` · ${s.notes}` : ''}` }),
      el('span', { className: 'srv-btns' },
        el('button', { type: 'button', className: s.allow_all ? 'danger' : '', textContent: s.allow_all ? '🔒 Volver a preguntar' : '🔓 Permitir todo', title: 'En este servidor el agente ejecuta sin preguntar (en todas las misiones)', onclick: guard(async () => {
          if (!s.allow_all && !(await confirmDialog('Permitir todo en «' + s.name + '»', 'En TODAS las misiones sobre este servidor el agente ejecutará cualquier comando sin preguntarte, incluso borrar o reiniciar' + (s.env === 'prod' ? ' — y es PRODUCCIÓN' : '') + '. Todo queda en el historial. Puedes volver a activar las preguntas aquí cuando quieras. ¿Seguro?'))) return;
          await saveServers(list.map((x) => (x.name === s.name ? { ...x, allow_all: !s.allow_all } : x)));
        }) }),
        el('button', { type: 'button', textContent: s.has_password ? 'Cambiar contraseña' : 'Poner contraseña', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) pw.focus(); } }),
        el('button', { className: 'danger', textContent: 'Quitar', onclick: guard(async () => {
          if (!(await confirmDialog('Quitar servidor', `«${s.name}» deja de aparecer como destino y se borra su contraseña guardada. No se toca el servidor real.`))) return;
          await saveServers(list.filter((x) => x.name !== s.name));
        }) }))), form);
  }) : [el('p', { className: 'hint', textContent: 'Aún no hay servidores. Agrégalos para usarlos como destino en el modo infraestructura.' })]));
}
async function saveServers(list) {
  const clean = list.map(({ has_password, hostkey, ...rest }) => rest); // la huella y la contraseña las gestiona el servidor
  state.servers = await api('/api/servers', { method: 'PUT', body: JSON.stringify({ servers: clean }) });
  renderServers(); fillSelects(); toast('Servidores guardados', false);
}
function setupServers() {
  const f = $('#server-form');
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const { password, ...s } = Object.fromEntries(new FormData(f));
    await saveServers([...(state.servers ?? []).filter((x) => x.name.toLowerCase() !== s.name.trim().toLowerCase()), s]);
    if (password) { await api(`/api/servers/${encodeURIComponent(s.name.trim())}/password`, { method: 'PUT', body: JSON.stringify({ password }) }); state.servers = await api('/api/servers'); renderServers(); toast('Contraseña guardada', false); }
    f.reset();
  });
  renderServers();
}

// ---------- Permisos de infraestructura: el agente pide ejecutar algo fuerte en un servidor y espera tu respuesta ----------
const approvalSeen = new Set();
const approvalSoundFor = new Set();
// mientras algo siga esperando tu decisión, el aviso se repite cada 30 s
setInterval(() => { if (state.approvals?.length) alerts.ask({ title: 'Sigue pendiente un permiso', body: 'Un agente espera tu decisión', onClick: showApproval }); }, 30_000);
async function refreshApprovals() {
  let list = [];
  try { list = await api('/api/approvals'); } catch { return; }
  state.approvals = list;
  const btn = $('#approvals-btn');
  btn.hidden = !list.length;
  btn.textContent = `⏸ ${list.length} ${list.length === 1 ? 'permiso pendiente' : 'permisos pendientes'}`;
  const fresh = list.some((a) => !approvalSeen.has(a.id));
  for (const a of list) approvalSeen.add(a.id);
  if (fresh) {
    const a = list.find((x) => !approvalSoundFor.has(x.id)) ?? list[0];
    alerts.ask({ title: 'Un agente pide tu permiso', body: `${a.server}: ${a.command.slice(0, 120)}`, onClick: showApproval });
  }
  for (const a of list) approvalSoundFor.add(a.id);
  const dlg = $('#approval-dialog');
  if (!list.length) { if (dlg.open) dlg.close(); return; }
  if (dlg.open || fresh) showApproval();
}
function showApproval() {
  const a = state.approvals?.[0];
  if (!a) return;
  const t = state.tasks.get(a.task_id);
  const srv = state.servers?.find((s) => s.name === a.server);
  $('#ap-title').textContent = a.critical ? '⚠ Acción destructiva: necesita tu permiso' : 'Un agente pide tu permiso';
  $('#ap-meta').textContent = `Misión #${a.task_id}${t ? ` · ${t.title}` : ''} · servidor ${a.server}${srv ? ` (${ENV_ES[srv.env] ?? srv.env})` : ''}${state.approvals.length > 1 ? ` · +${state.approvals.length - 1} más en espera` : ''}`;
  $('#ap-cmd').textContent = a.command;
  $('#ap-why').textContent = `Por qué te lo pregunta: ${a.reason}.${srv?.env === 'prod' ? ' Es un servidor de PRODUCCIÓN.' : ''}`;
  $('#ap-why').className = a.critical || srv?.env === 'prod' ? 'error' : 'hint';
  const decide = (kind) => guard(async () => {
    await post(`/api/approvals/${a.id}/${kind}`);
    toast(kind === 'approve' ? 'Aprobado: se ejecuta' : 'Rechazado: no se ejecuta', false);
    await refreshApprovals();
  });
  $('#ap-ok').onclick = decide('approve');
  $('#ap-no').onclick = decide('deny');
  $('#ap-all').onclick = guard(async () => {
    if (!(await confirmDialog('Permitir todo en esta misión', `El agente podrá ejecutar CUALQUIER comando en ${a.server} sin preguntarte, incluso borrar, reiniciar o cambiar permisos${srv?.env === 'prod' ? ' — y es PRODUCCIÓN' : ''}. Todo queda en el historial. Se apaga solo al terminar la misión, o antes desde el panel de la misión. ¿Seguro?`))) return;
    await post(`/api/tasks/${a.task_id}/allow-all`, { enabled: true });
    toast('Permitir todo: el agente ya no te preguntará en esta misión', false);
    await refreshApprovals();
  });
  if (!$('#approval-dialog').open) $('#approval-dialog').showModal();
}
function setupApprovals() {
  $('#approvals-btn').onclick = showApproval;
  $('#approval-dialog').addEventListener('close', () => {});
  refreshApprovals(); setInterval(refreshApprovals, 4000);
}

/** Ajusta el mapa para que quepa entero en la ventana (sin scroll), conservando su proporción. */
function fitOffice() {
  const stage = document.querySelector('#view-office .stage');
  const canvas = $('#office');
  if (!stage || !canvas.width || $('#view-office').hidden) return;
  const w = stage.clientWidth; const h = stage.clientHeight;
  if (!w || !h) return;
  const scale = Math.min(w / canvas.width, h / canvas.height);
  canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
  canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
  canvas.dataset.textScale = (Math.round(Math.min(1.25, Math.max(1, 0.9 / scale)) * 20) / 20).toFixed(2); // los rótulos crecen cuando el mapa se ve pequeño
}
window.addEventListener('resize', fitOffice);
if (window.ResizeObserver) new ResizeObserver(fitOffice).observe(document.body);

/** Estado de LM Studio para la cabecera: "apagado" (desactivado en Sistema), "activo" (servidor encendido) o "sin servidor"; null si aún no se sabe. */
function lmStatus() {
  const known = state.system ? state.system.providers.some((p) => p.name === 'lmstudio' && p.enabled) : state.providers.some((p) => p.name === 'lmstudio');
  if (!known) return state.system || state.modelInfo ? 'apagado' : null;
  if (!state.modelInfo) return null;
  return state.modelInfo.lmstudio_up ? 'activo' : 'sin servidor';
}

function render() {
  const s = state.stats;
  const off = s?.off ?? state.enginesOff ?? [];
  const eng = (name, key) => (off.includes(key) ? `${name} apagado` : `${name} ${s.active[key] ?? 0}/${s.limit?.[key] ?? '?'}`);
  $('#stats').textContent = s ? `${eng('Claude Code', 'claude')} · ${eng('Ollama', 'ollama')} · ${eng('Codex', 'codex')} · ${lmStatus() ? `LM Studio ${lmStatus()}${lmStatus() === 'activo' ? ` ${s.active.lmstudio ?? 0}/${s.limit?.lmstudio ?? 1}` : ''} · ` : ''}${s.waiting} en espera${s.paused ? ' · COLA EN PAUSA' : ''}` : '';
  const apiActive = s ? Object.entries(s.active).filter(([k]) => !['claude', 'ollama', 'codex', 'lmstudio'].includes(k)).reduce((a, [, v]) => a + v, 0) : 0;
  office.update({ agents: state.agents, tasks: [...state.tasks.values()], stats: s ? { ...s, off, apiActive, apiLimit: s.limit?.api ?? 1 } : null });
  office.setComms({ links: activeLinks(state.tasks), flights: state.flights });
  paintComms();
  if (state.view === 'system') renderComms();
  const attn = attentionItems([...state.tasks.values()]);
  paintBadge(attn.length);
  if (state.view === 'attention') renderAttention(attn);
  if (state.view === 'board') renderBoard();
  if (state.view === 'routines') renderRoutines();
  if (state.view === 'costs') renderMetrics();
  if (state.view === 'system' && state.system) renderSystem();
  if (state.open) drawer(state.tasks.get(state.open));
  if (state.agentOpen) renderAgent();
}

// ---------- comunicación entre agentes ----------
/** Llega un mensaje entre agentes (por WebSocket): se anota, se anima el sobre en la oficina y se avisa. */
function onMessage(msg) {
  const i = state.messages.findIndex((x) => x.id === msg.id);
  if (i >= 0) { state.messages[i] = msg; return; } // la petición se reenvía al enlazarla con la misión del colega
  state.messages.push(msg);
  if (state.messages.length > 400) state.messages.shift();
  state.flights = [...prune(state.flights, Date.now()), { from: msg.from_agent, to: msg.to_agent, kind: msg.kind, t0: Date.now() }];
  state.lastMsg = { text: tickerText(msg), at: Date.now() };
  if (!document.hidden) toast(`🤝 ${tickerText(msg)}`, false);
}

/** Pestaña (contador de consultas en curso) y rótulo bajo el mapa con el último mensaje. */
function paintComms() {
  const n = activeLinks(state.tasks).length;
  const b = $('#comms-badge');
  b.hidden = !n; b.textContent = String(n);
  const t = $('#comms-ticker');
  const fresh = state.lastMsg && Date.now() - state.lastMsg.at < 30_000;
  t.hidden = !fresh;
  if (fresh) t.textContent = ` · 💬 ${state.lastMsg.text}`;
}
setInterval(paintComms, 2000);

const when = (ts) => { try { return parseTs(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

function bubble(m) {
  const long = m.text.length > 500;
  const body = long ? el('details', {}, el('summary', { textContent: `${m.text.slice(0, 220)}…` }), el('div', { className: 'b-full', textContent: m.text })) : el('div', { className: 'b-text', textContent: m.text });
  return el('div', { className: `bubble ${m.kind}` },
    el('div', { className: 'b-head' }, el('strong', { textContent: m.from_agent }), el('span', { className: 'muted', textContent: `→ ${m.to_agent} · ${when(m.created_at)}` })),
    body);
}

function renderComms() {
  const list = $('#comms-list');
  const th = threads(state.messages, state.tasks);
  const on = state.settings.collab > 0;
  const tg = $('#collab-toggle');
  tg.textContent = on ? '🤝 Colaboración: activada' : '🚫 Colaboración: apagada';
  tg.className = on ? '' : 'danger';
  renderIfChanged(list, [th.map((x) => [x.taskId, x.items.map((m) => m.id + ':' + m.child_id), x.waiting, x.task?.status]), on], () => {
    if (!th.length) return [el('div', { className: 'empty', textContent: on ? 'Todavía no hubo comunicaciones. Cuando un agente necesite ayuda de otro especialista, la conversación aparecerá aquí.' : 'La colaboración está apagada: los agentes no pueden pedirse ayuda entre sí.' })];
    return th.map((x) => {
      const head = el('button', { type: 'button', className: 'thread-head', title: 'Abrir la misión' },
        el('span', { className: 'th-title', textContent: `#${x.taskId} ${x.task?.title ?? '(misión eliminada)'}` }),
        el('span', { className: 'th-who', textContent: `${x.asker} ⇄ ${x.helpers.join(', ')}` }),
        el('span', { className: `th-state ${x.waiting.length ? 'wait' : 'ok'}`, textContent: x.waiting.length ? `⏳ esperando a ${x.waiting.join(', ')}` : '✓ respondieron todos' }));
      if (x.task) head.onclick = () => openDrawer(x.taskId);
      return el('article', { className: 'thread' }, head, ...x.items.map(bubble));
    });
  });
}

// ---------- tablero ----------
// ---------- búsqueda y filtros del tablero ----------
const boardFilter = { q: '', agent: '', project: '', status: '' };
const filteredTasks = () => filterTasks([...state.tasks.values()], boardFilter);

function download(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mision';

/** Abre el informe en una ventana lista para imprimir: ahí se elige «Guardar como PDF». */
function printPdf(md, title) {
  const w = window.open('', '_blank');
  if (!w) { toast('El navegador bloqueó la ventana: permite pop-ups para exportar a PDF'); return; }
  w.document.write(printableHtml(md, title));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

function describeFilter(f) {
  return [f.q?.trim() && `texto «${f.q.trim()}»`, f.agent && `agente ${f.agent}`, f.project && (f.project === NO_PROJECT ? 'sin proyecto' : `proyecto ${f.project}`), f.status && `estado ${STATUS_ES[f.status] ?? f.status}`].filter(Boolean).join(', ');
}

function fillBoardTools() {
  const keep = { agent: boardFilter.agent, project: boardFilter.project, status: boardFilter.status };
  $('#f-agent').replaceChildren(el('option', { value: '', textContent: 'Todos los agentes' }), ...state.agents.map((a) => el('option', { value: a.name, textContent: a.name })));
  $('#f-project').replaceChildren(el('option', { value: '', textContent: 'Todos los proyectos' }), el('option', { value: NO_PROJECT, textContent: '(sin proyecto)' }), ...state.projects.map((p) => el('option', { value: p.name, textContent: p.name })));
  $('#f-status').replaceChildren(el('option', { value: '', textContent: 'Todos los estados' }), ...COLUMNS.map(([s, l]) => el('option', { value: s, textContent: l })));
  for (const k of Object.keys(keep)) $('#f-' + k).value = keep[k];
}

function setupBoardTools() {
  fillBoardTools();
  const apply = () => { boardFilter.q = $('#f-q').value; for (const k of ['agent', 'project', 'status']) boardFilter[k] = $('#f-' + k).value; renderBoard(); };
  $('#f-q').addEventListener('input', apply);
  for (const k of ['agent', 'project', 'status']) $('#f-' + k).addEventListener('change', apply);
  $('#f-clear').onclick = () => { $('#board-tools').reset(); apply(); };
  $('#f-export').onclick = guard(async () => {
    const list = filteredTasks().sort((a, b) => b.id - a.id);
    if (!list.length) { toast('No hay misiones para exportar con este filtro'); return; }
    const note = isFiltering(boardFilter) ? `Filtro: ${describeFilter(boardFilter)}` : '';
    download(`misiones-${new Date().toISOString().slice(0, 10)}.md`, tasksToMarkdown(list, { title: 'Misiones — Oficina Virtual', note }));
  });
}

function renderBoard() {
  const board = $('#board');
  board.replaceChildren();
  const visible = filteredTasks();
  $('#f-count').textContent = isFiltering(boardFilter) ? `${visible.length} de ${state.tasks.size}` : '';
  for (const [status, label] of COLUMNS) {
    const tasks = visible.filter((t) => t.status === status && !t.parent_id).sort((a, b) => b.id - a.id);
    // los pasos de un plan se muestran dentro de su objetivo y también sueltos, para seguimiento global
    const steps = visible.filter((t) => t.status === status && t.parent_id).sort((a, b) => a.id - b.id);
    const cards = el('div', { className: 'cards' });
    const total = tasks.length + steps.length;
    const col = el('section', { className: 'col' }, el('h2', {}, el('span', { textContent: label }), el('span', { textContent: total })), cards);
    col.dataset.status = status;
    if (MANUAL.has(status)) {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', guard(async (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const id = Number(e.dataTransfer.getData('text/plain'));
        await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      }));
    }
    for (const t of [...tasks, ...steps]) cards.append(card(t));
    board.append(col);
  }
}

function card(t) {
  const kids = t.kind === 'objective' ? children(t.id) : [];
  const c = el('article', { className: `card ${t.status}`, draggable: true, tabIndex: 0 });
  const meta = el('div', { className: 'm' },
    el('span', { textContent: t.kind === 'objective' ? '★ objetivo' : `🤖 ${t.agent}` }),
    el('span', { textContent: t.project ? `📁 ${t.project}` : 'sin proyecto' }),
    el('span', { className: 'tag', textContent: t.used_model ? `${t.engine} · ${t.used_model}` : t.engine }),
  );
  if (t.mode === 'edit') meta.append(el('span', { className: 'tag edit', textContent: 'edita' }));
  if (t.mode === 'infra') meta.append(el('span', { className: 'tag', textContent: 'infra' }));
  if (t.mode === 'full') meta.append(el('span', { className: 'tag edit', textContent: '⚡ control total' }));
  const MODE_TAG = { explain: 'explica', review: 'revisa', write: 'redacta', ideas: 'ideas', summary: 'resume', translate: 'traduce', debug_plan: 'diagnostica', sql: 'SQL', diplomado: 'diplomado', excel_help: 'Excel', compare: 'compara', docs: 'documenta', fix: 'arregla', laravel: 'Laravel', ui: 'interfaz', tests: 'tests', srv_status: 'estado', srv_pull: 'git pull', srv_web: 'HTTPS', srv_fix: 'emergencia', pc_setup: 'instala', local_ai: 'IA local', excel_files: 'Excel' };
  const kind = t.recipe || t.mode;
  if (MODE_TAG[kind]) meta.append(el('span', { className: 'tag', textContent: MODE_TAG[kind], title: MODE_ES[kind] }));
  if (kids.length) meta.append(el('span', { textContent: `pasos ${kids.filter((k) => ['review', 'done'].includes(k.status)).length}/${kids.length}` }));
  if (t.parent_id) meta.append(el('span', { textContent: `↳ #${t.parent_id}` }));
  if (t.review_of) meta.append(el('span', { textContent: `revisa #${t.review_of}` }));
  if (t.consult_of) meta.append(el('span', { className: 'tag collab', textContent: `🤝 consulta de #${t.consult_of}` }));
  const asked = activeLinks(state.tasks).filter((l) => l.parentId === t.id);
  if (asked.length) meta.append(el('span', { className: 'tag collab', textContent: `🤝 esperando a ${asked.map((l) => l.to).join(', ')}` }));
  if (t.chain?.length) meta.append(el('span', { textContent: `revisan: ${t.chain.join(', ')}` }));
  if (t.depends_on?.length) meta.append(el('span', { textContent: `espera ${t.depends_on.map((d) => '#' + d).join(' ')}` }));
  c.append(el('div', { className: 't', textContent: `#${t.id} ${t.title}` }), meta);
  c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(t.id)));
  c.addEventListener('click', () => openDrawer(t.id));
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDrawer(t.id); });
  return c;
}

// ---------- panel lateral ----------
async function openDrawer(id) {
  closeAgent();
  state.open = id;
  $('#d-log').replaceChildren();
  for (const ev of await api(`/api/tasks/${id}/events`)) logLine(ev);
  drawer(state.tasks.get(id));
  loadAtts(id);
}

/** Lo que pediste: en una misión, el título y la descripción; en un objetivo, el objetivo. */
function instructionBlocks(t) {
  const block = (label, text) => el('div', {}, el('h4', { textContent: label }), el('div', { className: 'it', textContent: text }));
  if (t.kind === 'objective') return [block('Objetivo', t.title), block('Detalles', t.description?.trim() || '(sin detalles)')];
  const desc = t.description?.trim();
  return desc ? [block('Instrucciones (lo que hace el agente)', desc), block('Título (solo etiqueta)', t.title)] : [block('Instrucciones (sin descripción: se usa el título)', t.title)];
}

// panel de detalle: ancho por defecto; «⤢» lo lleva a pantalla completa (se recuerda)
const DRAWER_KEY = 'oficina.drawer.full';
function setupDrawerSize() {
  const d = $('#drawer');
  try { d.classList.toggle('full', localStorage.getItem(DRAWER_KEY) === '1'); } catch { /* sin almacenamiento */ }
  $('#d-expand').onclick = () => {
    const full = d.classList.toggle('full');
    try { localStorage.setItem(DRAWER_KEY, full ? '1' : '0'); } catch { /* sin almacenamiento */ }
  };
}
function logLine(ev) { appendLine($('#d-log'), ev, state.tasks.get(state.open)); }

function drawer(t) {
  if (!t) { $('#drawer').hidden = true; state.open = null; return; }
  $('#drawer').hidden = false;
  $('#d-title').textContent = `#${t.id} ${t.title}`;
  const deps = t.depends_on?.length ? ` · depende de ${t.depends_on.map((d) => '#' + d).join(', ')}` : '';
  $('#d-meta').title = t.workdir ? `Carpeta: ${t.workdir}` : '';
  $('#d-meta').textContent = `${t.kind === 'objective' ? 'coordinador' : t.agent} · ${t.project || 'sin proyecto'} · ${t.engine}${t.used_model || t.model ? ':' + (t.used_model || t.model) : ''}/${MODE_ES[t.recipe || t.mode] ?? t.mode} · ${t.status}${deps}${t.error ? ' · ' + t.error : ''}`;
  $('#d-result').textContent = t.result || '';
  $('#d-instr').replaceChildren(...instructionBlocks(t));
  const act = $('#d-actions');
  act.replaceChildren();
  const busy = t.status === 'queued' || t.status === 'running';
  const isObj = t.kind === 'objective';
  const kids = isObj ? children(t.id) : [];

  const runLabel = isObj ? (kids.length ? 'Replanificar' : 'Planificar') : (['failed', 'review', 'done'].includes(t.status) ? 'Reintentar' : 'Ejecutar');
  const run = el('button', { className: kids.length && isObj ? '' : 'primary', textContent: runLabel, disabled: busy });
  run.onclick = guard(async () => {
    if (isObj && kids.length && !(await confirmDialog('Replanificar', 'Se generará un plan nuevo y se mantendrán los pasos anteriores. ¿Continuar?'))) return;
    await withConfirm(`/api/tasks/${t.id}/run`, 'Esta misión puede editar archivos de tu proyecto o actuar sobre un servidor (lo fuerte te lo preguntará antes). ¿Permitirlo?');
  });
  const stop = el('button', { textContent: 'Cancelar', disabled: !busy });
  stop.onclick = guard(() => post(`/api/tasks/${t.id}/cancel`));
  act.append(run, stop);
  if (t.mode === 'infra' && String(t.project ?? '').startsWith('srv:')) {
    const all = el('button', { className: t.allow_all ? 'danger' : '', textContent: t.allow_all ? '🔒 Volver a preguntar' : '🔓 Permitir todo', title: t.allow_all ? 'Ahora el agente ejecuta sin preguntar: púlsalo para que vuelva a pedirte permiso' : 'El agente deja de preguntarte en esta misión (se apaga al terminar)' });
    all.onclick = guard(async () => {
      if (!t.allow_all && !(await confirmDialog('Permitir todo en esta misión', 'El agente podrá ejecutar CUALQUIER comando en el servidor sin preguntarte, incluso borrar o reiniciar. Todo queda en el historial. Se apaga solo al terminar la misión. ¿Seguro?'))) return;
      await post(`/api/tasks/${t.id}/allow-all`, { enabled: !t.allow_all });
    });
    act.append(all);
  }

  if (isObj && kids.length) {
    const pending = kids.some((k) => ['backlog', 'failed'].includes(k.status));
    const launch = el('button', { className: 'primary', textContent: 'Lanzar plan', disabled: !pending });
    launch.onclick = guard(async () => {
      const r = await withConfirm(`/api/tasks/${t.id}/launch`, 'El plan incluye pasos que pueden editar archivos. ¿Lanzarlo?');
      if (r?.errors?.length) toast(r.errors.join(' · '));
    });
    act.append(launch);
  }
  if (t.status === 'review' && !isObj) {
    const ok = el('button', { textContent: 'Aprobar ✓' });
    ok.onclick = guard(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }));
    act.append(ok);
  }
  if (t.workdir) {
    const open = el('button', { textContent: '📂 Abrir carpeta', title: t.workdir });
    open.onclick = guard(async () => { await post(`/api/tasks/${t.id}/open-folder`); toast('Abriendo la carpeta en el Explorador', false); });
    act.append(open);
  }
  const exportMd = async () => taskToMarkdown(t, await api(`/api/tasks/${t.id}/events`));
  const mdBtn = el('button', { textContent: '⭳ .md', title: 'Descargar esta misión en Markdown' });
  mdBtn.onclick = guard(async () => download(`mision-${t.id}-${slug(t.title)}.md`, await exportMd()));
  const pdfBtn = el('button', { textContent: '⭳ PDF', title: 'Abrir versión imprimible (Guardar como PDF)' });
  pdfBtn.onclick = guard(async () => printPdf(await exportMd(), `Misión #${t.id} ${t.title}`));
  act.append(mdBtn, pdfBtn);
  const del = el('button', { className: 'danger', textContent: 'Eliminar' });
  del.onclick = guard(async () => { if (await confirmDialog('Eliminar misión', isObj && kids.length ? 'Se eliminarán también sus pasos.' : '¿Eliminar esta misión?')) await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); });
  act.append(del);

  // responder al agente (también cuando pregunta): el formulario solo se rehace si cambia la misión o su estado, para no perder el foco al escribir
  const reply = $('#d-reply');
  const canReply = FINISHED.has(t.status) && t.kind !== 'objective';
  const replySig = canReply ? JSON.stringify([t.id, t.status, t.reply_text]) : '';
  if (reply.dataset.sig !== replySig) {
    reply.dataset.sig = replySig;
    reply.replaceChildren(...(canReply ? [el('h3', { textContent: t.status === 'review' ? 'Responder / dar otra indicación' : 'Continuar la conversación' }), replyForm(t)] : []));
  }

  const talk = state.messages.filter((m) => m.task_id === t.id || m.child_id === t.id);
  renderIfChanged($('#d-comms'), talk.map((m) => [m.id, m.child_id]), () => (talk.length ? [el('h3', { textContent: `Conversación entre agentes (${talk.length})` }), ...talk.map((m) => el('div', { className: `talk ${m.kind}` }, el('strong', { textContent: `${m.from_agent} → ${m.to_agent}` }), el('span', { textContent: ` ${m.text.length > 260 ? m.text.slice(0, 260) + '…' : m.text}` })))] : []));

  renderAtts(t);
  const chg = $('#d-changes');
  const chgSig = JSON.stringify([t.id, t.status, t.change_state, t.branch]);
  if (chg.dataset.sig !== chgSig) { chg.dataset.sig = chgSig; const b = changesBlock(t); chg.replaceChildren(...(b ? [b] : [])); }
  const steps = $('#d-steps');
  steps.replaceChildren();
  const reviews = [...state.tasks.values()].filter((k) => k.review_of === t.id).sort((a, b) => a.id - b.id);
  if (reviews.length) {
    steps.append(el('h3', { textContent: 'Revisiones automáticas' }));
    for (const k of reviews) {
      const row = el('button', { className: `step ${k.status}`, textContent: `#${k.id} [${STATUS_ES[k.status] ?? k.status}] ${k.agent}` });
      row.onclick = () => openDrawer(k.id);
      steps.append(row);
    }
  }
  if (t.review_of) {
    const back = el('button', { className: 'step', textContent: `↩ Revisa la misión #${t.review_of}${state.tasks.get(t.review_of) ? ' — ' + state.tasks.get(t.review_of).title : ''}` });
    back.onclick = () => state.tasks.has(t.review_of) && openDrawer(t.review_of);
    steps.append(back);
  }
  if (kids.length) {
    steps.append(el('h3', { textContent: 'Plan' }));
    for (const k of kids) {
      const row = el('button', { className: `step ${k.status}`, textContent: `#${k.id} [${k.status}] ${k.agent} — ${k.title}` });
      row.onclick = () => openDrawer(k.id);
      steps.append(row);
    }
  }
}

// ---------- cambios de una misión que edita (rama git aislada) ----------
const FILE_STATUS = { A: 'nuevo', M: 'editado', D: 'borrado' };

function renderChanges(view, c) {
  if (!c.files.length) { view.replaceChildren(el('div', { className: 'muted', textContent: 'Sin cambios en archivos.' })); return; }
  const add = c.files.reduce((n, f) => n + f.additions, 0); const del = c.files.reduce((n, f) => n + f.deletions, 0);
  const list = el('div', { className: 'chg-files' }, ...c.files.map((f) => el('div', {},
    el('span', { className: `chg-st ${f.status}`, textContent: FILE_STATUS[f.status] ?? f.status }),
    el('span', { textContent: ` ${f.path} ` }),
    el('span', { className: 'muted', textContent: f.binary ? '(binario)' : `+${f.additions} −${f.deletions}` }))));
  const diff = el('pre', { className: 'diff' });
  for (const line of c.patch.split('\n')) {
    const k = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '';
    diff.append(el('span', { className: `dl ${k}`, textContent: line + '\n' }));
  }
  view.replaceChildren(el('div', { className: 'muted', textContent: `${c.files.length} archivo(s) · +${add} −${del}` }), list, diff,
    ...(c.truncated ? [el('div', { className: 'muted', textContent: 'El diff es muy grande y se muestra recortado.' })] : []));
}

/** Bloque con el estado de los cambios de una misión y sus acciones; null si la misión no editó archivos. */
function changesBlock(t) {
  if (!t.change_state) return null;
  const box = el('div', { className: 'changes' });
  if (t.change_state !== 'pending') {
    box.append(el('div', { className: 'muted', textContent: t.change_state === 'applied' ? '✔ Los cambios de esta misión se aplicaron a tu proyecto.' : '✖ Los cambios de esta misión se descartaron.' }));
    return box;
  }
  const busy = t.status === 'queued' || t.status === 'running';
  const view = el('div', { className: 'changes-view' });
  const show = el('button', { type: 'button', textContent: 'Ver cambios', disabled: busy });
  show.onclick = guard(async () => {
    view.replaceChildren(el('div', { className: 'muted', textContent: 'Cargando…' }));
    renderChanges(view, await api(`/api/tasks/${t.id}/changes`));
  });
  const apply = el('button', { type: 'button', className: 'primary', textContent: 'Aplicar a mi proyecto', disabled: busy });
  apply.onclick = guard(async () => {
    if (!(await confirmDialog('Aplicar cambios', `Se unirá la rama ${t.branch} a la rama actual de «${t.project}» (merge). Tu proyecto no debe tener cambios sin guardar. ¿Continuar?`))) return;
    await post(`/api/tasks/${t.id}/apply`, { confirm: true });
    toast('Cambios aplicados a tu proyecto', false);
  });
  const drop = el('button', { type: 'button', className: 'danger', textContent: 'Descartar cambios', disabled: busy });
  drop.onclick = guard(async () => {
    if (!(await confirmDialog('Descartar cambios', 'Se eliminarán la rama y la copia aislada. Tu proyecto no se toca, pero estos cambios se pierden.'))) return;
    await post(`/api/tasks/${t.id}/discard`, { confirm: true });
    toast('Cambios descartados', false);
  });
  box.append(
    el('h3', { textContent: 'Cambios en archivos' }),
    el('div', { className: 'muted', textContent: `Rama ${t.branch} · copia aislada: «${t.project}» no cambia hasta que los apliques.` }),
    el('div', { className: 'attn-actions' }, show, apply, drop), view);
  return box;
}

// ---------- panel de agente (clic en un avatar) ----------
const STATUS_ES = { backlog: 'pendiente', queued: 'en cola', running: 'en misión', review: 'por revisar', done: 'completada', failed: 'fallida' };
const HISTORY_MAX = 15;
const agentUi = { expanded: new Set(), drafts: new Map(), files: new Map(), sig: {} };

// ---------- adjuntos ----------
const ATT_MAX_BYTES = 8 * 1024 * 1024;
const ATT_MAX_FILES = 10;
const ATT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.log,.xml,.yml,.yaml,.sql,.php,.js,.ts,.css,.html';
const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Sube los archivos a una misión (uno por petición, cuerpo binario). Devuelve los mensajes de error, si hubo. */
async function uploadFiles(taskId, files) {
  const errors = [];
  for (const f of files) {
    try {
      const res = await fetch(`/api/tasks/${taskId}/attachments?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      if (!res.ok) errors.push(`${f.name}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    } catch { errors.push(`${f.name}: no se pudo subir`); }
  }
  return errors;
}

/**
 * Selector de archivos (botón + pegar capturas desde el portapapeles). Trabaja sobre el arreglo `store`,
 * que el llamador conserva para poder subir lo elegido al enviar.
 */
function filePicker(store, { pasteTarget, onChange } = {}) {
  const chips = el('div', { className: 'chips' });
  const input = el('input', { type: 'file', multiple: true, accept: ATT_ACCEPT, hidden: true });
  const hint = el('div', { className: 'h-err' });
  const draw = () => {
    chips.replaceChildren(...store.map((f, i) => {
      const x = el('button', { type: 'button', textContent: '✕', title: 'Quitar', ariaLabel: `Quitar ${f.name}` });
      x.onclick = () => { store.splice(i, 1); draw(); };
      return el('span', { className: 'chip-file' }, el('span', { textContent: `${f.name} · ${fmtSize(f.size)}`, title: f.name }), x);
    }));
    onChange?.();
  };
  const add = (list) => {
    hint.textContent = '';
    for (const f of list) {
      if (f.size > ATT_MAX_BYTES) { hint.textContent = `«${f.name}» supera ${ATT_MAX_BYTES / 1024 / 1024} MB`; continue; }
      if (store.length >= ATT_MAX_FILES) { hint.textContent = `Máximo ${ATT_MAX_FILES} archivos`; break; }
      store.push(f);
    }
    draw();
  };
  input.onchange = () => { add([...input.files]); input.value = ''; };
  const btn = el('button', { type: 'button', className: 'pick', textContent: '📎 Adjuntar', title: 'Archivos, o pega una captura con Ctrl+V' });
  btn.onclick = () => input.click();
  pasteTarget?.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].map((f) => (f.name === 'image.png' ? new File([f], `captura-${Date.now() % 100000}.png`, { type: f.type }) : f));
    if (files.length) { e.preventDefault(); add(files); }
  });
  draw();
  return { node: el('div', { className: 'files-field' }, btn, input, chips, hint), clear: () => { store.length = 0; hint.textContent = ''; draw(); } };
}

const attsCache = new Map(); // id de misión -> adjuntos ya subidos
async function loadAtts(id) {
  try { attsCache.set(id, await api(`/api/tasks/${id}/attachments`)); } catch { attsCache.set(id, []); }
  if (state.open === id) renderAtts(state.tasks.get(id));
}

function renderAtts(t) {
  const box = $('#d-atts');
  if (!t || t.kind === 'objective') { box.replaceChildren(); box.dataset.sig = ''; return; }
  const list = attsCache.get(t.id) ?? [];
  const sig = JSON.stringify([t.id, list.map((a) => a.id)]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const rows = list.map((a) => {
    const del = el('button', { type: 'button', className: 'danger', textContent: '✕', title: 'Quitar adjunto', ariaLabel: `Quitar ${a.name}` });
    del.onclick = guard(async () => { await api(`/api/attachments/${a.id}`, { method: 'DELETE' }); await loadAtts(t.id); });
    const img = a.mime.startsWith('image/') ? [el('img', { src: `/api/attachments/${a.id}`, alt: '', loading: 'lazy' })] : [];
    return el('div', { className: 'att' }, ...img, el('a', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener', textContent: a.name }), el('span', { className: 'muted', textContent: fmtSize(a.size) }), del);
  });
  const input = el('input', { type: 'file', multiple: true, accept: ATT_ACCEPT, hidden: true });
  const add = el('button', { type: 'button', textContent: '📎 Adjuntar archivo' });
  add.onclick = () => input.click();
  input.onchange = guard(async () => {
    const files = [...input.files].filter((f) => f.size <= ATT_MAX_BYTES);
    input.value = '';
    const errs = await uploadFiles(t.id, files);
    if (errs.length) toast(errs.join(' · '));
    await loadAtts(t.id);
  });
  box.replaceChildren(el('h3', { textContent: `Adjuntos (${list.length})` }), ...(rows.length ? [el('div', { className: 'atts' }, ...rows)] : []), add, input);
}

const agentTasks = (name) => [...state.tasks.values()].filter((t) => t.agent === name && t.kind !== 'objective').sort((a, b) => b.id - a.id);
const taskSecs = (t) => (t.started_at && t.finished_at ? (parseTs(t.finished_at) - parseTs(t.started_at)) / 1000 : null);

/** Quién habla en el registro: el agente y el modelo que usó (o el motor si aún no se sabe). */
const speaker = (t) => (t ? `${t.agent}${t.used_model || t.model ? ` · ${t.used_model || t.model}` : t.engine ? ` · ${t.engine}` : ''}` : 'agente');

/** Pone un mensaje tuyo anterior en el campo de respuesta más cercano para reutilizarlo. */
function reuseMessage(from, text) {
  const ta = from.closest('#drawer, .h-body, #agent-panel')?.querySelector('.reply textarea');
  if (!ta) { toast('Esta misión aún no admite respuestas: espera a que termine', false); return; }
  ta.value = text;
  ta.dispatchEvent(new Event('input')); // guarda el borrador
  ta.focus();
}

/** Una línea del registro. Lo que escribiste tú y lo que dice el agente van rotulados para distinguirlos; `t` = la misión. */
function appendLine(box, ev, t = null) {
  if (ev.kind === 'answer') return; // copia interna de la respuesta anterior; ya se ve como resultado
  if (ev.kind === 'user') {
    const line = el('div', { className: 'user', title: 'Clic para reutilizar este mensaje', tabIndex: 0 }, el('b', { className: 'who', textContent: 'TÚ' }), span(ev.text));
    line.onclick = () => reuseMessage(line, ev.text);
    line.onkeydown = (e) => { if (e.key === 'Enter') reuseMessage(line, ev.text); };
    box.append(line);
  } else if (ev.kind === 'private') { // salida que el agente pidió mostrarte solo a ti (contraseñas, datos sensibles)
    const pre = el('pre', { className: 'priv-body', textContent: ev.text, hidden: true });
    const btn = el('button', { type: 'button', className: 'mini-link', textContent: 'Mostrar' });
    btn.onclick = () => { pre.hidden = !pre.hidden; btn.textContent = pre.hidden ? 'Mostrar' : 'Ocultar'; };
    const copy = el('button', { type: 'button', className: 'mini-link', textContent: 'Copiar' });
    copy.onclick = () => navigator.clipboard?.writeText(ev.text).then(() => toast('Copiado', false), () => toast('No se pudo copiar'));
    box.append(el('div', { className: 'private' }, el('b', { className: 'who', textContent: '🔒 SOLO PARA TI' }), el('span', { className: 'muted', textContent: ' el agente no ve esto ' }), btn, ' · ', copy, pre));
  } else if (ev.kind === 'text') {
    box.append(el('div', { className: 'text' }, el('b', { className: 'who', textContent: speaker(t) }), span(ev.text)));
  } else {
    box.append(el('div', { className: ev.kind, textContent: ev.kind === 'tool' ? `⚙ ${ev.text}` : ev.kind === 'consult' ? `🤝 ${ev.text}` : ev.text }));
  }
  box.scrollTop = box.scrollHeight;
}

function openAgent(name) {
  state.open = null; $('#drawer').hidden = true;
  state.agentOpen = name; state.agentLive = null; agentUi.sig = {}; agentUi.expanded.clear();
  $('#a-log').replaceChildren();
  renderAgent();
}

function closeAgent() { state.agentOpen = null; state.agentLive = null; $('#agent-panel').hidden = true; }

async function fillHistoryBody(body, t) {
  body.replaceChildren(el('div', { className: 'muted', textContent: 'Cargando…' }));
  let events = [];
  try { events = await api(`/api/tasks/${t.id}/events`); } catch (e) { body.replaceChildren(el('div', { className: 'h-err', textContent: e.message })); return; }
  const parts = [];
  if (t.error) parts.push(el('div', { className: 'h-err', textContent: `Error: ${t.error}` }));
  parts.push(el('h3', { textContent: 'Resultado' }), el('pre', { className: 'h-result', textContent: t.result || 'Sin resultado.' }));
  if (events.length) {
    const log = el('div', { className: 'h-log' });
    for (const ev of events.slice(-40)) appendLine(log, ev, t);
    parts.push(el('h3', { textContent: events.length > 40 ? `Registro (últimas 40 de ${events.length} líneas)` : 'Registro' }), log);
  }
  const full = el('button', { type: 'button', textContent: 'Abrir misión completa' });
  full.onclick = () => openDrawer(t.id);
  parts.push(full);
  const chg = changesBlock(t);
  if (chg) parts.push(chg);
  if (FINISHED.has(t.status)) parts.push(replyForm(t));
  body.replaceChildren(...parts);
}

function historyItem(t) {
  const secs = taskSecs(t);
  const d = el('details', { className: `h-item ${t.status}` });
  d.append(el('summary', {},
    el('span', { textContent: `#${t.id} ${t.title}` }),
    el('span', { className: 'muted', textContent: [STATUS_ES[t.status] ?? t.status, t.engine, secs != null && fmtDur(secs)].filter(Boolean).join(' · ') }),
  ));
  const body = el('div', { className: 'h-body' });
  d.append(body);
  d.addEventListener('toggle', () => {
    if (d.open) { agentUi.expanded.add(t.id); fillHistoryBody(body, state.tasks.get(t.id) ?? t); } else agentUi.expanded.delete(t.id);
  });
  if (agentUi.expanded.has(t.id)) d.open = true;
  return d;
}

const FINISHED = new Set(['review', 'done', 'failed']);

/** Tus mensajes anteriores (de todas las misiones), el más reciente primero. Se pide una vez y se completa al enviar. */
const sentHistory = { list: null, loading: null };
function loadSentHistory() {
  sentHistory.loading ??= api('/api/replies/history').then((l) => { sentHistory.list = l; return l; }).catch(() => { sentHistory.loading = null; return sentHistory.list ?? []; });
  return sentHistory.loading;
}
function rememberSent(text) {
  if (sentHistory.list) sentHistory.list = [text, ...sentHistory.list.filter((x) => x !== text)];
}

/**
 * ↑/↓ en el campo de respuesta recorren lo que escribiste antes, como en una terminal.
 * Solo actúan con el cursor en la primera línea (↑) o en la última (↓), para no estorbar al editar un texto largo.
 */
function attachHistoryKeys(ta) {
  let pos = -1; // -1 = lo que estás escribiendo ahora
  let typing = '';
  ta.addEventListener('input', () => { pos = -1; });
  ta.addEventListener('keydown', async (e) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const up = e.key === 'ArrowUp';
    if (up ? ta.value.slice(0, ta.selectionStart).includes('\n') : ta.value.slice(ta.selectionEnd).includes('\n')) return;
    if (!up && pos === -1) return;
    e.preventDefault();
    const list = sentHistory.list ?? await loadSentHistory();
    if (!list.length) return;
    if (pos === -1) typing = ta.value;
    pos = up ? Math.min(pos + 1, list.length - 1) : pos - 1;
    ta.value = pos === -1 ? typing : list[pos];
    agentUi.drafts.set(Number(ta.dataset.task), ta.value);
    const end = up ? 0 : ta.value.length; // como en la terminal: ↑ deja el cursor arriba para seguir subiendo
    ta.setSelectionRange(end, end);
  });
}

/** Campo para responder al agente: la misión continúa con la conversación como contexto. El borrador sobrevive a los refrescos. */
function replyForm(t) {
  const form = el('form', { className: 'reply' });
  const recovered = !agentUi.drafts.has(t.id) && !!t.reply_text; // mensaje cancelado: vuelve al campo para corregirlo
  const ta = el('textarea', { rows: 3, maxLength: 4000, placeholder: 'Responde al agente o dale otra indicación… (Ctrl+Enter para enviar · ↑ tus mensajes anteriores)', value: agentUi.drafts.get(t.id) ?? t.reply_text ?? '' });
  ta.setAttribute('aria-label', `Responder a #${t.id}`);
  ta.dataset.task = t.id;
  ta.oninput = () => agentUi.drafts.set(t.id, ta.value);
  attachHistoryKeys(ta);
  ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } };
  if (!agentUi.files.has(t.id)) agentUi.files.set(t.id, []);
  const picker = filePicker(agentUi.files.get(t.id), { pasteTarget: ta });
  const send = el('button', { type: 'submit', className: 'primary', textContent: 'Enviar y continuar' });
  const err = el('div', { className: 'h-err' });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true; err.textContent = '';
    try {
      const files = agentUi.files.get(t.id);
      if (files.length) { // los adjuntos suben antes de enviar: el agente los ve en esta misma respuesta
        const errs = await uploadFiles(t.id, files);
        if (errs.length) { err.textContent = `No se envió: ${errs.join(' · ')}`; return; }
        picker.clear(); attsCache.delete(t.id);
      }
      const r = await withConfirm(`/api/tasks/${t.id}/reply`, 'Esta misión puede editar archivos de tu proyecto o actuar sobre un servidor (lo fuerte te lo preguntará antes). ¿Permitirlo?', { text });
      if (r) {
        const vaulted = r.vaulted ?? [];
        // el historial (↑) guarda el mensaje ya sin el valor del secreto
        const clean = vaulted.reduce((s, n) => s.replace(new RegExp(`^([ \\t]*(?:export[ \\t]+)?${n}[ \\t]*=).*$`, 'gm'), `$1{{secreto:${n}}}`), text);
        rememberSent(clean); agentUi.drafts.delete(t.id); ta.value = '';
        toast(vaulted.length ? `🔑 Guardé ${vaulted.join(', ')} en tus secretos: el agente solo ve el nombre y lo usa sin verlo` : 'Respuesta enviada: el agente sigue trabajando', false);
        if (vaulted.length) refreshVault();
      }
    } catch (x) { err.textContent = x.message; } finally { send.disabled = false; }
  };
  if (recovered) form.prepend(el('div', { className: 'reply-note', textContent: 'Cancelaste este mensaje: edítalo y reenvíalo.' }));
  form.append(ta, picker.node, el('div', { className: 'reply-row' }, send), err);
  return form;
}

function lastSection(t) {
  const secs = taskSecs(t);
  return [
    el('h3', { textContent: 'Última respuesta' }),
    el('div', { className: `h-item ${t.status} h-last` },
      el('div', { className: 'h-head' },
        el('span', { textContent: `#${t.id} ${t.title}` }),
        el('span', { className: 'muted', textContent: [STATUS_ES[t.status] ?? t.status, t.engine, secs != null && fmtDur(secs)].filter(Boolean).join(' · ') })),
      el('div', { className: 'h-body' },
        ...(t.error ? [el('div', { className: 'h-err', textContent: `Error: ${t.error}` })] : []),
        el('pre', { className: 'h-result', textContent: t.result || 'Sin resultado.' }),
        ...(changesBlock(t) ? [changesBlock(t)] : []),
        replyForm(t))),
  ];
}

const agentStats = (name) => summarize(agentMetrics([...state.tasks.values()]).find((r) => r.agent === name), { fmtDur });

async function renderAgent() {
  const name = state.agentOpen;
  if (!name) return;
  $('#agent-panel').hidden = false;
  const view = () => {
    const mine = agentTasks(name);
    const current = mine.find((t) => t.status === 'running') ?? mine.find((t) => t.status === 'queued');
    return { mine, current, last: mine.find((t) => t !== current && FINISHED.has(t.status)) };
  };
  let { mine, current, last } = view();

  // registro en vivo de la misión actual
  if ((current?.id ?? null) !== state.agentLive) {
    state.agentLive = current?.id ?? null;
    const box = $('#a-log');
    box.replaceChildren();
    if (current) {
      const id = current.id;
      const events = await api(`/api/tasks/${id}/events`).catch(() => []);
      if (state.agentLive === id && state.agentOpen === name) for (const ev of events) appendLine(box, ev, state.tasks.get(id));
    }
    if (state.agentOpen !== name) return;
    ({ mine, current, last } = view()); // mientras esperábamos pudo llegar otro cambio: no pintar con datos viejos
  }

  // cada sección se reconstruye solo si cambió, para no perder lo que el usuario está escribiendo
  const sigs = {
    head: JSON.stringify([name, appliedSkin?.id, current?.id, current?.status, current?.updated_at, agentStats(name)]),
    last: JSON.stringify(last ? [last.id, last.status, last.updated_at, last.change_state] : null),
    hist: JSON.stringify(mine.slice(0, HISTORY_MAX + 2).map((t) => [t.id, t.status, t.updated_at])),
  };

  if (sigs.head !== agentUi.sig.head) {
    const info = state.agents.find((a) => a.name === name);
    const dept = DEPARTMENTS.find((d) => d.agents.includes(name));
    $('#a-title').textContent = name;
    $('#a-stats').textContent = agentStats(name);
    $('#a-meta').textContent = [dept && deptView(dept, appliedSkin).label, info?.description].filter(Boolean).join(' · ');
    const now = $('#a-now');
    if (current) {
      const since = current.started_at ? ` · desde las ${parseTs(current.started_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` : '';
      const replying = !!current.reply_text; // la ejecución actual viene de un mensaje del usuario
      const x = el('button', { type: 'button', className: 'danger x-cancel', textContent: '✕', title: replying ? 'Detener y editar mi mensaje' : 'Cancelar esta misión', ariaLabel: `Cancelar misión #${current.id}` });
      x.onclick = guard(async () => {
        if (!(await confirmDialog(replying ? 'Detener respuesta' : 'Cancelar misión', replying
          ? 'Se detendrá al agente y volverás a tu mensaje para editarlo y reenviarlo. El trabajo en curso se pierde.'
          : `Se detendrá «${current.title}» y volverá al Hangar. El trabajo en curso se pierde.`))) return;
        await post(`/api/tasks/${current.id}/cancel`);
        toast(replying ? 'Respuesta detenida: edita tu mensaje y reenvíalo' : 'Misión cancelada', false);
      });
      now.replaceChildren(el('div', { className: 'now-row' },
        el('div', {},
          el('div', { textContent: `${current.status === 'running' ? '▶ En misión' : '⏳ En cola'}: #${current.id} ${current.title}` }),
          el('div', { className: 'muted', textContent: `${current.engine}${current.used_model || current.model ? ':' + (current.used_model || current.model) : ''}/${MODE_ES[current.recipe || current.mode] ?? current.mode}${current.project ? ' · 📁 ' + current.project : ''}${since}` }),
          ...(replying ? [el('div', { className: 'reply-sent', textContent: `Tu mensaje: «${current.reply_text.length > 200 ? current.reply_text.slice(0, 200) + '…' : current.reply_text}»` })] : [])),
        x));
    } else {
      now.replaceChildren(el('div', { textContent: mine.length ? 'Libre' : 'Libre · aún no tiene misiones' }));
    }
    const newBtn = el('button', { className: 'primary', type: 'button', textContent: 'Nueva misión' });
    newBtn.onclick = () => openTaskDialog((f) => { f.agent.value = name; updateWho(true); });
    $('#a-actions').replaceChildren(newBtn);
    agentUi.sig.head = sigs.head;
  }
  if (sigs.last !== agentUi.sig.last) {
    $('#a-last').replaceChildren(...(last ? lastSection(last) : []));
    agentUi.sig.last = sigs.last;
  }
  if (sigs.hist !== agentUi.sig.hist) {
    const past = mine.filter((t) => t !== current && t !== last).slice(0, HISTORY_MAX);
    $('#a-history').replaceChildren(...(past.length ? past.map(historyItem) : [el('div', { className: 'muted', textContent: 'Sin más historial.' })]));
    agentUi.sig.hist = sigs.hist;
  }
}

// ---------- formularios ----------
const provName = (p) => (p.name === 'lmstudio' ? 'LM Studio' : p.name);
/** Motores locales cuyo servidor está apagado: no se pueden elegir (la misión fallaría). */
function serversDown() {
  const down = new Set();
  if (state.modelInfo?.ollama_up === false) down.add('ollama');
  if (state.modelInfo?.lmstudio_up === false) down.add('lmstudio');
  return down;
}

function fillSelects() {
  const f = $('#new-form');
  if (f.agent.value !== 'auto' && !state.agents.some((a) => a.name === f.agent.value)) { f.agent.value = 'auto'; updateWho(true); } // el agente fijado ya no existe
  const projectOptions = () => [el('option', { value: '', textContent: '(sin proyecto)' }), ...state.projects.map((p) => el('option', { value: p.name, textContent: p.docs ? '📄 Documentos — carpeta nueva por tema' : p.name }))];
  f.project.replaceChildren(...projectOptions(), ...serverOptions());
  const offE = state.enginesOff ?? [];
  const engines = [['auto', 'Auto (el router decide)'], ...(offE.includes('claude') ? [] : [['claude', 'Claude Code (suscripción)']]), ...(offE.includes('ollama') ? [] : [['ollama', 'Ollama (local)']]), ...(offE.includes('codex') ? [] : [['codex', 'Codex (ChatGPT)']]), ...state.providers.map((p) => [p.name, `${provName(p)} · ${p.local ? 'en este equipo' : 'en internet'} (${p.model})`])];
  const down = serversDown();
  const keep = f.engine.value;
  const shown = engines.filter(([v]) => !down.has(v)); // los de servidor apagado no se muestran
  f.engine.replaceChildren(...shown.map(([v, t]) => el('option', { value: v, textContent: t })));
  f.engine.value = shown.some(([v]) => v === keep) ? keep : 'auto'; // si el elegido se apagó, vuelve a Auto
  $('#routine-form').project.replaceChildren(...projectOptions());
  $('#routine-form').template.replaceChildren(...state.templates.map((t) => el('option', { value: t.id, textContent: `${t.name}${t.needsProject ? ' (requiere proyecto)' : ''}` })));
  const names = new Set(state.agents.map((a) => a.name));
  const reviewers = REVIEWERS.filter(([n]) => names.has(n));
  $('#review-set').hidden = !reviewers.length;
  $('#review-opts').replaceChildren(...reviewers.map(([n, why]) => el('label', { className: 'chk', title: why }, el('input', { type: 'checkbox', name: 'review', value: n }), el('span', { textContent: n }))));
  $('#days').replaceChildren(...DAYS.map((d, i) => el('label', { className: 'chk' }, el('input', { type: 'checkbox', name: 'day', value: String(i) }), el('span', { textContent: d }))));
}

/**
 * «Quién lo hará» en el formulario de misión (sustituye al selector de agente). Por defecto el agente se elige solo:
 * mientras escribes se muestra el probable (solo palabras clave, sin gastar). Desde el panel de un agente queda fijado.
 */
const whoUi = { timer: null, seq: 0 };
function updateWho(now = false) {
  const f = $('#new-form'); const box = $('#who');
  if (!f || !box) return;
  clearTimeout(whoUi.timer);
  const fixed = f.agent.value && f.agent.value !== 'auto' ? state.agents.find((a) => a.name === f.agent.value) : null;
  if (fixed) {
    const auto = el('button', { type: 'button', className: 'mini-link', textContent: 'elegir automáticamente' });
    auto.onclick = () => { f.agent.value = 'auto'; updateWho(true); };
    box.className = 'who-box fixed';
    return box.replaceChildren(el('span', { className: 'who-ico', textContent: '👤' }), el('span', {}, 'Para ', el('b', { textContent: fixed.name }), el('span', { className: 'muted', textContent: ` — ${fixed.description}` })), auto);
  }
  const title = f.title.value.trim(); const description = f.description.value.trim();
  const show = (main, sub = '', cls = '') => { box.className = `who-box ${cls}`; box.replaceChildren(el('span', { className: 'who-ico', textContent: '🤖' }), el('span', {}, ...main, sub ? el('span', { className: 'muted', textContent: ` — ${sub}` }) : '')); };
  if (!title && !description) return show(['El agente se elige solo según lo que escribas.']);
  const run = async () => {
    const seq = ++whoUi.seq;
    let p;
    try { p = await post('/api/dispatch/preview', { title, description, mode: f.mode.value }); } catch { return; }
    if (seq !== whoUi.seq || f.agent.value !== 'auto') return; // llegó tarde o ya fijaste uno
    if (p.agent && p.sure) show(['Lo hará ', el('b', { textContent: p.agent })], p.description, 'sure');
    else if (p.agent) show(['Probablemente ', el('b', { textContent: p.agent }), ' · al crearla se confirma (o se crea un agente nuevo si ninguno encaja)']);
    else show(['Al crearla se elige el mejor agente', ' (o se crea uno nuevo si ninguno encaja)']);
  };
  if (now) run(); else whoUi.timer = setTimeout(run, 350);
}

/** Resumen de «Opciones avanzadas» cerrado: se ve qué hay elegido sin abrirlo. */
function syncAdvSummary() {
  const f = $('#new-form');
  const eng = f.engine.selectedOptions[0]?.textContent?.replace(/\s*\(.*$/, '') ?? 'Auto';
  const rev = [...f.querySelectorAll('input[name=review]:checked')].map((x) => x.value);
  $('#adv-sum').textContent = `· motor: ${eng}${rev.length ? ` · revisa: ${rev.join(', ')}` : ''}`;
}

function wireDialog(dialogSel, formSel, submit) {
  const d = $(dialogSel); const f = $(formSel);
  for (const b of d.querySelectorAll('[data-close]')) b.onclick = () => d.close();
  d.addEventListener('close', () => f.reset()); // al cerrar no quedan valores viejos
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('.form-error');
    err.textContent = '';
    const all = [...f.querySelectorAll('button[type=submit], button.primary:not([type=button])')];
    const btn = e.submitter ?? all[0];
    const label = btn?.textContent;
    for (const b of all) b.disabled = true; // evita crear dos veces con un doble clic
    if (btn) btn.textContent = 'Procesando…'; // elegir agente automáticamente puede tardar unos segundos
    try { await submit(f); f.reset(); d.close(); } catch (x) { err.textContent = x.message; } finally { for (const b of all) b.disabled = false; if (btn) btn.textContent = label; }
  };
  return (setup) => { f.querySelector('.form-error').textContent = ''; setup?.(f); d.showModal(); };
}

let openTaskDialog, openObjDialog, openRoutineDialog;
const newFiles = [];

function setupForms() {
  fillSelects();
  setupBoardTools();
  const newPicker = filePicker(newFiles, { pasteTarget: $('#new-form').description });
  $('#new-files').replaceChildren(newPicker.node);
  $('#new-dialog').addEventListener('close', () => newPicker.clear());
  openTaskDialog = wireDialog('#new-dialog', '#new-form', async (f) => {
    const fd = new FormData(f);
    const body = { ...Object.fromEntries(fd), review: fd.getAll('review') };
    if (PICK_ENGINES.includes(body.engine)) body.model = body.model_pick || ''; // '' = el predeterminado del motor
    delete body.model_pick;
    const runNow = document.activeElement?.id === 'new-run' || f.dataset.run === '1';
    delete f.dataset.run;
    const task = await post('/api/tasks', body);
    if (task.auto) toast(`${task.auto.created ? 'Agente nuevo creado: ' : 'Agente elegido: '}${task.agent} — ${task.auto.reason.length > 110 ? task.auto.reason.slice(0, 110) + '…' : task.auto.reason}`, false);
    const errs = await uploadFiles(task.id, newFiles);
    if (errs.length) toast(`La misión se creó, pero fallaron adjuntos: ${errs.join(' · ')}`);
    if (runNow) {
      try {
        const r = await withConfirm(`/api/tasks/${task.id}/run`, 'Esta misión puede editar archivos de tu proyecto o actuar sobre un servidor (lo fuerte te lo preguntará antes). ¿Permitirlo?');
        toast(r ? 'Misión lanzada' : 'Misión creada en el Hangar (no se lanzó)', false);
      } catch (x) { toast(`La misión se creó pero no pudo lanzarse: ${x.message}`); }
    }
  });
  $('#new-run').addEventListener('click', () => { $('#new-form').dataset.run = '1'; });
  $('#new-save').addEventListener('click', () => { delete $('#new-form').dataset.run; });
  openObjDialog = wireDialog('#obj-dialog', '#obj-form', async (f) => {
    const o = await post('/api/objectives', Object.fromEntries(new FormData(f)));
    await post(`/api/tasks/${o.id}/run`).catch((e) => toast(e.message));
    openDrawer(o.id);
  });
  setupServers();
  setupApprovals();
  setupDrawerSize();
  openRoutineDialog = wireDialog('#routine-dialog', '#routine-form', async (f) => {
    const fd = new FormData(f);
    const tpl = state.templates.find((t) => t.id === fd.get('template'));
    const body = { template: tpl.id, project: fd.get('project') };
    const time = (fd.get('time') || '').trim();
    const days = fd.getAll('day').map(Number);
    if (time || days.length) body.spec = { type: 'daily', time: time || tpl.spec.time, days: days.length ? days : tpl.spec.days };
    await post('/api/schedules', body);
    await refreshState();
  });
  const taskForm = $('#new-form');
  const syncHint = () => {
    applyServerMode(taskForm);
    $('#mode-hint').hidden = modeLevel(taskForm.mode) !== 'edit';
    $('#full-hint').hidden = modeLevel(taskForm.mode) !== 'full';
    const desc = taskForm.mode.selectedOptions[0]?.dataset.desc ?? ''; // qué entrega el modo elegido
    $('#mode-desc').textContent = desc ? `→ ${desc}` : '';
    $('#mode-desc').hidden = !desc;
    infraHint($('#infra-hint'), taskForm);
    const prov = state.providers.find((p) => p.name === taskForm.engine.value);
    const pick = PICK_ENGINES.includes(taskForm.engine.value) ? taskForm.engine.value : null;
    $('#model-row').hidden = !prov && !pick;
    taskForm.model.hidden = !prov || !!pick;
    taskForm.model_pick.hidden = !pick;
    taskForm.model.placeholder = prov ? `por defecto: ${prov.model}` : '';
    if (pick) { const keep = taskForm.model_pick.value; taskForm.model_pick.replaceChildren(...modelOptions(pick, '')); taskForm.model_pick.value = [...taskForm.model_pick.options].some((o) => o.value === keep) ? keep : ''; }
    const hint = $('#engine-hint');
    hint.hidden = !prov;
    if (prov) hint.textContent = prov.local
      ? `🖥 ${provName(prov)} corre en tu equipo: el texto de la misión no sale de aquí. No ve archivos del proyecto y no puede editarlos.`
      : `☁ El texto de la misión (título, descripción y resultados de pasos previos) se enviará a ${prov.name}. No ve archivos del proyecto y no puede editarlos.`;
  };
  state.syncHint = syncHint;
  taskForm.mode.onchange = () => { syncHint(); updateWho(); };
  taskForm.project.onchange = syncHint;
  taskForm.engine.onchange = () => { syncHint(); syncAdvSummary(); };
  taskForm.addEventListener('change', (e) => { if (e.target.name === 'review') syncAdvSummary(); });
  taskForm.title.addEventListener('input', () => updateWho());
  taskForm.description.addEventListener('input', () => updateWho());
  taskForm.addEventListener('reset', () => setTimeout(() => { syncHint(); taskForm.agent.value = 'auto'; updateWho(true); syncAdvSummary(); $('#new-adv').open = false; }));
  const rf = $('#routine-form');
  const syncTpl = () => {
    const t = state.templates.find((x) => x.id === rf.template.value);
    $('#tpl-desc').textContent = t ? `${t.agent} · ${describeSpec(t.spec)} — ${t.description}` : '';
    if (t?.defaultProject && !rf.project.value) rf.project.value = t.defaultProject;
  };
  rf.template.onchange = syncTpl;
  rf.addEventListener('reset', () => setTimeout(syncTpl));
  // clic en el fondo cierra el modal (no el de confirmación, que exige elegir)
  for (const d of document.querySelectorAll('dialog:not(#confirm-dialog):not(#approval-dialog)')) {
    d.addEventListener('mousedown', (e) => { if (e.target === d) d.close(); });
  }
  $('#new-btn').onclick = () => { refreshModels(); openTaskDialog((f) => { syncHint(f); f.agent.value = 'auto'; updateWho(true); syncAdvSummary(); }); }; // al abrir se comprueba qué servidores siguen encendidos
  $('#obj-btn').onclick = () => openObjDialog();
  $('#new-routine').onclick = () => openRoutineDialog(syncTpl);
  setupSystem();
  $('#d-close').onclick = () => { state.open = null; $('#drawer').hidden = true; };
  $('#a-close').onclick = closeAgent;
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showView(b.dataset.view);
  $('#collab-toggle').onclick = guard(async () => {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ collab: state.settings.collab > 0 ? 0 : 1 }) });
    toast(state.settings.collab > 0 ? 'Colaboración entre agentes activada' : 'Colaboración apagada: los agentes ya no se piden ayuda', false);
    renderComms();
  });
  for (const b of document.querySelectorAll('#audit-filter button')) b.onclick = () => { state.auditFilter = b.dataset.f; renderAudit(); };
  $('#goto-engines').onclick = () => setSysTab('motores');
  $('#goto-routines').onclick = () => document.querySelector('[data-view="routines"]').click();
  $('#settings-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    toast('Ajustes guardados', false);
  });
}

// ---------- rutinas ----------
function describeSpec(s) {
  if (s.type === 'interval') return `cada ${s.minutes} min`;
  const days = s.days?.length ? s.days.map((d) => DAYS[d]).join(' ') : 'todos los días';
  return `${days} a las ${s.time}`;
}

function renderRoutines() {
  const box = $('#routines');
  box.replaceChildren();
  if (!state.schedules.length) { box.append(el('p', { className: 'hint', textContent: 'Aún no hay rutinas. Crea una desde una plantilla.' })); return; }
  for (const s of state.schedules) {
    const row = el('div', { className: 'row' });
    const info = el('div', {}, el('strong', { textContent: s.name }), el('div', { className: 'hint', textContent: `${s.agent} · ${s.project || 'sin proyecto'} · ${describeSpec(s.spec)} · última: ${new Date(s.last_run).toLocaleString()}` }));
    const toggle = el('button', { textContent: s.enabled ? 'Pausar' : 'Activar' });
    toggle.onclick = guard(async () => { await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !s.enabled }) }); await refreshState(); });
    const now = el('button', { textContent: 'Ejecutar ahora' });
    now.onclick = guard(async () => { await post(`/api/schedules/${s.id}/run`); toast('Rutina lanzada', false); });
    const del = el('button', { className: 'danger', textContent: 'Borrar' });
    del.onclick = guard(async () => { if (await confirmDialog('Borrar rutina', s.name)) { await api(`/api/schedules/${s.id}`, { method: 'DELETE' }); await refreshState(); } });
    row.append(info, el('div', { className: 'btns' }, toggle, now, del));
    if (!s.enabled) row.classList.add('off');
    box.append(row);
  }
}

// ---------- costos ----------
function table(container, headers, rows) {
  container.replaceChildren();
  if (!rows.length) { container.append(el('p', { className: 'hint', textContent: 'Sin datos todavía.' })); return; }
  const t = el('table', {}, el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { textContent: h })))), el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { textContent: String(c) }))))));
  container.append(t);
}

const FINISHED_ST = new Set(['review', 'done', 'failed']);
const ENG_NAMES = { claude: 'Claude Code', ollama: 'Ollama', codex: 'Codex', lmstudio: 'LM Studio' };
const engBadge = (e) => el('em', { className: `eng eng-${ENG_NAMES[e] ? e : 'api'}`, textContent: ENG_NAMES[e] ?? e ?? '—' });
const barCell = (rate) => el('td', { className: rate == null ? '' : rate < 0.5 ? 'bad' : rate >= 0.9 ? 'good' : '' },
  el('div', { className: 'ubar' }, el('i', { style: `width:${(rate ?? 0) * 100}%` })), span(rate == null ? '—' : ` ${Math.round(rate * 100)} %`));

function renderMetrics() {
  const all = [...state.tasks.values()].filter((t) => t.kind !== 'objective' && t.finished_at && FINISHED_ST.has(t.status));
  const secsOf = (t) => (t.started_at ? (parseTs(t.finished_at) - parseTs(t.started_at)) / 1000 : null);
  const avg = (xs) => { const v = xs.filter((x) => Number.isFinite(x) && x >= 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const okN = all.filter((t) => t.status !== 'failed').length;
  const rows = agentMetrics([...state.tasks.values()]);
  const todayK = dayKey(new Date());
  const todayN = all.filter((t) => dayKey(parseTs(t.finished_at)) === todayK).length;

  // motor y modelo
  const byEng = new Map();
  for (const t of all) {
    const k = `${t.engine ?? '—'}|${t.used_model ?? ''}`;
    const g = byEng.get(k) ?? { engine: t.engine, model: t.used_model, n: 0, ok: 0, secs: [] };
    g.n++; if (t.status !== 'failed') g.ok++; g.secs.push(secsOf(t));
    byEng.set(k, g);
  }
  const engRows = [...byEng.values()].sort((a, b) => b.n - a.n);
  const topEng = engRows[0];

  const kpi = (label, value, cls = '') => el('div', { className: `kpi ${cls}` }, el('b', { textContent: value }), span(label));
  $('#costs-kpi').replaceChildren(
    kpi('misiones terminadas', String(all.length)),
    kpi('hoy', String(todayN), todayN ? 'hot' : ''),
    kpi('éxito', all.length ? `${Math.round((okN / all.length) * 100)}%` : '—'),
    kpi('tiempo medio', fmtDur(avg(all.map(secsOf)))),
    kpi('agente más activo', rows[0]?.agent ?? '—'),
    kpi('motor más usado', topEng ? (ENG_NAMES[topEng.engine] ?? topEng.engine) : '—'));

  const none = (txt) => el('p', { className: 'hint', textContent: txt });
  const agentsBox = $('#costs-agents');
  agentsBox.replaceChildren(rows.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ...['Agente', 'Misiones', 'Éxito', 'Fallidas', 'Tiempo medio'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, el('td', { textContent: r.agent }), el('td', { textContent: String(r.tasks) }), barCell(r.rate), el('td', { textContent: String(r.failed) }), el('td', { textContent: fmtDur(r.avgSecs) })))))
    : none('Aún no hay misiones terminadas.'));
  $('#costs-engines').replaceChildren(engRows.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ...['Motor', 'Modelo', 'Misiones', 'Éxito', 'Tiempo medio'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...engRows.map((g) => el('tr', {}, el('td', {}, engBadge(g.engine)), el('td', { className: 'snip', title: g.model ?? '', textContent: g.model ?? '(sin registrar)' }), el('td', { textContent: String(g.n) }), barCell(g.n ? g.ok / g.n : null), el('td', { textContent: fmtDur(avg(g.secs)) })))))
    : none('Aún no hay misiones terminadas.'));

  // últimos 14 días: barras apiladas (correctas en verde, fallidas en rojo)
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push({ key: dayKey(d), d, ok: 0, bad: 0 }); }
  const idx = new Map(days.map((x) => [x.key, x]));
  for (const t of all) { const x = idx.get(dayKey(parseTs(t.finished_at))); if (x) { if (t.status === 'failed') x.bad++; else x.ok++; } }
  const maxD = Math.max(1, ...days.map((x) => x.ok + x.bad));
  $('#costs-days').replaceChildren(el('div', { className: 'days' }, ...days.map((x) => el('div', { className: `day${x.key === todayK ? ' today' : ''}`, title: `${x.d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}: ${x.ok + x.bad} misión(es)${x.bad ? ` (${x.bad} fallidas)` : ''}` },
    el('div', { className: 'col' }, el('i', { className: 'bad', style: `height:${(x.bad / maxD) * 100}%` }), el('i', { className: 'ok', style: `height:${(x.ok / maxD) * 100}%` })),
    el('span', { className: 'n', textContent: x.ok + x.bad ? String(x.ok + x.bad) : '' }),
    el('span', { className: 'd', textContent: String(x.d.getDate()) })))));
}

// auditoría en lenguaje normal: etiqueta, categoría y detalle legible
const ENGINE_ES = { ollama: 'Ollama', lmstudio: 'LM Studio', claude: 'Claude Code', codex: 'Codex' };
function auditInfo(a) {
  const [head, ...rest] = a.action.split('.');
  const tail = rest.join('.');
  const eng = ENGINE_ES[head];
  const detail = a.detail ?? '';
  const TASK = {
    create: 'Misión creada', run: 'Misión lanzada', reply: 'Respuesta enviada', cancel: 'Misión cancelada', delete: 'Misión borrada', apply: 'Cambios aplicados', discard: 'Cambios descartados',
    move: `Movida a «${STATUS_ES[detail] ?? detail}»`,
  };
  if (head === 'task' && TASK[tail]) return { label: TASK[tail], cat: 'task', detail: tail === 'move' ? '' : detail };
  if (eng && tail === 'server.start') return { label: `${eng}: servidor encendido`, cat: 'sys', detail: detail === 'ok' ? '' : detail };
  if (eng && tail === 'server.stop') return { label: `${eng}: servidor apagado`, cat: 'sys', detail: detail === 'ok' ? '' : detail };
  if (eng && tail === 'benchmark') return { label: `${eng}: medición de modelos`, cat: 'sys', detail };
  if (eng && tail === 'test') return { label: `${eng}: prueba`, cat: 'sys', detail };
  const OTHER = {
    'objective.create': ['Objetivo creado', 'task'], 'plan.created': ['Plan creado', 'task'], 'plan.launch': ['Plan lanzado', 'task'], 'review.chain': ['Revisión encadenada', 'task'], 'consult.create': ['Consulta entre agentes', 'task'],
    'schedule.create': ['Rutina creada', 'task'], 'schedule.delete': ['Rutina borrada', 'task'], 'schedule.run': ['Rutina ejecutada', 'task'], 'attachment.add': ['Archivo adjuntado', 'task'], 'attachment.delete': ['Adjunto borrado', 'task'], 'agent.create': ['Agente creado', 'sys'],
    'queue.pause': ['Cola en pausa', 'sys'], 'queue.resume': ['Cola reanudada', 'sys'], 'queue.cancel_all': ['Se canceló todo', 'sys'],
    'settings.update': ['Ajustes guardados', 'sys'], 'engine.enabled': ['Motor encendido', 'sys'], 'engine.disabled': ['Motor apagado', 'sys'], 'engine.model': ['Modelo cambiado', 'sys'],
    'provider.enabled': ['Proveedor encendido', 'sys'], 'provider.disabled': ['Proveedor apagado', 'sys'], 'provider.key_set': ['Clave guardada', 'sys'], 'provider.key_removed': ['Clave quitada', 'sys'],
  };
  const o = OTHER[a.action];
  if (o) return { label: o[0], cat: o[1], detail: a.action === 'settings.update' ? 'límites y topes' : detail };
  return { label: a.action, cat: 'sys', detail };
}

function renderAudit() {
  const f = state.auditFilter ?? 'all';
  for (const b of document.querySelectorAll('#audit-filter button')) b.setAttribute('aria-pressed', String(b.dataset.f === f));
  const rows = (state.audit ?? []).map((a) => ({ a, i: auditInfo(a) })).filter((r) => f === 'all' || r.i.cat === f);
  const shown = rows.slice(0, state.auditMore ? 150 : 25);
  const box = $('#audit');
  if (!rows.length) { box.replaceChildren(el('p', { className: 'hint', textContent: 'Sin movimientos todavía.' })); return; }
  box.replaceChildren(
    el('table', { className: 'audit-t' }, el('thead', {}, el('tr', {}, ...['Cuándo', 'Qué pasó', 'Detalle', 'Misión'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...shown.map(({ a, i }) => el('tr', {},
        el('td', { className: 'when', title: parseTs(a.ts).toLocaleString(), textContent: since(a.ts) }),
        el('td', {}, el('em', { className: `cat cat-${i.cat}`, textContent: i.cat === 'task' ? 'misión' : 'sistema' }), span(` ${i.label}`)),
        el('td', { className: 'snip', title: i.detail, textContent: i.detail }),
        el('td', {}, a.task_id && state.tasks.has(a.task_id) ? el('button', { className: 'mini-link', textContent: `#${a.task_id}`, onclick: () => openDrawer(a.task_id) }) : span(a.task_id ? `#${a.task_id}` : '')))))),
    ...(rows.length > shown.length ? [el('button', { className: 'eng-toggle', textContent: `Mostrar más (${rows.length - shown.length})`, onclick: () => { state.auditMore = true; renderAudit(); } })] : []));
}

async function refreshCosts() {
  state.audit = await api('/api/audit');
  fillSettings();
  renderMetrics();
  renderAudit();
}

// ---------- sistema ----------
const fmtBytes = (n) => (n == null ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fmtDur = (s) => { if (s == null) return '—'; s = Math.round(s); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`; };
const dot = (ok) => el('span', { className: ok ? 'dot-ok' : 'dot-bad' });
const kv = (rows) => el('dl', { className: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
const span = (t) => el('span', { textContent: t });

function fillSettings() {
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(state.settings)) if (f[k] && document.activeElement !== f[k]) f[k].value = v;
}

/** Reconstruye un contenedor solo si sus datos cambiaron (así no se pierde lo que estás escribiendo). */
function renderIfChanged(box, data, build) {
  const sig = JSON.stringify(data);
  if (box.dataset.sig === sig) return;
  box.replaceChildren(...build());
  box.dataset.sig = sig; // solo tras construir: si build() falla, el siguiente refresco lo reintenta
}

function pushLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 400) state.logs.shift();
  if (state.view !== 'system') return;
  const level = $('#log-level').value;
  if (level === 'error' && entry.level !== 'error') return;
  if (level === 'warn' && entry.level === 'info') return;
  const box = $('#sys-log');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  box.append(logRow(entry));
  while (box.children.length > 400) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}
const logRow = (e) => el('div', { className: e.level }, el('span', { className: 't', textContent: new Date(e.ts).toLocaleTimeString() + ' ' }), span(e.msg));

function renderLogs() {
  const level = $('#log-level').value;
  const box = $('#sys-log');
  box.replaceChildren(...state.logs.filter((e) => !level || (level === 'error' ? e.level === 'error' : e.level !== 'info')).map(logRow));
  box.scrollTop = box.scrollHeight;
}

function renderSystem() {
  const s = state.system;
  // chips
  const setChip = (id, text, cls) => { const c = $(id); c.textContent = text; c.className = `chip ${cls}`; };
  setChip('#chip-queue', s.queue.paused ? 'cola en pausa' : `cola activa · ${s.queue.running.length} en curso`, s.queue.paused ? 'warn' : 'ok');
  setChip('#chip-claude', !s.claude.enabled ? 'Claude Code desactivado' : s.claude.ok ? `Claude Code ${s.claude.version.split(' ')[0]}` : 'Claude Code no disponible', !s.claude.enabled ? 'warn' : s.claude.ok ? 'ok' : 'bad');
  setChip('#chip-ollama', !s.ollama.enabled ? 'Ollama desactivado' : s.ollama.ok ? `Ollama · ${s.ollama.models.length} modelos` : 'Ollama sin servicio', s.ollama.enabled && s.ollama.ok ? 'ok' : 'warn');
  setChip('#chip-codex', !s.codex.enabled ? 'Codex desactivado' : s.codex.ok ? `Codex ${s.codex.version.replace(/^codex-cli\s*/, '')}` : 'Codex no disponible', s.codex.enabled && s.codex.ok ? 'ok' : 'warn');
  const lms = lmStatus();
  setChip('#chip-lmstudio', lms === 'activo' ? 'LM Studio activo' : lms === 'sin servidor' ? 'LM Studio sin servidor' : 'LM Studio desactivado', lms === 'activo' ? 'ok' : 'warn');
  const on = s.providers.filter((p) => p.enabled).length;
  setChip('#chip-apis', `${on} modelo(s) extra activos`, on ? 'ok' : 'warn');
  $('#queue-toggle').textContent = s.queue.paused ? 'Reanudar cola' : 'Pausar cola';
  $('#queue-toggle').className = s.queue.paused ? 'primary' : '';
  $('#cancel-all').disabled = !(s.queue.running.length || s.queue.waiting.length); // nada que cancelar

  // entorno
  const pathRow = (ok, path, note) => el('span', { className: 'pathrow', title: path }, el('span', { className: 'pr-top' }, dot(ok), el('span', { className: 'path', textContent: path })), ...(note ? [el('em', { className: 'muted', textContent: note })] : []));
  const nTasks = Object.values(s.db.tasks).reduce((a, v) => a + v, 0);
  $('#sys-health').replaceChildren(kv([
    ['Servidor', span(`en línea hace ${fmtDur(s.server.uptime_s)}`)],
    ['Base de datos', span(`${fmtBytes(s.db.size_bytes)} · ${nTasks ? Object.entries(s.db.tasks).map(([k, v]) => `${v} ${k}`).join(', ') : 'sin tareas guardadas'}`)],
    ['Proyectos', pathRow(s.paths.htdocs.exists, s.paths.htdocs.path, `${s.paths.htdocs.projects} proyectos`)],
    ...(s.paths.docs ? [['Documentos', pathRow(s.paths.docs.exists, s.paths.docs.path, 'una carpeta por tema')]] : []),
    ...s.paths.extra.map((e) => [e.name.replace(/^@/, ''), pathRow(e.exists, e.path, 'solo lectura')]),
  ]));

  // motores: una línea por motor, con su estado; al hacer clic se abre «Motores y modelos»
  const lmState = lmStatus();
  const lmP = s.providers.find((p) => p.name === 'lmstudio');
  const netOn = s.providers.filter((p) => p.needsKey && p.enabled).length;
  const loaded = s.ollama.ok && s.ollama.loaded?.length ? ` · cargado: ${s.ollama.loaded.map((m) => m.name).join(', ')}` : '';
  const motor = (name, state, text, detail, startEngine = null) => {
    const b = el('div', { className: 'motor', role: 'button', tabIndex: 0, title: 'Abrir Motores y modelos' },
      el('span', { className: `dot-${state === 'ok' ? 'ok' : state === 'off' ? 'off' : 'bad'}` }), el('strong', { textContent: name }),
      el('span', { className: `pill ${state}`, textContent: text }), el('span', { className: 'muted', textContent: detail }));
    if (startEngine) {
      const go = serverButton(startEngine); const run = go.onclick;
      go.textContent = 'Encender'; go.className = 'mini-primary'; go.onclick = (e) => { e.stopPropagation(); return run(e); };
      b.append(go);
    }
    b.onclick = () => setSysTab('motores');
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSysTab('motores'); } };
    return b;
  };
  const eng = (name, info, okText, detail, startEngine = null) => (!info.enabled ? motor(name, 'off', 'apagado', '') : info.ok ? motor(name, 'ok', okText, detail) : motor(name, 'bad', 'sin servicio', startEngine ? '' : 'revisa la instalación', startEngine));
  $('#sys-motors').replaceChildren(
    eng('Claude Code', s.claude, 'activo', s.claude.ok ? s.claude.version.split(' ')[0] : ''),
    eng('Codex', s.codex, 'activo', s.codex.ok ? s.codex.version.replace(/^codex-cli\s*/, '') : ''),
    eng('Ollama', s.ollama, 'activo', s.ollama.ok ? `${s.ollama.models.length} modelos${loaded}` : '', 'ollama'),
    !lmP || !lmP.enabled ? motor('LM Studio', 'off', 'apagado', '') : lmState === 'activo' ? motor('LM Studio', 'ok', 'activo', 'servidor local') : motor('LM Studio', 'bad', 'sin servidor', '', 'lmstudio'),
    netOn ? motor('Internet', 'ok', `${netOn} activos`, s.providers.filter((p) => p.needsKey && p.enabled).map((p) => p.name).join(', ')) : motor('Internet', 'off', 'ninguno', ''));

  // cifras del día
  const a0 = s.activity;
  const qq = s.queue;
  const kpi = (label, value, cls = '') => el('div', { className: `kpi ${cls}` }, el('b', { textContent: value }), span(label));
  const ramLow = s.memory && s.memory.free_gb < 3;
  $('#sys-kpi').replaceChildren(
    kpi('en curso', String(qq.running.length), qq.running.length ? 'hot' : ''),
    kpi('en espera', String(qq.waiting.length), qq.waiting.length ? 'warn' : ''),
    kpi('terminadas hoy', String(a0.total)),
    kpi('éxito', a0.successRate == null ? '—' : `${Math.round(a0.successRate * 100)}%`),
    kpi('duración media', fmtDur(a0.avgSeconds)),
    ...(s.memory ? [kpi(`RAM libre de ${s.memory.total_gb} GB`, `${s.memory.free_gb} GB`, ramLow ? 'warn' : '')] : []));

  // cola
  const q = s.queue;
  const isApi = (e) => !['claude', 'ollama', 'codex', 'lmstudio'].includes(e);
  const ENG_LABEL = { claude: 'Claude Code', ollama: 'Ollama', codex: 'Codex', lmstudio: 'LM Studio' };
  const engLabel = (e) => ENG_LABEL[e] ?? e;
  const gauge = (name, used, lim, nWait, offNow) => el('div', { className: `gauge${offNow ? ' off' : ''}` },
    el('div', { className: 'g-head' }, el('strong', { textContent: name }), span(offNow ? 'desactivado' : `${used}/${lim} en curso${nWait ? ` · ${nWait} en espera` : ''}`)),
    el('div', { className: 'bar' }, el('i', { className: used >= lim ? 'full' : '', style: `width:${offNow ? 0 : Math.min(100, (used / lim) * 100)}%` })));
  const apiUsed = Object.entries(q.active).filter(([k]) => isApi(k)).reduce((a, [, v]) => a + v, 0);
  const waitOf = (f) => q.waiting.filter((w) => f(w.engine)).length;
  const qoff = q.off ?? [];
  const rows = el('div', { className: 'gauges' },
    gauge('Claude Code', q.active.claude ?? 0, q.limit.claude, waitOf((e) => e === 'claude'), qoff.includes('claude')),
    gauge('Ollama', q.active.ollama ?? 0, q.limit.ollama, waitOf((e) => e === 'ollama'), qoff.includes('ollama')),
    gauge('Codex', q.active.codex ?? 0, q.limit.codex ?? 1, waitOf((e) => e === 'codex'), qoff.includes('codex')),
    gauge('LM Studio', q.active.lmstudio ?? 0, q.limit.lmstudio ?? 1, waitOf((e) => e === 'lmstudio'), lmStatus() === 'apagado'),
    gauge('Internet', apiUsed, q.limit.api, waitOf(isApi), false));
  const list = el('div', { className: 'mini-list' });
  const engTag = (e) => el('em', { className: `eng eng-${isApi(e) ? 'api' : e}`, textContent: engLabel(e) });
  for (const t of q.running) { const b = el('button', { className: 'mini' }, el('span', {}, engTag(t.engine), span(` #${t.id} ${t.title}`)), el('span', { className: 'muted', textContent: `${t.agent} · ${fmtDur(Math.max(0, (Date.now() - parseTs(t.started_at)) / 1000))}` })); b.onclick = () => openDrawer(t.id); list.append(b); }
  for (const w of q.waiting) { const b = el('button', { className: 'mini' }, el('span', {}, engTag(w.engine), span(` ⏳ #${w.id} ${w.title}`)), el('span', { className: 'muted', textContent: w.reason })); b.onclick = () => openDrawer(w.id); list.append(b); }
  if (!list.children.length) list.append(el('p', { className: 'hint', textContent: 'Nada en curso.' }));
  $('#sys-queue').replaceChildren(rows, list);

  // hoy por motor
  const a = s.activity;
  const maxN = Math.max(1, ...a.byEngine.map((e) => e.ok + e.failed));
  const byEngine = a.byEngine.length
    ? el('div', { className: 'by-engine' }, ...a.byEngine.map((e) => el('div', { className: 'be-row' },
      el('strong', { textContent: engLabel(e.engine) }),
      el('div', { className: 'be-bar' }, el('i', { className: 'ok', style: `width:${(e.ok / maxN) * 100}%` }), el('i', { className: 'bad', style: `width:${(e.failed / maxN) * 100}%` })),
      el('span', { className: 'muted', textContent: `${e.ok} ok${e.failed ? ` · ${e.failed} fallos` : ''}` }))))
    : el('p', { className: 'hint', textContent: 'Aún no hay tareas terminadas hoy.' });
  const fails = el('div', { className: 'mini-list' }, ...(s.failures.length ? [el('h3', { textContent: 'Fallos recientes' })] : []),
    ...s.failures.map((f) => { const b = el('button', { className: 'mini err' }, span(`#${f.id} ${f.title}`), el('span', { className: 'muted', textContent: (f.error || '').slice(0, 60) })); b.onclick = () => openDrawer(f.id); return b; }));
  $('#sys-activity').replaceChildren(byEngine, fails);

  // últimas misiones: las 6 más recientes, con su estado
  const recent = [...state.tasks.values()].sort((x, y) => y.id - x.id).slice(0, 6);
  $('#sys-recent').replaceChildren(...(recent.length ? recent.map((t) => {
    const b = el('button', { className: `mini rec ${t.status}` },
      el('span', {}, engTag(t.engine ?? 'claude'), span(` #${t.id} ${t.title}`)),
      el('span', { className: 'muted', textContent: [STATUS_ES[t.status] ?? t.status, since(t.finished_at ?? t.updated_at)].filter(Boolean).join(' · ') }));
    b.onclick = () => openDrawer(t.id);
    return b;
  }) : [el('p', { className: 'hint', textContent: 'Aún no hay misiones. Crea una con «+ Nueva misión» o desde un objetivo.' })]));

  // rutinas
  $('#sys-schedules').replaceChildren(...(s.schedules.length ? s.schedules : [null]).map((r) => r
    ? el('div', { className: 'mini' }, span(`${r.enabled ? '' : '⏸ '}${r.name}`), el('span', { className: 'muted', textContent: r.next_run ? `próxima ${new Date(r.next_run).toLocaleString()}` : 'pausada' }))
    : el('p', { className: 'hint', textContent: 'Sin rutinas programadas.' })));

  // motores y modelos (solo se reconstruye si cambian los datos, para no perder lo que escribes)
  state.benches ??= {};
  for (const e of ['ollama', 'lmstudio']) if (!state.benches[e]) refreshBench(e);
  renderIfChanged($('#sys-engines'), { b: state.benches, m: state.modelInfo, c: [s.claude.enabled, s.claude.ok, s.claude.version], o: [s.ollama.enabled, s.ollama.ok, s.ollama.models?.length ?? 0], x: [s.codex.enabled, s.codex.ok, s.codex.version], p: s.providers, n: state.netMore }, () => enginesView(s));
  fillSettings();
}

/** Opciones de modelo de un motor: la primera es siempre el predeterminado de tu sesión. */
const PICK_ENGINES = ['claude', 'codex', 'ollama', 'lmstudio'];
function modelOptions(engine, current) {
  const info = state.modelInfo ?? {};
  const seen = info.defaults?.[engine];
  const list = [...(info[engine] ?? [])];
  if (current && !list.some((m) => m.value === current)) list.push({ value: current, label: current });
  const none = engine === 'lmstudio' ? ' (el que tengas cargado)' : ' (el de tu sesión)';
  return [el('option', { value: '', textContent: `Predeterminado${seen ? ` · ${engine === 'claude' ? 'hoy: ' : ''}${seen}` : none}` }), ...list.map((m) => el('option', { value: m.value, textContent: `${m.recommended ? '★ ' : ''}${m.label}${m.recommended ? ' · recomendado para el día a día' : ''}` }))];
}

/** `fresh`: sin la caché corta del servidor (lo usa «Buscar modelos»). */
async function refreshModels(fresh = false) {
  try {
    const before = JSON.stringify([...serversDown()]);
    state.modelInfo = await api(`/api/models${fresh ? '?fresh=1' : ''}`);
    if (openTaskDialog && JSON.stringify([...serversDown()]) !== before) { fillSelects(); state.syncHint?.(); }
    state.syncHint?.();
    if (state.view === 'system' && state.system) renderSystem();
    render();
  } catch { /* el servidor puede estar reiniciando */ }
}

/** Interruptor tipo «switch» (encendido/apagado) para un motor o proveedor. */
const switchBtn = (on, title, fn) => el('button', { className: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), title, onclick: guard(fn) }, el('i'));

/** Selector de modelo de un motor (la primera opción es siempre el predeterminado). */
function modelSelect(key, label) {
  const cur = state.modelInfo?.engine_models?.[key] ?? '';
  const sel = el('select', { className: 'model-pick', 'aria-label': `Modelo de ${label}` }, ...modelOptions(key, cur));
  sel.value = cur;
  sel.onchange = guard(async () => {
    await api(`/api/system/engines/${key}/model`, { method: 'PUT', body: JSON.stringify({ model: sel.value }) });
    toast(`${label}: ${sel.value ? 'modelo ' + sel.value : 'vuelve al predeterminado'} (aplica a las misiones nuevas)`, false);
    await refreshModels();
  });
  return sel;
}

const BENCH_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio' };
const benchTimers = {};
/** Por qué el nuevo recomendado supera al anterior, con los datos de la medición. */
function betterReason(b) {
  const now = b.results.find((r) => r.name === b.best);
  const was = b.results.find((r) => r.name === b.changed_from);
  if (!now) return '';
  if (!was) return `${b.changed_from} ya no está instalado`;
  if (!was.ok) return `${b.changed_from} falló en la última medición`;
  if (was.tps < 4 && now.tps >= was.tps) return `es más rápido (${now.tps} frente a ${was.tps} tok/s)`;
  if ((now.size ?? 0) > (was.size ?? 0)) return `es más grande, así que suele responder mejor, y va a buen ritmo (${now.tps} tok/s; ${b.changed_from}: ${was.tps} tok/s)`;
  return `${now.tps} tok/s frente a ${was.tps} tok/s de ${b.changed_from}`;
}

async function refreshBench(engine) {
  try {
    state.benches ??= {};
    const wasRunning = !!state.benches[engine]?.running;
    const b = state.benches[engine] = await api(`/api/system/${engine}/benchmark`);
    clearTimeout(benchTimers[engine]);
    if (b.running) benchTimers[engine] = setTimeout(() => refreshBench(engine), 2000);
    else if (b.best) await refreshModels(); // la recomendación cambia el «predeterminado» y la ★
    if (wasRunning && !b.running) { // acaba de terminar: decir el resultado, sobre todo si hay uno mejor
      if (b.changed_from) toast(`★ Nuevo recomendado en ${BENCH_LABEL[engine]}: ${b.best}. Es mejor que ${b.changed_from}: ${betterReason(b)}.`, false);
      else toast(`Medición de ${BENCH_LABEL[engine]} terminada. ${b.best ? `Recomendado: ★ ${b.best}` : 'Ningún modelo respondió bien: abre la tabla para ver por qué.'}`, false);
    }
    if (state.system) renderSystem();
  } catch { /* el servidor puede estar reiniciando */ }
}
const FORCE_WARNING = 'Los que no caben en la memoria libre pueden ir muy lentos, tardar varios minutos cada uno o fallar al cargar. Mientras tanto la computadora puede ir lenta.';
/** `models`: medir solo esos (botón «Reintentar» de una fila); el resto de resultados se conserva. */
async function startBench(engine, force = false, models = null) {
  state.benches ??= {};
  try {
    state.benches[engine] = await post(`/api/system/${engine}/benchmark`, { force, ...(models ? { models } : {}) });
  } catch (e) {
    // ninguno cabe ahora: ofrecer medirlos igualmente en vez de quedarse en el error
    if (force || !e.data?.can_force) throw e;
    if (await confirmDialog('Medir de todos modos', `${e.message} ¿Quieres medirlos igualmente? ${FORCE_WARNING}`)) return startBench(engine, true);
    return;
  }
  toast(models ? `Midiendo de nuevo ${models.join(', ')}. Los demás resultados se conservan.` : `Midiendo ${force ? 'todos ' : ''}tus modelos de ${BENCH_LABEL[engine]}, de uno en uno. Tarda unos minutos y no hace falta que esperes aquí.`, false);
  clearTimeout(benchTimers[engine]); benchTimers[engine] = setTimeout(() => refreshBench(engine), 2000);
  renderSystem();
}
/** Enciende el servidor local de Ollama o de LM Studio (sin abrir la terminal). */
const serverButton = (engine) => el('button', { className: 'primary', textContent: 'Encender servidor', title: `Enciende ${BENCH_LABEL[engine]} en este equipo`, onclick: guard(async (e) => {
  e.target.disabled = true; e.target.textContent = 'Encendiendo…';
  try {
    await post(`/api/system/${engine}/server`);
    toast(`${BENCH_LABEL[engine]} encendido`, false);
  } finally { await refreshModels(); await refreshSystem(); }
}) });
/**
 * Un solo interruptor para Ollama y LM Studio: ENCENDIDO = activo en Sistema + servidor funcionando.
 * Encender abre el servidor; apagar lo cierra (libera la RAM) y lo desactiva. El servidor rechaza apagarlo si una misión lo usa.
 */
const serverSwitch = (engine, enabled, up, toggleUrl) => {
  const on = enabled && up;
  const name = BENCH_LABEL[engine];
  const setEnabled = (value) => api(toggleUrl, { method: 'PUT', body: JSON.stringify({ enabled: value }) });
  const btn = switchBtn(on, on ? `Apagar ${name}: cierra su servidor, libera la memoria y deja de usarse` : `Encender ${name}: abre su servidor y lo activa`, async () => {
    if (on && !(await confirmDialog(`Apagar ${name}`, `Se cerrará el servidor de ${name}, se liberará la memoria que usa y las misiones dejarán de usarlo. Puedes volver a encenderlo con este mismo interruptor.`))) return;
    btn.disabled = true;
    try {
      if (on) {
        await post(`/api/system/${engine}/server/stop`); // si hay una misión usándolo, el servidor lo rechaza y no se toca nada
        await setEnabled(false);
        toast(`${name} apagado`, false);
      } else {
        if (!enabled) await setEnabled(true);
        toast(`Encendiendo ${name}…${engine === 'ollama' ? ' puede tardar hasta un minuto' : ''}`, false);
        await post(`/api/system/${engine}/server`);
        toast(`${name} encendido`, false);
      }
    } finally { btn.disabled = false; await refreshModels(); await refreshState(); await refreshSystem(); }
  });
  return btn;
};
/** Vuelve a leer los modelos instalados (p. ej. tras un `ollama pull` o una descarga en LM Studio) y dice cuáles son nuevos. */
const scanButton = (engine) => el('button', { textContent: 'Buscar modelos', title: `Busca los modelos que tienes instalados en ${BENCH_LABEL[engine]} y actualiza la lista`, onclick: guard(async (e) => {
  const before = new Set((state.modelInfo?.[engine] ?? []).map((m) => m.value));
  e.target.disabled = true; e.target.textContent = 'Buscando…';
  try {
    await refreshModels(true); await refreshSystem();
    const found = state.modelInfo?.[engine] ?? [];
    const added = found.filter((m) => !before.has(m.value)).map((m) => m.value);
    toast(!found.length ? `${BENCH_LABEL[engine]}: no hay modelos de chat instalados` : `${BENCH_LABEL[engine]}: ${found.length} modelo${found.length === 1 ? '' : 's'} encontrado${found.length === 1 ? '' : 's'}${added.length ? ` · nuevos: ${added.join(', ')}` : ''}`, false);
  } finally { e.target.disabled = false; e.target.textContent = 'Buscar modelos'; }
}) });
const benchButton = (engine) => el('button', { textContent: state.benches?.[engine]?.running ? 'Midiendo…' : 'Medir modelos', disabled: !!state.benches?.[engine]?.running, title: 'Prueba cada modelo instalado y te dice cuál rinde mejor en esta computadora', onclick: guard(async (e) => {
  e.target.disabled = true; // evita lanzar dos mediciones con un doble clic
  try { await startBench(engine); } finally { e.target.disabled = !!state.benches?.[engine]?.running; }
}) });

/** «hace 5 min», «hace 2 h», «hace 3 días». */
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}

/** Estado breve junto a los botones: cuántos modelos hay, cuál se recomienda y cuándo se midió. */
function benchStatus(engine, up) {
  if (!up) return el('span', { className: 'tb-status muted', textContent: 'Enciende el servidor con el interruptor de la derecha para buscar, probar o medir modelos.' });
  const n = (state.modelInfo?.[engine] ?? []).length;
  const b = state.benches?.[engine];
  const bits = [`${n} modelo${n === 1 ? '' : 's'} de chat`];
  if (b?.running) bits.push(`midiendo ${b.done ?? 0}/${b.total}…`);
  else if (b?.best) bits.push(`★ recomendado: ${b.best}`);
  else if (!b?.results?.length) bits.push('aún sin medir');
  if (!b?.running && b?.at) bits.push(`medido ${ago(b.at)}`);
  return el('span', { className: 'tb-status' }, span(bits.join(' · ')));
}

/**
 * Tabla con TODOS los modelos del motor: los medidos (con «Usar este» y «↻»), los omitidos con su motivo
 * y los instalados que aún no se midieron, cada uno con su «Medir». `canRun`: el servidor está encendido.
 */
function benchPanel(engine, canRun = true) {
  const b = state.benches?.[engine] ?? { results: [], skipped: [] };
  const installed = (state.modelInfo?.[engine] ?? []).map((m) => m.value);
  const measured = new Set(b.results.map((r) => r.name));
  const pending = [
    ...b.skipped.filter((s) => !measured.has(s.name)),
    ...installed.filter((n) => !measured.has(n) && !b.skipped.some((s) => s.name === n)).map((name) => ({ name, reason: 'sin medir todavía' })),
  ];
  if (!b.running && !b.results.length && !pending.length) return null;
  const cur = state.modelInfo?.engine_models?.[engine] ?? '';
  const busy = b.running || !canRun;
  const measureOnly = (names, needsConfirm) => guard(async (e) => {
    if (needsConfirm && !(await confirmDialog('Medir de todos modos', `${names.join(', ')}: ${FORCE_WARNING}`))) return;
    e.target.disabled = true;
    await startBench(engine, true, names);
  });
  const sizeCell = (x) => el('td', { className: 'num', textContent: x.size ? `${x.size_est ? '~' : ''}${(x.size / 1e9).toFixed(1)} GB` : '—' });
  const nameCell = (name) => el('td', { className: 'm-name', title: name }, ...(name === b.best ? [el('b', { className: 'star', textContent: '★ ' })] : []), span(name), ...(name === cur ? [el('em', { className: 'in-use', textContent: 'en uso' })] : []));
  const now = (name) => b.running && name === b.current;

  const doneRows = b.results.map((r) => el('tr', { className: [r.name === b.best && 'best', now(r.name) && 'measuring', !r.ok && 'failed'].filter(Boolean).join(' ') },
    nameCell(r.name), sizeCell(r),
    el('td', { className: `num ${r.ok ? (r.tps >= 4 ? 'good' : 'bad') : 'bad'}`, textContent: r.ok ? `${r.approx ? '~' : ''}${r.tps} tok/s` : '—' }),
    el('td', { className: 'num', textContent: `${r.seconds} s`, title: r.at ? `Medido el ${new Date(r.at).toLocaleString()}` : '' }),
    el('td', { className: 'snip', title: now(r.name) ? '' : (r.text || r.error || '') }, now(r.name) ? el('span', { className: 'spin', textContent: '⏳ midiendo de nuevo…' }) : span(r.ok ? r.text : `✕ ${r.error}`)),
    el('td', { className: 'bench-act' },
      ...(r.ok && cur !== r.name ? [el('button', { textContent: 'Usar', title: `Que ${BENCH_LABEL[engine]} use ${r.name} en las misiones nuevas`, onclick: guard(async () => {
        await api(`/api/system/engines/${engine}/model`, { method: 'PUT', body: JSON.stringify({ model: r.name }) });
        toast(`${BENCH_LABEL[engine]} usará ${r.name} (aplica a las misiones nuevas)`, false);
        await refreshModels();
      }) })] : []),
      el('button', { textContent: r.ok ? '↻' : 'Reintentar', title: `Medir de nuevo solo ${r.name} (lo demás se conserva)`, disabled: busy, onclick: measureOnly([r.name], false) }))));

  const pendingRows = pending.map((s) => el('tr', { className: `pending${now(s.name) ? ' measuring' : ''}` },
    nameCell(s.name), sizeCell(s),
    el('td', { className: 'num', textContent: '—' }), el('td', { className: 'num', textContent: '—' }),
    el('td', { className: 'snip', title: s.reason }, now(s.name) ? el('span', { className: 'spin', textContent: '⏳ midiendo…' }) : span(s.reason)),
    el('td', { className: 'bench-act' }, el('button', { textContent: 'Medir', title: `Medir solo ${s.name}`, disabled: busy, onclick: measureOnly([s.name], /RAM/.test(s.reason)) }))));

  const okN = b.results.filter((r) => r.ok).length;
  const failN = b.results.length - okN;
  const pct = b.running && b.total ? Math.round(((b.done ?? 0) / b.total) * 100) : 0;
  const summary = b.running
    ? `Midiendo ${b.done ?? 0} de ${b.total}${b.current ? ` · ahora: ${b.current}` : ''}`
    : [`${okN} medido${okN === 1 ? '' : 's'}`, failN && `${failN} con fallo`, pending.length && `${pending.length} sin medir`].filter(Boolean).join(' · ') + (b.best ? ` · ★ ${b.best}${b.changed_from ? ' (nuevo)' : ''}` : '');
  const stop = b.running ? el('button', { className: 'danger', textContent: 'Detener', onclick: guard(async () => { await api(`/api/system/${engine}/benchmark`, { method: 'DELETE' }); }) }) : null;
  const allPending = !b.running && pending.length > 1 ? el('button', { textContent: `Medir los ${pending.length} sin medir`, disabled: busy, onclick: measureOnly(pending.map((s) => s.name), pending.some((s) => /RAM/.test(s.reason))) }) : null;
  const better = !b.running && b.changed_from && b.best ? el('div', { className: 'better', textContent: `★ Nuevo recomendado: ${b.best}. Es mejor que ${b.changed_from} (el anterior): ${betterReason(b)}. Las misiones sin modelo elegido ya lo usan.` }) : null;
  const meta = !b.running && b.at ? `Última medición: ${new Date(b.at).toLocaleString()}${b.free_gb != null ? ` · RAM libre entonces: ${b.free_gb} GB` : ''}` : 'Los resultados anteriores se conservan mientras mide.';
  const estimated = b.results.some((r) => r.size_est);
  const legend = `★ recomendado = el más grande que responde a 4 tok/s o más; lee las respuestas para juzgar la calidad.${estimated ? ' «~» = estimado.' : ''} ↻ mide de nuevo solo ese modelo.`;

  state.benchOpen ??= {};
  return el('details', { className: 'bench', open: state.benchOpen[engine] ?? (b.running || !!b.changed_from), ontoggle: (e) => { state.benchOpen[engine] = e.target.open; } },
    el('summary', {}, el('b', { className: 'b-title', textContent: 'Modelos y mediciones' }), span(summary), ...(stop ? [stop] : [])),
    ...(b.running ? [el('div', { className: 'progress', title: `${pct} %` }, el('i', { style: `width:${pct}%` }))] : []),
    ...(better ? [better] : []),
    el('table', {},
      el('thead', {}, el('tr', {}, ...[['Modelo', ''], ['Tamaño', 'num'], ['Velocidad', 'num'], ['Tiempo', 'num'], ['Respuesta', ''], ['', '']].map(([t, c]) => el('th', { className: c, textContent: t })))),
      el('tbody', {}, ...doneRows, ...pendingRows)),
    el('div', { className: 'bench-foot' }, el('div', { className: 'muted' }, el('div', { textContent: meta }), el('div', { textContent: legend })), ...(allPending ? [allPending] : [])));
}

/** Una fila: nombre y tipo | estado | modelo | acciones. `more` = zona desplegable (clave, resultado de «Probar»). */
function engineItem({ name, kind, kindClass, on, ok, detail, model, actions, panel = null, tools = [], status = null, more = [] }) {
  const line = el('div', { className: `eng-line${on ? '' : ' off'}` },
    el('div', { className: 'c-name' }, el('strong', { textContent: name }), el('em', { className: `kind ${kindClass}`, textContent: kind })),
    el('div', { className: 'c-state', title: detail }, el('span', { className: on && ok ? 'dot-ok' : on ? 'dot-bad' : 'dot-off' }), span(detail)),
    el('div', { className: 'c-model' }, model),
    el('div', { className: 'c-act' }, ...actions));
  // mismo orden en todos los motores: encender · buscar · probar · medir · apagar (lo destructivo al final)
  const rank = (b) => (/Encend/.test(b.textContent) ? 0 : /Busc/.test(b.textContent) ? 1 : /Prob/.test(b.textContent) ? 2 : /Med/.test(b.textContent) ? 3 : 4);
  tools = [...tools].sort((x, y) => rank(x) - rank(y));
  // debajo de la fila: barra de herramientas a todo el ancho (botones + estado breve) y, debajo, la tabla de modelos
  const toolbar = tools.length || status ? el('div', { className: 'tools-row' }, ...(tools.length ? [el('div', { className: 'tools-btns' }, ...tools)] : []), ...(status ? [status] : [])) : null;
  const bar = panel || toolbar ? [el('div', { className: 'eng-tools' }, ...(toolbar ? [toolbar] : []), el('div', { className: 'eng-more' }, ...more), ...(panel ? [panel] : []))] : [el('div', { className: 'eng-more' }, ...more)];
  return el('div', { className: 'eng-item' }, line, ...bar);
}

/** «Probar» de Ollama: una pregunta mínima al modelo en uso; el resultado queda bajo la fila. */
function ollamaTester() {
  const res = el('div', { className: 'res' });
  const button = el('button', { textContent: 'Probar', title: 'Le hace una pregunta mínima al modelo que usas y mide cuánto tarda (la primera vez carga el modelo en memoria)', onclick: guard(async (e) => {
    e.target.disabled = true; e.target.textContent = 'Probando…';
    res.className = 'res'; res.textContent = 'Cargando el modelo y esperando respuesta… puede tardar hasta un minuto.';
    try {
      const r = await post('/api/system/ollama/test');
      res.className = `res ${r.ok ? 'ok' : 'bad'}`;
      res.textContent = r.ok ? `✓ ${r.model} respondió «${r.text}» en ${(r.ms / 1000).toFixed(1)} s` : `✕ ${r.error}`;
    } finally { e.target.disabled = false; e.target.textContent = 'Probar'; }
  }) });
  return { button, res };
}

/** Claude Code, Codex y Ollama: motores locales que se encienden y apagan sin tocar nada más. */
function localEngineItem(key, label, info, detail, kind, kindClass) {
  const probarOllama = key === 'ollama' ? ollamaTester() : {};
  return engineItem({
    name: label, kind, kindClass, on: key === 'ollama' ? info.enabled && info.ok : info.enabled, ok: info.ok,
    detail: !info.enabled ? `apagado · ${detail ?? ''}` : key === 'ollama' && !info.ok ? 'servidor apagado: usa el interruptor para encenderlo' : (detail ?? ''),
    model: modelSelect(key, label),
    panel: key === 'ollama' && info.enabled ? benchPanel('ollama', info.ok) : null,
    tools: key === 'ollama' && info.enabled && info.ok ? [scanButton('ollama'), benchButton('ollama'), probarOllama.button] : [],
    status: key === 'ollama' && info.enabled ? benchStatus('ollama', info.ok) : null,
    more: key === 'ollama' && info.enabled ? [probarOllama.res] : [],
    actions: [key === 'ollama' ? serverSwitch('ollama', info.enabled, info.ok, '/api/system/engines/ollama/toggle') : switchBtn(info.enabled, info.enabled ? `Apagar ${label}: las misiones dejan de usarlo` : `Encender ${label}`, async () => {
      if (info.enabled && key === 'claude' && !(await confirmDialog('Apagar Claude Code', 'Las misiones en automático pasarán a Ollama, Codex o los modelos extra (que también pueden editar y actuar, aunque los modelos pequeños lo hacen peor). Puedes encenderlo cuando quieras.'))) return;
      await api(`/api/system/engines/${key}/toggle`, { method: 'PUT', body: JSON.stringify({ enabled: !info.enabled }) });
      toast(`${label} ${info.enabled ? 'apagado' : 'encendido'}`, false);
      await refreshState(); await refreshSystem();
    })],
  });
}

/** Proveedores con API (internet o LM Studio local): clave, prueba y encendido. */
function providerItem(p) {
  const lm = p.name === 'lmstudio';
  const lmUp = state.modelInfo?.lmstudio_up;
  const res = el('div', { className: 'res' });
  const keyform = el('form', { className: 'keyform', hidden: true });
  const input = el('input', { type: 'password', placeholder: `Pega la clave de ${p.name}`, autocomplete: 'off', spellcheck: false });
  keyform.append(input, el('button', { className: 'primary', type: 'submit', textContent: 'Guardar' }),
    ...(p.configured ? [el('button', { type: 'button', className: 'danger', textContent: 'Quitar clave', onclick: guard(async () => {
      if (!(await confirmDialog('Quitar clave', `Se borrará la clave de ${p.name} del archivo .env.`))) return;
      await api(`/api/system/providers/${p.name}/key`, { method: 'DELETE' });
      await refreshState(); await refreshSystem();
    }) })] : []),
    el('button', { type: 'button', textContent: 'Cancelar', onclick: () => { keyform.hidden = true; input.value = ''; } }));
  keyform.onsubmit = guard(async (e) => {
    e.preventDefault();
    await api(`/api/system/providers/${p.name}/key`, { method: 'PUT', body: JSON.stringify({ key: input.value.trim() }) });
    input.value = '';
    toast(`Clave de ${p.name} guardada`, false);
    await refreshState(); await refreshSystem();
  });
  const actions = [];
  const tools = [];
  if (lm && p.enabled && lmUp) tools.push(scanButton('lmstudio'), benchButton('lmstudio'));
  if (p.configured && !(lm && lmUp === false)) { // con el servidor de LM Studio apagado no hay nada que probar
    (lm ? tools : actions).push(el('button', { textContent: 'Probar', onclick: guard(async () => {
      res.className = 'res'; res.textContent = 'Probando…';
      const r = await post(`/api/system/providers/${p.name}/test`);
      res.className = `res ${r.ok ? 'ok' : 'bad'}`; res.textContent = r.ok ? `✓ Conexión correcta (${r.ms} ms)` : `✕ ${r.error}`;
    }) }));
  }
  if (p.needsKey) actions.push(el('button', { className: p.configured ? '' : 'primary', textContent: p.configured ? 'Clave' : 'Poner clave', onclick: () => { keyform.hidden = !keyform.hidden; if (!keyform.hidden) input.focus(); } }));
  if (p.configured && lm) actions.push(serverSwitch('lmstudio', p.enabled, lmUp !== false, `/api/system/providers/${p.name}/toggle`));
  else if (p.configured) actions.push(switchBtn(p.enabled, p.enabled ? `Apagar ${p.name} (la clave se conserva)` : `Encender ${p.name}`, async () => {
    await api(`/api/system/providers/${p.name}/toggle`, { method: 'PUT', body: JSON.stringify({ enabled: !p.enabled }) });
    toast(`${p.name} ${p.enabled ? 'apagado: no se usará hasta que lo enciendas' : 'encendido'}`, false);
    await refreshState(); await refreshSystem();
  }));
  const detail = lm ? (!p.enabled ? 'apagado' : lmUp === false ? 'servidor apagado: usa el interruptor para encenderlo' : 'servidor local encendido · sin clave')
    : !p.configured ? 'sin clave' : p.enabled ? `activo · clave ${p.keyHint}` : `apagado · clave ${p.keyHint} guardada`;
  return engineItem({
    name: lm ? 'LM Studio' : p.name, kind: lm ? 'Local' : 'Internet', kindClass: lm ? 'k-local' : 'k-net',
    on: lm ? p.enabled && lmUp !== false : p.enabled, ok: lm ? lmUp !== false : true, detail,
    model: lm && p.enabled ? modelSelect('lmstudio', 'LM Studio') : el('span', { className: 'muted', textContent: p.configured || lm ? p.model : `modelo: ${p.model}` }),
    actions, panel: lm && p.enabled ? benchPanel('lmstudio', lmUp !== false) : null, tools, more: [res, keyform],
    status: lm && p.enabled ? benchStatus('lmstudio', lmUp !== false) : null,
  });
}

/** Vista completa de «Motores y modelos»: tres grupos con la misma estructura de fila. */
function enginesView(s) {
  const group = (title, hint, count) => el('div', { className: 'eng-group' }, el('h3', { className: 'sub', textContent: title }), ...(count ? [el('b', { className: 'eng-count', textContent: count })] : []), ...(hint ? [el('span', { className: 'muted', textContent: hint })] : []));
  const net = s.providers.filter((p) => p.needsKey);
  const keyed = net.filter((p) => p.configured);
  const bare = net.filter((p) => !p.configured);
  const local = s.providers.filter((p) => !p.needsKey);
  const nOn = (...flags) => flags.filter(Boolean).length;
  const moreBtn = el('button', { className: 'eng-toggle', textContent: state.netMore ? 'Ocultar los que no tienen clave ▴' : `Mostrar ${bare.length} más sin clave ▾`, onclick: () => { state.netMore = !state.netMore; renderSystem(); } });
  const head = el('div', { className: 'eng-head' }, ...['Motor', 'Estado', 'Modelo que usa', 'Acciones'].map((t) => el('span', { textContent: t })));
  return [
    head,
    group('Con tu suscripción', 'usan tu sesión iniciada en esta PC', `${nOn(s.claude.enabled, s.codex.enabled)}/2 activos`),
    localEngineItem('claude', 'Claude Code', s.claude, s.claude.ok ? `${s.claude.version} · edita archivos` : s.claude.error, 'Suscripción', 'k-sub'),
    localEngineItem('codex', 'Codex', s.codex, s.codex.ok ? `${s.codex.version.replace(/^codex-cli\s*/, '')} · solo lee` : s.codex.error, 'Suscripción', 'k-sub'),
    group('En este equipo', 'gratis y privados; solo leen', `${nOn(s.ollama.enabled, ...local.map((p) => p.enabled))}/${1 + local.length} activos`),
    localEngineItem('ollama', 'Ollama', s.ollama, s.ollama.ok ? `${s.ollama.models.length} modelos instalados` : s.ollama.error, 'Local', 'k-local'),
    ...local.map(providerItem),
    group('En internet', 'con tu clave; el texto de la misión sale de este equipo', `${keyed.filter((p) => p.enabled).length}/${net.length} activos`),
    ...keyed.map(providerItem),
    ...(bare.length ? [moreBtn] : []),
    ...(state.netMore ? bare.map(providerItem) : []),
  ];
}

async function refreshSystem() {
  try {
    state.system = await api('/api/system');
    if (!state.logs.length) { state.logs = await api('/api/logs?limit=200'); renderLogs(); }
    renderSystem();
    if (state.modelInfo?.lmstudio_up === false && state.system.providers.some((p) => p.name === 'lmstudio' && p.enabled)) refreshModels(); // detecta cuándo enciendes el servidor de LM Studio
  } catch (e) { /* el servidor puede estar reiniciando */ }
}

// ---------- 🔑 secretos: los agentes los usan sin verlos; tú los ves solo cuando pulsas «Ver» ----------
async function refreshVault() {
  const box = $('#vault-list');
  if (!box) return;
  let list = [];
  try { list = await api('/api/vault'); } catch (e) { box.replaceChildren(el('div', { className: 'h-err', textContent: e.message })); return; }
  if (!list.length) return box.replaceChildren(el('div', { className: 'empty', textContent: 'Aún no hay secretos guardados.' }));
  box.replaceChildren(el('ul', { className: 'vault-rows' }, ...list.map((s) => {
    const val = el('code', { className: 'v-val', textContent: '•'.repeat(Math.min(12, s.length)) });
    let shown = false;
    const see = el('button', { type: 'button', className: 'mini-link', textContent: 'Ver' });
    see.onclick = guard(async () => {
      shown = !shown;
      val.textContent = shown ? (await api(`/api/vault/${s.name}/value`)).value : '•'.repeat(Math.min(12, s.length));
      see.textContent = shown ? 'Ocultar' : 'Ver';
    });
    const copy = el('button', { type: 'button', className: 'mini-link', textContent: 'Copiar marcador', title: `Copia ${s.placeholder} para usarlo en un mensaje` });
    copy.onclick = () => navigator.clipboard?.writeText(s.placeholder).then(() => toast(`Copiado ${s.placeholder}`, false), () => toast('No se pudo copiar'));
    const del = el('button', { type: 'button', className: 'mini-link danger-link', textContent: 'Borrar' });
    del.onclick = guard(async () => {
      if (!(await confirmDialog('Borrar secreto', `Se borrará ${s.name} de este equipo. Los agentes ya no podrán usarlo.`))) return;
      await api(`/api/vault/${s.name}`, { method: 'DELETE' });
      toast(`${s.name} borrado`, false); refreshVault();
    });
    return el('li', {}, el('b', { textContent: s.name }), val, el('span', { className: 'v-acts' }, see, ' · ', copy, ' · ', del));
  })));
}

function setupVault() {
  const form = $('#vault-form');
  if (!form) return;
  const name = $('#vault-name'); const value = $('#vault-value');
  name.oninput = () => { const p = name.selectionStart; name.value = name.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); name.setSelectionRange(p, p); };
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const r = await api(`/api/vault/${encodeURIComponent(name.value)}`, { method: 'PUT', body: JSON.stringify({ value: value.value }) });
    value.value = '';
    toast(`🔑 ${r.name} guardado. Los agentes lo usan como ${r.placeholder}${r.cleaned ? ` · borrado de ${r.cleaned} registro(s) donde aparecía` : ''}`, false);
    name.value = '';
    refreshVault();
  });
  refreshVault();
}

// ---------- importar / exportar agentes (sin repetir) ----------
const agentsUi = { selected: new Set(), preview: null }; // preview: { from: 'archivos'|'equipo', items, results }
const canEditTools = (tools) => !tools || tools.trim() === '*' || /\b(Edit|Write)\b/.test(tools);
const AG_STATUS = { nuevo: ['Nuevo', 'ok'], importado: ['Importado', 'ok'], igual: ['Ya lo tienes', 'same'], conflicto: ['Nombre ocupado', 'warn'], repetido: ['Repetido', 'same'], invalido: ['No válido', 'bad'] };

function renderAgentsCard() {
  const box = $('#ag-list');
  if (!box) return;
  const names = new Set(state.agents.map((a) => a.name));
  for (const n of agentsUi.selected) if (!names.has(n)) agentsUi.selected.delete(n);
  $('#ag-count').textContent = `(${state.agents.length})`;
  $('#ag-export-sel').hidden = !agentsUi.selected.size;
  $('#ag-export-sel').textContent = `⬇ Exportar seleccionados (${agentsUi.selected.size})`;
  box.replaceChildren(el('h3', { textContent: 'Tus agentes' }), state.agents.length ? el('ul', { className: 'ag-rows' }, ...state.agents.map((a) => {
    const cb = el('input', { type: 'checkbox', checked: agentsUi.selected.has(a.name), ariaLabel: `Seleccionar ${a.name} para exportar` });
    cb.onchange = () => { cb.checked ? agentsUi.selected.add(a.name) : agentsUi.selected.delete(a.name); renderAgentsCard(); };
    return el('li', {}, el('label', { className: 'ag-row' }, cb, el('b', { textContent: a.name }),
      el('span', { className: `ag-perm ${canEditTools(a.tools) ? 'edit' : ''}`, textContent: canEditTools(a.tools) ? 'puede editar' : 'solo lectura' }),
      el('span', { className: 'muted', textContent: a.description, title: a.description })));
  })) : el('div', { className: 'empty', textContent: 'Aún no tienes agentes: impórtalos o búscalos en este equipo.' }));
}

function renderAgentsPreview() {
  const box = $('#ag-preview');
  const p = agentsUi.preview;
  if (!p) return box.replaceChildren();
  const count = (s) => p.results.filter((r) => r.status === s).length;
  const pick = p.results.map((r) => r.status === 'nuevo');
  const go = el('button', { type: 'button', className: 'primary' });
  const update = () => { const n = pick.filter(Boolean).length; go.textContent = `Importar ${n} agente${n === 1 ? '' : 's'}`; go.disabled = !n; };
  const rows = p.results.map((r, i) => {
    const [label, cls] = AG_STATUS[r.status] ?? [r.status, ''];
    const cb = el('input', { type: 'checkbox', checked: pick[i], disabled: r.status !== 'nuevo', ariaLabel: `Importar ${r.name}` });
    cb.onchange = () => { pick[i] = cb.checked; update(); };
    return el('tr', { className: r.status === 'nuevo' ? '' : 'dim' },
      el('td', {}, cb),
      el('td', {}, el('b', { textContent: r.name }), el('div', { className: 'muted', textContent: r.description ?? '' })),
      el('td', { className: 'muted', textContent: r.source ?? '' }),
      el('td', {}, el('span', { className: `ag-st ${cls}`, textContent: label, title: r.reason ?? '' }), r.reason && r.status !== 'nuevo' ? el('div', { className: 'muted small', textContent: r.reason }) : ''));
  });
  go.onclick = guard(async () => {
    go.disabled = true;
    const chosen = p.results.map((r, i) => (pick[i] ? i : -1)).filter((i) => i >= 0);
    const body = p.from === 'equipo' ? { ids: chosen.map((i) => p.results[i].id) } : { agents: chosen.map((i) => p.items[i]) };
    const { results } = await post('/api/agents/import', body);
    const ok = results.filter((r) => r.status === 'importado');
    const skipped = results.length - ok.length;
    const names = ok.slice(0, 5).map((r) => r.name).join(', ') + (ok.length > 5 ? ` y ${ok.length - 5} más` : '');
    toast(ok.length ? `Importados ${ok.length}: ${names}${skipped ? ` · ${skipped} saltados (ya los tenías)` : ''}` : 'No se importó nada: ya los tenías', !ok.length);
    agentsUi.preview = null; renderAgentsPreview();
    await refreshState();
    renderAgentsCard();
  });
  const close = el('button', { type: 'button', textContent: 'Cancelar' });
  close.onclick = () => { agentsUi.preview = null; renderAgentsPreview(); };
  update();
  box.replaceChildren(el('div', { className: 'ag-preview' },
    el('h3', { textContent: p.from === 'equipo' ? 'Agentes encontrados en este equipo' : 'Vista previa de la importación' }),
    el('p', { className: 'hint', textContent: `${count('nuevo')} nuevos · ${count('igual') + count('repetido')} ya los tienes o están repetidos · ${count('conflicto')} con un nombre que ya usas (se respeta el tuyo)${count('invalido') ? ` · ${count('invalido')} no válidos` : ''}. Nada se guarda hasta que pulses Importar.` }),
    p.results.length ? el('div', { className: 'ag-table' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}), el('th', { textContent: 'Agente' }), el('th', { textContent: 'Origen' }), el('th', { textContent: 'Estado' }))), el('tbody', {}, ...rows)))
      : el('div', { className: 'empty', textContent: 'No se encontró ningún agente.' }),
    el('div', { className: 'btns' }, go, close)));
}

/** Lee los archivos elegidos: paquetes .json exportados o agentes .md sueltos. */
async function readAgentFiles(files) {
  const items = [];
  let size = 0;
  for (const f of files) {
    size += f.size;
    if (size > 900_000) throw new Error('Demasiados datos de una vez (máx. ~900 KB): importa en tandas');
    const text = await f.text();
    if (/\.json$/i.test(f.name)) {
      let b; try { b = JSON.parse(text); } catch { throw new Error(`${f.name} no es un JSON válido`); }
      if (b?.format !== 'oficina-agentes' || !Array.isArray(b.agents)) throw new Error(`${f.name} no es un paquete de agentes exportado desde la oficina`);
      for (const a of b.agents) if (typeof a?.content === 'string') items.push({ filename: `${a.name ?? 'agente'}.md`, content: a.content, source: f.name });
    } else items.push({ filename: f.name, content: text, source: f.name });
  }
  return items;
}

function setupAgentsIO() {
  $('#ag-export-sel').onclick = () => { location.href = `/api/agents/export?names=${encodeURIComponent([...agentsUi.selected].join(','))}`; };
  $('#ag-file').onchange = guard(async (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // permite volver a elegir los mismos archivos
    if (!files.length) return;
    const items = await readAgentFiles(files);
    if (!items.length) throw new Error('Esos archivos no traen agentes');
    const { results } = await post('/api/agents/import', { agents: items, dry: true });
    agentsUi.preview = { from: 'archivos', items, results: results.map((r, i) => ({ ...r, source: items[i].source })) };
    renderAgentsPreview();
  });
  const scan = $('#ag-scan');
  scan.onclick = guard(async () => {
    scan.disabled = true; scan.textContent = '🔎 Buscando…';
    try {
      const r = await api('/api/agents/scan');
      const order = { nuevo: 0, conflicto: 1, repetido: 2, igual: 3 };
      agentsUi.preview = { from: 'equipo', results: r.agents.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name)) };
      renderAgentsPreview();
    } finally { scan.disabled = false; scan.textContent = '🔎 Buscar en este equipo'; }
  });
}

const SYS_TAB_KEY = 'oficina.systab';
function setSysTab(tab) {
  const tabs = ['resumen', 'motores', 'ajustes', 'agentes', 'comunicaciones', 'registro'];
  if (!tabs.includes(tab)) tab = 'resumen';
  $('#view-system').dataset.tab = tab;
  for (const b of document.querySelectorAll('.sys-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  try { localStorage.setItem(SYS_TAB_KEY, tab); } catch { /* sin almacenamiento: vale solo esta sesión */ }
  if (tab === 'registro') renderLogs();
  if (tab === 'comunicaciones') renderComms();
  if (tab === 'agentes') renderAgentsCard();
}

function setupSystem() {
  setupAgentsIO();
  setupVault();
  for (const b of document.querySelectorAll('.sys-tabs button')) b.onclick = () => setSysTab(b.dataset.tab);
  let saved = null;
  try { saved = localStorage.getItem(SYS_TAB_KEY); } catch { /* sin almacenamiento */ }
  setSysTab(saved);
  $('#queue-toggle').onclick = guard(async () => { await post(`/api/queue/${state.system?.queue.paused ? 'resume' : 'pause'}`); await refreshSystem(); });
  $('#cancel-all').onclick = guard(async () => {
    if (!(await confirmDialog('Cancelar todo', 'Se detendrán todas las tareas en curso y en espera.'))) return;
    const r = await post('/api/queue/cancel-all');
    toast(`${r.cancelled} tarea(s) canceladas`, false);
    await refreshSystem();
  });
  $('#log-level').onchange = renderLogs;
}

// ---------- datos en vivo ----------
let office;
async function refreshState() {
  const s = await api('/api/state');
  const provSig = JSON.stringify([s.providers ?? [], s.engines_off ?? []]);
  const provChanged = provSig !== JSON.stringify([state.providers, state.enginesOff ?? []]);
  state.enginesOff = s.engines_off ?? [];
  state.messages = s.messages ?? state.messages;
  state.servers = s.servers ?? state.servers ?? [];
  Object.assign(state, { agents: s.agents, projects: s.projects, providers: s.providers ?? [], stats: s.stats, settings: s.settings, templates: s.templates, schedules: s.schedules, costs: s.costs });
  const before = state.tasks;
  state.tasks = new Map(s.tasks.map((t) => [t.id, t]));
  if (state.booted) for (const t of s.tasks) handleTransition(before.get(t.id)?.status, t); // por si el WebSocket se perdió un cambio
  state.booted = true;
  if (!state.modelInfo) refreshModels();
  if (provChanged && openTaskDialog) { fillSelects(); fillBoardTools(); } // un proveedor nuevo aparece en el selector sin recargar
  render();
}

/**
 * Aviso que se queda en pantalla hasta cerrarlo (a diferencia del toast, que se va solo).
 * `actions`: [[texto, fn]]. Devuelve el nodo para poder cerrarlo desde fuera.
 */
function notice({ icon = 'ℹ', title, lines = [], actions = [], kind = '' }) {
  const box = el('div', { className: `notice ${kind}`, role: 'status' });
  const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 200); };
  box.append(
    el('div', { className: 'n-head' }, el('b', { textContent: `${icon} ${title}` }), el('button', { className: 'n-x', type: 'button', textContent: '✕', title: 'Cerrar', ariaLabel: 'Cerrar notificación', onclick: close })),
    ...lines.filter(Boolean).map((l) => (typeof l === 'string' ? el('div', { className: 'n-line', textContent: l }) : l)),
    ...(actions.length ? [el('div', { className: 'n-act' }, ...actions.map(([t, fn, primary]) => el('button', { type: 'button', className: primary ? 'primary' : '', textContent: t, onclick: guard(async () => { if ((await fn()) !== false) close(); }) })))] : []));
  $('#notices').prepend(box);
  while ($('#notices').children.length > 4) $('#notices').lastElementChild.remove(); // como mucho 4 a la vez
  return box;
}

/** El despachador creó un agente nuevo para una misión: avisar en la web y, si diste permiso, también en Windows. */
function noticeAgentCreated({ agent, task, reason }) {
  const edits = /\b(Edit|Write)\b/.test(agent.tools ?? '');
  const perms = edits ? 'puede leer y editar archivos del proyecto' : 'solo lectura (no edita archivos)';
  const wantsDesktop = 'Notification' in window && Notification.permission === 'default';
  notice({
    icon: '🤖', kind: 'agent', title: 'Nuevo agente creado',
    lines: [
      el('div', { className: 'n-name' }, el('strong', { textContent: agent.name }), span(` — ${agent.description}`)),
      `Permisos: ${perms}.`,
      `Lo creó el despachador para la misión #${task.id} «${task.title}»${reason ? `: ${reason}` : ''}.`,
      'Se guardó en tu carpeta de agentes y ya puedes elegirlo en las misiones nuevas.',
    ],
    actions: [
      ['Ver misión', () => openDrawer(task.id), true],
      ...(wantsDesktop ? [['Avisarme también en Windows', async () => { await Notification.requestPermission(); return false; }]] : []),
    ],
  });
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('🤖 Nuevo agente creado', { body: `${agent.name}: ${agent.description}`, tag: `agent-${agent.name}` }); } catch { /* algunos navegadores no lo permiten fuera de un service worker */ }
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'task') {
      const prevStatus = state.tasks.get(m.task.id)?.status;
      state.tasks.set(m.task.id, m.task);
      handleTransition(prevStatus, m.task);
      if (m.message) onMessage(m.message);
      if (m.event && state.open === m.task.id) logLine(m.event);
      if (m.event && state.agentLive === m.task.id) appendLine($('#a-log'), m.event, state.tasks.get(m.task.id));
      render();
    } else if (m.type === 'log') {
      pushLog(m.entry);
    } else if (m.type === 'queue') {
      if (state.stats) state.stats.paused = m.paused;
      if (state.system) state.system.queue.paused = m.paused;
      render();
    } else if (m.type === 'approval') {
      refreshApprovals();
    } else if (m.type === 'deleted') {
      state.tasks.delete(m.id);
      if (state.open === m.id) state.open = null;
      render();
    } else if (m.type === 'vault') {
      refreshVault();
    } else if (m.type === 'agents-changed') {
      refreshState().then(renderAgentsCard).catch(() => {}); // importados desde esta u otra pestaña
    } else if (m.type === 'agent-created') {
      noticeAgentCreated(m);
      refreshState().then(renderAgentsCard).catch(() => {}); // el agente nuevo aparece ya en las listas
    }
  };
  ws.onclose = () => setTimeout(connect, 1500); // reconexión simple
}

// ---------- skins ----------
const SKIN_KEY = 'oficina.skin';
const UI_VARS = { bg: '--bg', panel: '--panel', panel2: '--panel-2', line: '--line', text: '--text', muted: '--muted', gold: '--gold', blue: '--blue', red: '--red', green: '--green', violet: '--violet', star1: '--star1', star2: '--star2' };
const skinStore = {
  get() { try { return localStorage.getItem(SKIN_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(SKIN_KEY, v); } catch { /* sin almacenamiento: el skin vale solo esta sesión */ } },
};
let skinChoice = new URLSearchParams(location.search).get('skin') || skinStore.get() || 'clasico';
if (skinChoice !== AUTO.id && !skinById(skinChoice)) skinChoice = 'clasico';
let appliedSkin = null;
let baseTitle = document.title;
let attnCount = 0;

function paintBadge(n) {
  attnCount = n;
  const b = $('#attn-badge');
  b.hidden = !n; b.textContent = String(n);
  document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
}

function applySkin(announce = false) {
  const sk = resolveSkin(skinChoice);
  if (sk !== appliedSkin) {
    appliedSkin = sk;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(UI_VARS)) root.style.setProperty(v, sk.ui[k]);
    root.dataset.skin = sk.id;
    $('#brand').textContent = sk.title;
    baseTitle = `${sk.title} · Oficina Virtual`;
    paintBadge(attnCount);
    office?.setSkin(sk);
    if (state.agentOpen) renderAgent(); // el nombre de la sala cambia con el skin
  }
  for (const b of document.querySelectorAll('.skin-card')) b.setAttribute('aria-checked', String(b.dataset.skin === skinChoice));
  if (announce) toast(`Skin: ${skinChoice === AUTO.id ? `Auto (${sk.name})` : sk.name}`, false);
}

function setupSkins() {
  const panel = $('#skin-panel'); const fab = $('#skin-fab');
  const entries = [...SKIN_LIST, AUTO];
  for (const e of entries) {
    const canvas = el('canvas');
    if (e.id === AUTO.id) drawSkinPreview(canvas, skinById(AUTO.day), skinById(AUTO.night)); else drawSkinPreview(canvas, e);
    const card = el('button', { type: 'button', className: 'skin-card' }, canvas, el('span', { className: 'sk-name', textContent: e.name }), el('span', { className: 'sk-tag', textContent: e.tagline }));
    card.dataset.skin = e.id;
    card.setAttribute('role', 'radio');
    card.onclick = () => { skinChoice = e.id; skinStore.set(e.id); applySkin(true); };
    panel.append(card);
  }
  const toggle = (open) => {
    panel.hidden = !open; fab.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('[aria-checked="true"]')?.focus();
  };
  fab.onclick = () => toggle(panel.hidden);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !panel.hidden) { toggle(false); fab.focus(); } });
  document.addEventListener('click', (ev) => { if (!panel.hidden && !ev.target.closest('#skin-widget')) toggle(false); });
  setInterval(() => { if (skinChoice === AUTO.id) applySkin(); }, 60_000); // Auto cambia con la hora
}

// ---------- avisos y bandeja de atención ----------
const alerts = createAlerts({
  skinId: () => appliedSkin?.id,
  onOpen: (t) => (t.kind === 'objective' ? openDrawer(t.id) : openAgent(t.agent)),
});
const notified = new Set();

function handleTransition(prevStatus, task) {
  const ev = transition(prevStatus, task);
  if (!ev) return;
  const key = `${task.id}:${task.status}:${task.finished_at}`;
  if (notified.has(key)) return; // el WebSocket y el refresco periódico pueden ver el mismo cambio
  notified.add(key);
  if (alerts.fire(ev) && !document.hidden) toast(`${KIND_LABEL[ev.kind]}: #${task.id} ${task.title}`, ev.kind === 'failed');
}

function setupAlerts() {
  const bell = $('#alerts-btn');
  const paint = () => { bell.setAttribute('aria-pressed', String(alerts.enabled)); bell.textContent = alerts.enabled ? '🔔 Avisos: sí' : '🔕 Avisos: no'; };
  bell.onclick = async () => {
    const on = alerts.setEnabled(!alerts.enabled);
    paint(); // el botón cambia ya; el permiso del navegador puede tardar en contestarse
    if (!on) return toast('Avisos desactivados', false);
    toast('Avisos activados con sonido', false);
    const perm = await alerts.ensurePermission();
    if (perm === 'granted') toast('Avisos activados: sonido y notificaciones del navegador', false);
    else if (perm !== 'default') toast('Las notificaciones del navegador no están permitidas: solo sonará (puedes habilitarlas en el candado de la barra de direcciones)', false);
  };
  paint();
  document.addEventListener('pointerdown', () => alerts.unlock(), { once: true }); // el audio necesita un gesto antes de poder sonar
  let testing = false;
  $('#sound-test').onclick = async () => {
    if (testing) return;
    testing = true;
    try {
      for (const [kind, what] of Object.entries(SOUNDS)) {
        toast(`🔊 ${KIND_LABEL[kind] ?? kind}: ${what}`, false);
        alerts.preview(kind);
        await new Promise((r) => setTimeout(r, 1400));
      }
    } finally { testing = false; }
  };
}

const attn = { selected: new Set(), dirty: false };
$('#attention-list').addEventListener('focusout', () => setTimeout(() => { if (attn.dirty && !$('#attention-list').contains(document.activeElement)) renderAttention(); }));
const GROUPS = [['question', 'Te hacen una pregunta'], ['failed', 'Fallidas'], ['plan', 'Planes por lanzar'], ['review', 'Por revisar']];
const since = (ts) => { if (!ts) return ''; const m = Math.max(0, Math.round((Date.now() - parseTs(ts)) / 60000)); return m < 1 ? 'hace un momento' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };

function renderAttention(items = attentionItems([...state.tasks.values()])) {
  const box = $('#attention-list');
  if (box.contains(document.activeElement) && document.activeElement.matches('textarea')) { attn.dirty = true; return; } // no pisar lo que se está escribiendo
  attn.dirty = false;
  for (const id of [...attn.selected]) if (!items.some((i) => i.task.id === id)) attn.selected.delete(id);
  const parts = [];
  for (const [kind, label] of GROUPS) {
    const group = items.filter((i) => i.kind === kind);
    if (!group.length) continue;
    parts.push(el('h3', { className: `attn-group ${kind}`, textContent: `${label} (${group.length})` }), ...group.map(attnCard));
  }
  box.replaceChildren(...(parts.length ? parts : [el('div', { className: 'attn-empty', textContent: 'Nada pendiente: todos tus agentes están al día.' })]));
  renderBulk(items);
}

function renderBulk(items) {
  const sel = items.filter((i) => attn.selected.has(i.task.id));
  const approvable = sel.filter((i) => i.kind === 'review' || i.kind === 'question');
  const retryable = sel.filter((i) => i.kind === 'failed');
  const all = el('button', { type: 'button', textContent: 'Seleccionar por revisar', disabled: !items.some((i) => i.kind === 'review') });
  all.onclick = () => { for (const i of items) if (i.kind === 'review') attn.selected.add(i.task.id); renderAttention(); };
  const approve = el('button', { type: 'button', className: 'primary', textContent: `Aprobar (${approvable.length})`, disabled: !approvable.length });
  approve.onclick = guard(async () => {
    for (const i of approvable) await api(`/api/tasks/${i.task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    attn.selected.clear();
    toast(`${approvable.length} misión(es) aprobada(s)`, false);
  });
  const retry = el('button', { type: 'button', textContent: `Reintentar (${retryable.length})`, disabled: !retryable.length });
  retry.onclick = guard(async () => {
    for (const i of retryable) await withConfirm(`/api/tasks/${i.task.id}/run`, `«${i.task.title}» puede editar archivos de tu proyecto. ¿Permitirlo?`);
    attn.selected.clear();
  });
  $('#attn-bulk').replaceChildren(all, approve, retry);
}

function attnCard({ kind, task: t }) {
  const card = el('article', { className: `attn ${kind}` });
  const head = el('div', { className: 'attn-head' });
  if (kind !== 'plan') {
    const cb = el('input', { type: 'checkbox', checked: attn.selected.has(t.id) });
    cb.setAttribute('aria-label', `Seleccionar #${t.id}`);
    cb.onchange = () => { cb.checked ? attn.selected.add(t.id) : attn.selected.delete(t.id); renderBulk(attentionItems([...state.tasks.values()])); };
    head.append(cb);
  }
  head.append(el('strong', { textContent: `#${t.id} ${t.title}` }));
  const meta = el('div', { className: 'attn-meta', textContent: [t.kind === 'objective' ? 'coordinador' : t.agent, t.project || 'sin proyecto', t.engine, since(t.finished_at ?? t.updated_at), t.review_of && `revisión de #${t.review_of}`, t.change_state === 'pending' && '✎ cambios por aplicar'].filter(Boolean).join(' · ') });
  const pending = kind === 'plan' ? children(t.id).filter((k) => ['backlog', 'failed'].includes(k.status)).length : 0;
  const text = kind === 'failed' ? (t.error || 'Falló sin detalle') : kind === 'plan' ? `${pending} paso(s) pendientes de lanzar` : (t.result || '');
  const body = text ? el('div', { className: `attn-body${kind === 'failed' ? ' err' : ''}`, textContent: text.length > 1500 ? text.slice(-1500) : text }) : null; // de una pregunta importa el final
  const act = el('div', { className: 'attn-actions' });
  const open = el('button', { type: 'button', textContent: kind === 'plan' ? 'Abrir plan' : 'Abrir' });
  open.onclick = () => openDrawer(t.id);
  if (kind === 'failed') {
    const retry = el('button', { type: 'button', className: 'primary', textContent: 'Reintentar' });
    retry.onclick = guard(() => withConfirm(`/api/tasks/${t.id}/run`, 'Esta misión puede editar archivos de tu proyecto o actuar sobre un servidor (lo fuerte te lo preguntará antes). ¿Permitirlo?'));
    const hangar = el('button', { type: 'button', textContent: 'Al Hangar' });
    hangar.onclick = guard(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'backlog' }) }));
    act.append(retry, hangar, open);
  } else if (kind === 'plan') {
    act.append(open);
  } else {
    const ok = el('button', { type: 'button', textContent: 'Aprobar ✓' });
    ok.onclick = guard(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }));
    act.append(ok, open);
  }
  card.append(head, meta, ...(body ? [body] : []), act);
  if (kind === 'review' || kind === 'question') card.append(replyForm(t));
  return card;
}

office = createOffice($('#office'), {
  onSelectAgent: (name) => openAgent(name),
});
setupSkins();
applySkin();
setupAlerts();
await refreshState();
setupForms();
showView('office');
office.start();
connect();
setInterval(() => refreshState().catch(() => {}), 5000);
setInterval(() => refreshModels(), 10_000); // la cabecera muestra si LM Studio está activo, en cualquier vista
window.__office = { state, office }; // depuración desde la consola
