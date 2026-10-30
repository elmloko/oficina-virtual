// UI sin build. Todo texto de usuario entra por textContent (nunca innerHTML).
import { createOffice, drawSkinPreview } from './office.js';
import { SKIN_LIST, AUTO, skinById, resolveSkin } from './skins.js';

const COLUMNS = [
  ['backlog', 'Hangar (pendientes)'],
  ['queued', 'En cola'],
  ['running', 'En misión'],
  ['review', 'Por revisar'],
  ['done', 'Completadas'],
  ['failed', 'Fallidas'],
];
const MANUAL = new Set(['backlog', 'review', 'done']);
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

const state = {
  tasks: new Map(), agents: [], projects: [], providers: [], system: null, logs: [], stats: null, settings: {}, templates: [], schedules: [], costs: null,
  open: null, view: 'office',
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
async function withConfirm(path, text) {
  try { return await post(path); } catch (e) {
    if (e.status === 409 && e.data?.needsConfirm) {
      if (await confirmDialog('Permitir edición de archivos', text ?? e.message)) return post(path, { confirm: true });
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
  if (v === 'costs') refreshCosts();
  clearInterval(showView.timer);
  if (v === 'system') { refreshSystem(); showView.timer = setInterval(refreshSystem, 2000); }
  render();
}

function render() {
  const s = state.stats;
  $('#stats').textContent = s ? `Claude ${s.active.claude}/${s.limit?.claude ?? '?'} · Ollama ${s.active.ollama}/${s.limit?.ollama ?? '?'} · ${s.waiting} en espera${s.paused ? ' · COLA EN PAUSA' : ''} · hoy ${money(state.costs?.today)}` : '';
  office.update({ agents: state.agents, tasks: [...state.tasks.values()], stats: s ? { ...s, costToday: state.costs?.today ?? 0 } : null });
  if (state.view === 'board') renderBoard();
  if (state.view === 'routines') renderRoutines();
  if (state.view === 'system' && state.system) renderSystem();
  if (state.open) drawer(state.tasks.get(state.open));
}

// ---------- tablero ----------
function renderBoard() {
  const board = $('#board');
  board.replaceChildren();
  for (const [status, label] of COLUMNS) {
    const tasks = [...state.tasks.values()].filter((t) => t.status === status && !t.parent_id).sort((a, b) => b.id - a.id);
    // los pasos de un plan se muestran dentro de su objetivo y también sueltos, para seguimiento global
    const steps = [...state.tasks.values()].filter((t) => t.status === status && t.parent_id).sort((a, b) => a.id - b.id);
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
    el('span', { className: 'tag', textContent: t.engine }),
  );
  if (t.mode === 'edit') meta.append(el('span', { className: 'tag edit', textContent: 'edita' }));
  if (t.cost_usd) meta.append(el('span', { textContent: money(t.cost_usd) }));
  if (kids.length) meta.append(el('span', { textContent: `pasos ${kids.filter((k) => ['review', 'done'].includes(k.status)).length}/${kids.length}` }));
  if (t.parent_id) meta.append(el('span', { textContent: `↳ #${t.parent_id}` }));
  if (t.depends_on?.length) meta.append(el('span', { textContent: `espera ${t.depends_on.map((d) => '#' + d).join(' ')}` }));
  c.append(el('div', { className: 't', textContent: `#${t.id} ${t.title}` }), meta);
  c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(t.id)));
  c.addEventListener('click', () => openDrawer(t.id));
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDrawer(t.id); });
  return c;
}

// ---------- panel lateral ----------
async function openDrawer(id) {
  state.open = id;
  $('#d-log').replaceChildren();
  for (const ev of await api(`/api/tasks/${id}/events`)) logLine(ev);
  drawer(state.tasks.get(id));
}

function logLine(ev) {
  const box = $('#d-log');
  box.append(el('div', { className: ev.kind, textContent: ev.kind === 'tool' ? `⚙ ${ev.text}` : ev.text }));
  box.scrollTop = box.scrollHeight;
}

function drawer(t) {
  if (!t) { $('#drawer').hidden = true; state.open = null; return; }
  $('#drawer').hidden = false;
  $('#d-title').textContent = `#${t.id} ${t.title}`;
  const deps = t.depends_on?.length ? ` · depende de ${t.depends_on.map((d) => '#' + d).join(', ')}` : '';
  $('#d-meta').textContent = `${t.kind === 'objective' ? 'coordinador' : t.agent} · ${t.project || 'sin proyecto'} · ${t.engine}${t.model ? ':' + t.model : ''}/${t.mode} · ${t.status}${deps}${t.error ? ' · ' + t.error : ''}`;
  $('#d-result').textContent = t.result || '';
  const act = $('#d-actions');
  act.replaceChildren();
  const busy = t.status === 'queued' || t.status === 'running';
  const isObj = t.kind === 'objective';
  const kids = isObj ? children(t.id) : [];

  const runLabel = isObj ? (kids.length ? 'Replanificar' : 'Planificar') : (['failed', 'review', 'done'].includes(t.status) ? 'Reintentar' : 'Ejecutar');
  const run = el('button', { className: kids.length && isObj ? '' : 'primary', textContent: runLabel, disabled: busy });
  run.onclick = guard(async () => {
    if (isObj && kids.length && !(await confirmDialog('Replanificar', 'Se generará un plan nuevo y se mantendrán los pasos anteriores. ¿Continuar?'))) return;
    await withConfirm(`/api/tasks/${t.id}/run`, 'Esta misión puede editar archivos de tu proyecto. ¿Permitirlo?');
  });
  const stop = el('button', { textContent: 'Cancelar', disabled: !busy });
  stop.onclick = guard(() => post(`/api/tasks/${t.id}/cancel`));
  act.append(run, stop);

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
  const del = el('button', { className: 'danger', textContent: 'Eliminar' });
  del.onclick = guard(async () => { if (await confirmDialog('Eliminar misión', isObj && kids.length ? 'Se eliminarán también sus pasos.' : '¿Eliminar esta misión?')) await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); });
  act.append(del);

  const steps = $('#d-steps');
  steps.replaceChildren();
  if (kids.length) {
    steps.append(el('h3', { textContent: 'Plan' }));
    for (const k of kids) {
      const row = el('button', { className: `step ${k.status}`, textContent: `#${k.id} [${k.status}] ${k.agent} — ${k.title}` });
      row.onclick = () => openDrawer(k.id);
      steps.append(row);
    }
  }
}

// ---------- formularios ----------
function fillSelects() {
  const f = $('#new-form');
  f.agent.replaceChildren(...state.agents.map((a) => el('option', { value: a.name, textContent: `${a.name} — ${a.description}`.slice(0, 80) })));
  const projectOptions = () => [el('option', { value: '', textContent: '(sin proyecto)' }), ...state.projects.map((p) => el('option', { value: p.name, textContent: p.name }))];
  f.project.replaceChildren(...projectOptions());
  const engines = [['auto', 'Auto (el router decide)'], ['claude', 'Claude (suscripción)'], ['ollama', 'Ollama (local)'], ...state.providers.map((p) => [p.name, `${p.name} · en internet (${p.model})`])];
  const keep = f.engine.value;
  f.engine.replaceChildren(...engines.map(([v, t]) => el('option', { value: v, textContent: t })));
  if (engines.some(([v]) => v === keep)) f.engine.value = keep;
  $('#routine-form').project.replaceChildren(...projectOptions());
  $('#routine-form').template.replaceChildren(...state.templates.map((t) => el('option', { value: t.id, textContent: `${t.name}${t.needsProject ? ' (requiere proyecto)' : ''}` })));
  $('#days').replaceChildren(...DAYS.map((d, i) => el('label', { className: 'chk' }, el('input', { type: 'checkbox', name: 'day', value: String(i) }), el('span', { textContent: d }))));
}

function wireDialog(dialogSel, formSel, submit) {
  const d = $(dialogSel); const f = $(formSel);
  for (const b of d.querySelectorAll('[data-close]')) b.onclick = () => d.close();
  d.addEventListener('close', () => f.reset()); // al cerrar no quedan valores viejos
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('.form-error');
    err.textContent = '';
    try { await submit(f); f.reset(); d.close(); } catch (x) { err.textContent = x.message; }
  };
  return (setup) => { f.querySelector('.form-error').textContent = ''; setup?.(f); d.showModal(); };
}

let openTaskDialog, openObjDialog, openRoutineDialog;

function setupForms() {
  fillSelects();
  openTaskDialog = wireDialog('#new-dialog', '#new-form', async (f) => { await post('/api/tasks', Object.fromEntries(new FormData(f))); });
  openObjDialog = wireDialog('#obj-dialog', '#obj-form', async (f) => {
    const o = await post('/api/objectives', Object.fromEntries(new FormData(f)));
    await post(`/api/tasks/${o.id}/run`).catch((e) => toast(e.message));
    openDrawer(o.id);
  });
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
    $('#mode-hint').hidden = taskForm.mode.value !== 'edit';
    const prov = state.providers.find((p) => p.name === taskForm.engine.value);
    $('#model-row').hidden = !prov;
    taskForm.model.placeholder = prov ? `por defecto: ${prov.model}` : '';
    const hint = $('#engine-hint');
    hint.hidden = !prov;
    if (prov) hint.textContent = `☁ El texto de la misión (título, descripción y resultados de pasos previos) se enviará a ${prov.name}. No ve archivos del proyecto y no puede editarlos.`;
  };
  taskForm.mode.onchange = syncHint;
  taskForm.engine.onchange = syncHint;
  taskForm.addEventListener('reset', () => setTimeout(syncHint));
  const rf = $('#routine-form');
  const syncTpl = () => {
    const t = state.templates.find((x) => x.id === rf.template.value);
    $('#tpl-desc').textContent = t ? `${t.agent} · ${describeSpec(t.spec)} — ${t.description}` : '';
    if (t?.defaultProject && !rf.project.value) rf.project.value = t.defaultProject;
  };
  rf.template.onchange = syncTpl;
  rf.addEventListener('reset', () => setTimeout(syncTpl));
  // clic en el fondo cierra el modal (no el de confirmación, que exige elegir)
  for (const d of document.querySelectorAll('dialog:not(#confirm-dialog)')) {
    d.addEventListener('mousedown', (e) => { if (e.target === d) d.close(); });
  }
  $('#new-btn').onclick = () => openTaskDialog(syncHint);
  $('#obj-btn').onclick = () => openObjDialog();
  $('#new-routine').onclick = () => openRoutineDialog(syncTpl);
  setupSystem();
  $('#d-close').onclick = () => { state.open = null; $('#drawer').hidden = true; };
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showView(b.dataset.view);
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

async function refreshCosts() {
  const [costs, audit] = await Promise.all([api('/api/costs'), api('/api/audit')]);
  state.costs = costs;
  const f = $('#settings-form');
  fillSettings();
  const budget = costs.daily_budget_usd;
  $('#costs-summary').textContent = `Hoy: ${money(costs.today)}${budget ? ` de ${money(budget)} (${Math.round((costs.today / budget) * 100)}%)` : ' (sin límite)'}`;
  table($('#costs-agents'), ['Agente', 'Tareas', 'USD'], costs.byAgent.map((a) => [a.agent, a.tasks, money(a.cost_usd)]));
  table($('#costs-days'), ['Día', 'Tareas', 'USD'], costs.byDay.map((d) => [d.day, d.tasks, money(d.cost_usd)]));
  table($('#audit'), ['Hora', 'Acción', 'Tarea', 'Detalle'], audit.slice(0, 40).map((a) => [a.ts, a.action, a.task_id ?? '', a.detail]));
}

// ---------- sistema ----------
const fmtBytes = (n) => (n == null ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** SQLite guarda 'YYYY-MM-DD HH:MM:SS' en UTC sin zona; el runner guarda ISO. Ambos se interpretan bien. */
const parseTs = (s) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
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
  box.dataset.sig = sig;
  box.replaceChildren(...build());
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
  setChip('#chip-claude', s.claude.ok ? `claude ${s.claude.version.split(' ')[0]}` : 'claude no disponible', s.claude.ok ? 'ok' : 'bad');
  setChip('#chip-ollama', s.ollama.ok ? `ollama · ${s.ollama.models.length} modelos` : 'ollama apagado', s.ollama.ok ? 'ok' : 'warn');
  const on = s.providers.filter((p) => p.configured && p.needsKey || (p.custom && !p.needsKey)).length;
  setChip('#chip-apis', `${on} proveedor(es) en internet`, on ? 'ok' : 'warn');
  $('#queue-toggle').textContent = s.queue.paused ? 'Reanudar cola' : 'Pausar cola';
  $('#queue-toggle').className = s.queue.paused ? 'primary' : '';

  // estado general
  $('#sys-health').replaceChildren(kv([
    ['Servidor', span(`en línea hace ${fmtDur(s.server.uptime_s)} · Node ${s.server.node} · pid ${s.server.pid}`)],
    ['Base de datos', span(`${fmtBytes(s.db.size_bytes)} · ${Object.entries(s.db.tasks).map(([k, v]) => `${v} ${k}`).join(', ') || 'vacía'}`)],
    ['Claude Code', el('span', {}, dot(s.claude.ok), span(s.claude.ok ? s.claude.version : s.claude.error))],
    ['Ollama', el('span', {}, dot(s.ollama.ok), span(s.ollama.ok ? `${s.ollama.models.length} modelos · cargados: ${s.ollama.loaded.map((m) => `${m.name} (${fmtBytes(m.size)})`).join(', ') || 'ninguno'}` : s.ollama.error))],
    ['Proyectos', el('span', {}, dot(s.paths.htdocs.exists), span(`${s.paths.htdocs.path} · ${s.paths.htdocs.projects} proyectos`))],
    ...s.paths.extra.map((e) => [`@${e.name.slice(1)}`, el('span', {}, dot(e.exists), span(`${e.path} (solo lectura)`))]),
  ]));

  // cola
  const q = s.queue;
  const gauge = (name, key) => {
    const used = q.active[key] ?? 0; const lim = q.limit[key] ?? 1;
    return el('div', { className: 'gauge' }, span(`${name}: ${used}/${lim}`), el('div', { className: 'bar' }, el('i', { className: used >= lim ? 'full' : '', style: `width:${Math.min(100, (used / lim) * 100)}%` })));
  };
  const apiUsed = Object.entries(q.active).filter(([k]) => !['claude', 'ollama'].includes(k)).reduce((a, [, v]) => a + v, 0);
  const rows = [gauge('Claude', 'claude'), gauge('Ollama', 'ollama'),
    el('div', { className: 'gauge' }, span(`Internet: ${apiUsed}/${q.limit.api}`), el('div', { className: 'bar' }, el('i', { className: apiUsed >= q.limit.api ? 'full' : '', style: `width:${Math.min(100, (apiUsed / q.limit.api) * 100)}%` })))];
  const list = el('div', { className: 'mini-list' });
  for (const t of q.running) { const b = el('button', { className: 'mini' }, span(`▶ #${t.id} ${t.title}`), el('span', { className: 'muted', textContent: `${t.agent} · ${t.engine} · ${fmtDur(Math.max(0, (Date.now() - parseTs(t.started_at)) / 1000))}` })); b.onclick = () => openDrawer(t.id); list.append(b); }
  for (const w of q.waiting) { const b = el('button', { className: 'mini' }, span(`⏳ #${w.id} ${w.title}`), el('span', { className: 'muted', textContent: w.reason })); b.onclick = () => openDrawer(w.id); list.append(b); }
  if (!list.children.length) list.append(el('p', { className: 'hint', textContent: 'Nada en curso.' }));
  $('#sys-queue').replaceChildren(...rows, list);

  // actividad
  const a = s.activity;
  const act = el('div', {}, el('div', { className: 'stat-row' },
    el('div', { className: 'stat' }, el('b', { textContent: String(a.total) }), span('tareas terminadas')),
    el('div', { className: 'stat' }, el('b', { textContent: a.successRate == null ? '—' : `${Math.round(a.successRate * 100)}%` }), span('éxito')),
    el('div', { className: 'stat' }, el('b', { textContent: fmtDur(a.avgSeconds) }), span('duración media')),
    el('div', { className: 'stat' }, el('b', { textContent: money(a.cost_today) }), span('costo hoy'))));
  const byEngine = el('div', { className: 'mini-list' }, ...a.byEngine.map((e) => el('div', { className: 'mini' }, span(e.engine), el('span', { className: 'muted', textContent: `${e.ok} ok · ${e.failed} fallos · ${money(e.cost_usd)}` }))));
  const fails = el('div', { className: 'mini-list' }, ...(s.failures.length ? [el('h3', { textContent: 'Fallos recientes' })] : []),
    ...s.failures.map((f) => { const b = el('button', { className: 'mini err' }, span(`#${f.id} ${f.title}`), el('span', { className: 'muted', textContent: (f.error || '').slice(0, 60) })); b.onclick = () => openDrawer(f.id); return b; }));
  $('#sys-activity').replaceChildren(act, byEngine, fails);

  // rutinas
  $('#sys-schedules').replaceChildren(...(s.schedules.length ? s.schedules : [null]).map((r) => r
    ? el('div', { className: 'mini' }, span(`${r.enabled ? '' : '⏸ '}${r.name}`), el('span', { className: 'muted', textContent: r.next_run ? `próxima ${new Date(r.next_run).toLocaleString()}` : 'pausada' }))
    : el('p', { className: 'hint', textContent: 'Sin rutinas programadas.' })));

  // proveedores (solo se reconstruye si cambian los datos, para no perder lo que escribes)
  renderIfChanged($('#sys-providers'), s.providers, () => s.providers.map(providerRow));
  fillSettings();
}

function providerRow(p) {
  const row = el('div', { className: 'prov-row' });
  const status = !p.needsKey ? 'sin clave (local)' : p.configured ? `activo · clave ${p.keyHint}` : 'sin configurar';
  row.append(el('strong', { textContent: p.name }), el('span', {}, el('span', { className: p.configured ? 'dot-ok' : 'dot-off' }), span(`${status} · ${p.model}`)));
  const btns = el('span', { className: 'btns' });
  const res = el('div', { className: 'res' });
  const keyform = el('form', { className: 'keyform', hidden: true });
  const input = el('input', { type: 'password', placeholder: `Pega la clave de ${p.name}`, autocomplete: 'off', spellcheck: false });
  keyform.append(input, el('button', { className: 'primary', type: 'submit', textContent: 'Guardar' }), el('button', { type: 'button', textContent: 'Cancelar', onclick: () => { keyform.hidden = true; input.value = ''; } }));
  keyform.onsubmit = guard(async (e) => {
    e.preventDefault();
    await api(`/api/system/providers/${p.name}/key`, { method: 'PUT', body: JSON.stringify({ key: input.value.trim() }) });
    input.value = '';
    toast(`Clave de ${p.name} guardada`, false);
    await refreshState(); await refreshSystem();
  });
  if (p.configured) {
    btns.append(el('button', { textContent: 'Probar', onclick: guard(async () => {
      res.className = 'res'; res.textContent = 'Probando…';
      const r = await post(`/api/system/providers/${p.name}/test`);
      res.className = `res ${r.ok ? 'ok' : 'bad'}`; res.textContent = r.ok ? `✓ Conexión correcta (${r.ms} ms)` : `✕ ${r.error}`;
    }) }));
  }
  if (p.needsKey) {
    btns.append(el('button', { textContent: p.configured ? 'Cambiar clave' : 'Poner clave', onclick: () => { keyform.hidden = false; input.focus(); } }));
    if (p.configured) {
      btns.append(el('button', { className: 'danger', textContent: 'Quitar', onclick: guard(async () => {
        if (!(await confirmDialog('Quitar clave', `Se borrará la clave de ${p.name} del archivo .env.`))) return;
        await api(`/api/system/providers/${p.name}/key`, { method: 'DELETE' });
        await refreshState(); await refreshSystem();
      }) }));
    }
  }
  row.append(btns, keyform, res);
  return row;
}

async function refreshSystem() {
  try {
    state.system = await api('/api/system');
    if (!state.logs.length) { state.logs = await api('/api/logs?limit=200'); renderLogs(); }
    renderSystem();
  } catch (e) { /* el servidor puede estar reiniciando */ }
}

function setupSystem() {
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
  const provSig = JSON.stringify(s.providers ?? []);
  const provChanged = provSig !== JSON.stringify(state.providers);
  Object.assign(state, { agents: s.agents, projects: s.projects, providers: s.providers ?? [], stats: s.stats, settings: s.settings, templates: s.templates, schedules: s.schedules, costs: s.costs });
  state.tasks = new Map(s.tasks.map((t) => [t.id, t]));
  if (provChanged && openTaskDialog) fillSelects(); // un proveedor nuevo aparece en el selector sin recargar
  render();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'task') {
      state.tasks.set(m.task.id, m.task);
      if (m.event && state.open === m.task.id) logLine(m.event);
      render();
    } else if (m.type === 'log') {
      pushLog(m.entry);
    } else if (m.type === 'queue') {
      if (state.stats) state.stats.paused = m.paused;
      if (state.system) state.system.queue.paused = m.paused;
      render();
    } else if (m.type === 'deleted') {
      state.tasks.delete(m.id);
      if (state.open === m.id) state.open = null;
      render();
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

function applySkin(announce = false) {
  const sk = resolveSkin(skinChoice);
  if (sk !== appliedSkin) {
    appliedSkin = sk;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(UI_VARS)) root.style.setProperty(v, sk.ui[k]);
    root.dataset.skin = sk.id;
    $('#brand').textContent = sk.title;
    document.title = `${sk.title} · Oficina Virtual`;
    office?.setSkin(sk);
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

office = createOffice($('#office'), {
  onSelect: (id) => openDrawer(id),
  onSelectAgent: (name) => openTaskDialog((f) => { f.agent.value = name; }),
});
setupSkins();
applySkin();
await refreshState();
setupForms();
showView('office');
office.start();
connect();
setInterval(() => refreshState().catch(() => {}), 5000);
window.__office = { state, office }; // depuración desde la consola
