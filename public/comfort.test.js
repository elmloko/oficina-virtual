import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTasks, isFiltering, NO_PROJECT, norm } from './filters.js';
import { agentMetrics, summarize } from './metrics.js';
import { taskToMarkdown, tasksToMarkdown, markdownToHtml, printableHtml } from './exporter.js';

const T = (id, o = {}) => ({ id, title: `t${id}`, description: '', agent: 'backend', project: null, status: 'review', kind: 'task', engine: 'claude', mode: 'read', result: '', error: null, cost_usd: 0, started_at: null, finished_at: null, ...o });

// ---------- filtros ----------
test('filterTasks: texto sin acentos ni mayúsculas, en título, descripción, resultado, error, agente y proyecto', () => {
  const tasks = [
    T(1, { title: 'Migración de tarifas' }),
    T(2, { description: 'revisar el módulo de guías' }),
    T(3, { result: 'Encontré un N+1 en Shipments' }),
    T(4, { error: 'Timeout tras 20 min' }),
    T(5, { agent: 'security', project: 'syspaqueteria' }),
  ];
  const ids = (f) => filterTasks(tasks, f).map((t) => t.id);
  assert.deepEqual(ids({ q: 'migracion' }), [1]);
  assert.deepEqual(ids({ q: 'GUIAS' }), [2]);
  assert.deepEqual(ids({ q: 'n+1' }), [3]);
  assert.deepEqual(ids({ q: 'timeout' }), [4]);
  assert.deepEqual(ids({ q: 'syspaq' }), [5]);
  assert.deepEqual(ids({ q: 'security' }), [5]);
  assert.deepEqual(ids({ q: '   ' }), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids({ q: 'no existe' }), []);
  assert.equal(norm('Migración ÁÉÍ'), 'migracion aei');
});

test('filterTasks: por id (#4 o 4), agente, proyecto, sin proyecto y estado; los filtros se combinan', () => {
  const tasks = [T(4, { title: 'cuatro 14' }), T(14, { title: 'catorce' }), T(5, { agent: 'security', project: 'p1', status: 'failed' }), T(6, { agent: 'security', status: 'done' })];
  const ids = (f) => filterTasks(tasks, f).map((t) => t.id);
  assert.deepEqual(ids({ q: '#4' }), [4]); // el 14 no cuenta como el 4
  assert.deepEqual(ids({ q: '4' }), [4]);
  assert.deepEqual(ids({ agent: 'security' }), [5, 6]);
  assert.deepEqual(ids({ project: 'p1' }), [5]);
  assert.deepEqual(ids({ project: NO_PROJECT }), [4, 14, 6]);
  assert.deepEqual(ids({ status: 'failed' }), [5]);
  assert.deepEqual(ids({ agent: 'security', status: 'done' }), [6]);
  assert.equal(isFiltering({}), false);
  assert.equal(isFiltering({ q: ' ' }), false);
  assert.equal(isFiltering({ status: 'done' }), true);
});

// ---------- métricas ----------
test('agentMetrics: éxito, tiempo medio, costo y orden; ignora objetivos, canceladas y en curso', () => {
  const at = (s) => `2026-10-30T10:${String(s).padStart(2, '0')}:00.000Z`;
  const tasks = [
    T(1, { status: 'done', started_at: at(0), finished_at: at(2), cost_usd: 0.10 }),
    T(2, { status: 'review', started_at: at(0), finished_at: at(4), cost_usd: 0.20 }),
    T(3, { status: 'failed', started_at: at(0), finished_at: at(1), cost_usd: 0 }),
    T(4, { status: 'running', started_at: at(0) }),
    T(5, { status: 'backlog' }),
    T(6, { status: 'review', kind: 'objective', finished_at: at(5), started_at: at(0) }),
    T(7, { agent: 'tester', status: 'done', started_at: at(0), finished_at: at(1), cost_usd: 0.5 }),
    T(8, { status: 'backlog', finished_at: at(3) }), // cancelada: tuvo finished_at pero ya no cuenta
  ];
  const rows = agentMetrics(tasks);
  assert.deepEqual(rows.map((r) => r.agent), ['backend', 'tester']);
  const b = rows[0];
  assert.equal(b.tasks, 3); assert.equal(b.ok, 2); assert.equal(b.failed, 1); assert.equal(b.approved, 1);
  assert.ok(Math.abs(b.rate - 2 / 3) < 1e-9);
  assert.equal(b.avgSecs, (120 + 240 + 60) / 3);
  assert.ok(Math.abs(b.cost - 0.3) < 1e-9);
  assert.ok(Math.abs(b.avgCost - 0.1) < 1e-9);
  assert.equal(new Date(b.lastAt).toISOString(), at(4));
  assert.deepEqual(agentMetrics([]), []);
  const fmt = { fmtDur: (s) => `${s}s`, money: (n) => `$${n.toFixed(2)}` };
  assert.equal(summarize(b, fmt), '3 misión(es) · 67 % éxito · 140s de media');
  assert.match(summarize(undefined, fmt), /Sin misiones/);
});

test('agentMetrics: acepta fechas de SQLite sin zona y no revienta con fechas incoherentes', () => {
  const rows = agentMetrics([
    T(1, { status: 'done', started_at: '2026-10-30 10:00:00', finished_at: '2026-10-30 10:01:30' }),
    T(2, { status: 'done', started_at: '2026-10-30 10:05:00', finished_at: '2026-10-30 10:00:00' }), // termina antes de empezar
  ]);
  assert.equal(rows[0].tasks, 2);
  assert.equal(rows[0].avgSecs, 90); // la duración negativa se descarta
});

// ---------- exportación ----------
test('taskToMarkdown: metadatos, descripción, conversación, error y resultado', () => {
  const t = T(12, { title: 'Auditar\npermisos', description: 'linea1\nlinea2', status: 'review', agent: 'security', project: 'syspaqueteria', result: 'Sin hallazgos.', cost_usd: 0.0421, started_at: '2026-10-30T10:00:00Z', finished_at: '2026-10-30T10:03:20Z', error: null });
  const md = taskToMarkdown(t, [{ kind: 'answer', text: '¿Cuál tenant?' }, { kind: 'user', text: 'el 7' }, { kind: 'tool', text: 'Read x' }]);
  assert.match(md, /^# #12 Auditar permisos\n/); // el título queda en una línea
  assert.match(md, /- \*\*Agente:\*\* security/);
  assert.match(md, /- \*\*Duración:\*\* 3 min 20 s/);
  assert.match(md, /- \*\*Costo:\*\* \$0\.042/);
  assert.match(md, /> linea1\n> linea2/);
  assert.match(md, /\*\*Tú:\*\* el 7/);
  assert.match(md, /\*\*security:\*\* ¿Cuál tenant\?/);
  assert.doesNotMatch(md, /Read x/); // las llamadas a herramientas no van en el informe
  assert.match(md, /## Resultado\n\nSin hallazgos\./);
  assert.doesNotMatch(md, /## Error/);
  assert.match(taskToMarkdown(T(1, { status: 'failed', error: 'boom' })), /## Error\n\n```\nboom\n```[\s\S]*_Sin resultado\._/);
});

test('tasksToMarkdown: índice con tabla y una sección por misión; las barras en títulos no rompen la tabla', () => {
  const md = tasksToMarkdown([T(1, { title: 'a | b' }), T(2)], { title: 'Mi export', note: 'Filtro: x' });
  assert.match(md, /^# Mi export/);
  assert.match(md, /Filtro: x/);
  assert.match(md, /\| 1 \| backend \| por revisar \| a \\\| b \|/);
  assert.equal((md.match(/^## #\d+ /gm) ?? []).length, 2);
});

test('markdownToHtml: da formato pero JAMÁS interpreta el contenido como HTML', () => {
  const html = markdownToHtml('# Título <img src=x onerror=alert(1)>\n\n**negrita** y `cod<e>`\n\n- uno <b>\n- dos\n\n```\n<script>alert(1)</script>\n```\n\n| a | b |\n|---|---|\n| <i>1</i> | 2 |\n\n> cita <u>');
  assert.match(html, /<h1>Título &lt;img src=x onerror=alert\(1\)&gt;<\/h1>/);
  assert.match(html, /<strong>negrita<\/strong>/);
  assert.match(html, /<code>cod&lt;e&gt;<\/code>/);
  assert.match(html, /<li>uno &lt;b&gt;<\/li>/);
  assert.match(html, /<pre>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/pre>/);
  assert.match(html, /<td>&lt;i&gt;1&lt;\/i&gt;<\/td>/);
  assert.match(html, /<blockquote>cita &lt;u&gt;<\/blockquote>/);
  assert.doesNotMatch(html, /<script|<img|<b>|<i>|<u>/);
  const page = printableHtml('# Hola', 'T <x>');
  assert.match(page, /<title>T &lt;x&gt;<\/title>/);
  assert.match(page, /<h1>Hola<\/h1>/);
});
