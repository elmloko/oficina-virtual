// Exportación de misiones a Markdown y a un documento imprimible (para «Guardar como PDF»). Puro, sin DOM.
import { parseTs } from './metrics.js';

const STATUS = { backlog: 'pendiente', queued: 'en cola', running: 'en misión', review: 'por revisar', done: 'completada', failed: 'fallida' };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fmtSecs = (s) => { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };
const when = (ts) => (ts ? parseTs(ts).toLocaleString('es') : '');

function metaLines(t) {
  const secs = t.started_at && t.finished_at ? (parseTs(t.finished_at) - parseTs(t.started_at)) / 1000 : null;
  return [
    ['Agente', t.kind === 'objective' ? 'coordinador' : t.agent],
    ['Proyecto', t.project || 'sin proyecto'],
    ['Motor', `${t.engine}${t.model ? ':' + t.model : ''} · ${t.mode === 'edit' ? 'puede editar' : 'solo lectura'}`],
    ['Estado', STATUS[t.status] ?? t.status],
    ['Duración', secs != null && Number.isFinite(secs) ? fmtSecs(secs) : ''],
    ['Costo', t.cost_usd ? `$${t.cost_usd.toFixed(3)}` : ''],
    ['Terminó', when(t.finished_at)],
    ['Rama', t.branch ?? ''],
  ].filter(([, v]) => v);
}

/** Una misión en Markdown: metadatos, descripción, conversación (si la hubo) y resultado. */
export function taskToMarkdown(t, events = [], { level = 1 } = {}) {
  const h = (n) => '#'.repeat(Math.min(6, level + n - 1));
  const out = [`${h(1)} #${t.id} ${oneLine(t.title)}`, '', ...metaLines(t).map(([k, v]) => `- **${k}:** ${oneLine(v)}`)];
  if (t.description?.trim()) out.push('', `${h(2)} Descripción`, '', ...t.description.trim().split('\n').map((l) => `> ${l}`));
  const thread = events.filter((e) => e.kind === 'user' || e.kind === 'answer');
  if (thread.length) {
    out.push('', `${h(2)} Conversación`, '');
    for (const e of thread) out.push(e.kind === 'user' ? `**Tú:** ${e.text.trim()}` : `**${t.agent}:** ${e.text.trim()}`, '');
  }
  if (t.error) out.push('', `${h(2)} Error`, '', '```', t.error, '```');
  out.push('', `${h(2)} Resultado`, '', t.result?.trim() || '_Sin resultado._', '');
  return out.join('\n');
}

/** Varias misiones en un solo documento, con un índice al principio. */
export function tasksToMarkdown(tasks, { title = 'Misiones', note = '' } = {}) {
  const out = [`# ${oneLine(title)}`, ''];
  if (note) out.push(note, '');
  out.push(`${tasks.length} misión(es)`, '', '| # | Agente | Estado | Título |', '|---|---|---|---|');
  for (const t of tasks) out.push(`| ${t.id} | ${t.agent} | ${STATUS[t.status] ?? t.status} | ${oneLine(t.title).replace(/\|/g, '\\|')} |`);
  out.push('');
  for (const t of tasks) out.push('---', '', taskToMarkdown(t, [], { level: 2 }));
  return out.join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_/g, '<em>$1</em>');

/** Conversor mínimo de Markdown a HTML. Escapa TODO el texto antes de dar formato: el contenido nunca se interpreta como HTML. */
export function markdownToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
    } else if (/^#{1,6} /.test(line)) {
      const n = line.match(/^#+/)[0].length;
      out.push(`<h${n}>${inline(line.slice(n + 1))}</h${n}>`); i++;
    } else if (/^---+$/.test(line)) { out.push('<hr>'); i++; }
    else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const [head, , ...body] = rows;
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) items.push(lines[i++].slice(2));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (line.startsWith('> ')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('> ')) q.push(lines[i++].slice(2));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
    } else if (!line.trim()) i++;
    else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6} |```|---+$|\||[-*] |> )/.test(lines[i])) p.push(lines[i++]);
      out.push(`<p>${p.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** Documento HTML autocontenido y listo para imprimir (el usuario elige «Guardar como PDF»). */
export function printableHtml(md, title) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111}
h1{font-size:22px}h2{font-size:17px;border-bottom:1px solid #ccc;padding-bottom:2px;margin-top:20px}
pre{background:#f4f4f4;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #bbb;color:#444}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left}
code{background:#eee;padding:0 3px}hr{margin:24px 0;border:0;border-top:1px solid #ccc}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}pre,blockquote{break-inside:avoid}}
</style></head><body>${markdownToHtml(md)}</body></html>`;
}
