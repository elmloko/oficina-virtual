// Markdown de los resultados: lógica pura (sin DOM) para poder probarla en Node.
// Entiende títulos, listas (anidadas y con líneas de continuación), tablas, bloques de código, separadores
// y, dentro del texto, **negrita**, *cursiva* y `código`. Lo demás se deja como texto tal cual.
// Nunca produce HTML: devuelve estructuras que app.js convierte en nodos con textContent.

const SEP_CELL = /^\s*:?-+:?\s*$/;
const FENCE = /^\s*(```+|~~~+)(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MAX_DEPTH = 8; // listas anidadas más allá de esto se quedan como texto

const indentOf = (line) => line.match(/^ */)[0].length;
const blank = (line) => line.trim() === '';

/** Divide una fila `| a | b |` en celdas. Respeta `\|` y las barras dentro de `código`. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isRow = (line) => line.includes('|') && !blank(line);
const isSeparator = (line) => line.includes('-') && line.includes('|') && splitRow(line).every((c) => SEP_CELL.test(c));
const alignOf = (c) => { const t = c.trim(); return t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : null; };

/**
 * Convierte el texto en bloques:
 *   { type: 'heading', level, text } · { type: 'text', text } · { type: 'code', lang, text } · { type: 'rule' }
 *   { type: 'table', header, align, rows } · { type: 'list', ordered, start, items: [{ blocks }] }
 */
export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    ')));
  return blocksOf(lines, 0);
}

function blocksOf(lines, depth) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ type: 'text', text: para.join('\n') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) { flush(); continue; }
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const mark = fence[1];
      const ind = indentOf(line);
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].trim().startsWith(mark); j++) body.push(lines[j].slice(Math.min(ind, indentOf(lines[j]))));
      out.push({ type: 'code', lang: fence[2].trim(), text: body.join('\n') });
      i = j; // sin cierre: el bloque llega hasta el final
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const cols = header.length; // como en GFM: manda la cabecera; las celdas de más se ignoran
      const pad = (r) => [...r, ...Array(Math.max(0, cols - r.length)).fill('')].slice(0, cols);
      const align = pad(splitRow(lines[i + 1]).map(alignOf)).map((a) => a || null);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && isRow(lines[j]); j++) rows.push(pad(splitRow(lines[j])));
      out.push({ type: 'table', header, align, rows });
      i = j - 1;
      continue;
    }
    const h = line.match(HEADING);
    if (h) { flush(); out.push({ type: 'heading', level: h[1].length, text: h[2] }); continue; }
    if (RULE.test(line)) { flush(); out.push({ type: 'rule' }); continue; }
    if (depth < MAX_DEPTH && ITEM.test(line)) {
      flush();
      const r = parseList(lines, i, depth);
      out.push(r.block);
      i = r.next - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** Una lista empieza en `start`. Cada elemento se lleva las líneas con más sangría que su viñeta (continuación o sublista). */
function parseList(lines, start, depth) {
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(lines[start].match(ITEM)[2]);
  const block = { type: 'list', ordered, start: ordered ? parseInt(lines[start].match(ITEM)[2], 10) : 1, items: [] };
  const sameLevel = (line) => {
    const m = line?.match(ITEM);
    return !!m && !RULE.test(line) && Math.abs(indentOf(line) - base) <= 1 && /\d/.test(m[2]) === ordered;
  };
  let i = start;
  while (i < lines.length && sameLevel(lines[i])) {
    const m = lines[i].match(ITEM);
    const col = lines[i].length - m[3].length; // columna donde empieza el texto: la continuación se alinea ahí
    const body = [m[3]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (blank(lines[j])) {
        let k = j;
        while (k < lines.length && blank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]) > base + 1) { body.push(''); continue; }
        break;
      }
      if (indentOf(lines[j]) <= base + 1) break;
      body.push(lines[j].slice(Math.min(col, indentOf(lines[j]))));
    }
    block.items.push({ blocks: blocksOf(body, depth + 1) });
    let k = j; // líneas en blanco entre elementos de la misma lista no la cortan
    while (k < lines.length && blank(lines[k])) k++;
    i = k > j && sameLevel(lines[k]) ? k : j;
  }
  return { block, next: i };
}

/**
 * Formato dentro de un texto: [{ t: 'text' | 'code', v } | { t: 'b' | 'i', kids }].
 * La negrita y la cursiva pueden contener `código`. Lo que no cierra se deja como texto (2*3, snake_case…).
 */
export function inlineTokens(s) {
  s = String(s ?? '');
  const out = [];
  const re = /`([^`\n]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])|(?<![_\w])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![_\w])/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1] != null) out.push({ t: 'code', v: m[1] });
    else if (m[2] != null || m[3] != null) out.push({ t: 'b', kids: inlineTokens(m[2] ?? m[3]) });
    else out.push({ t: 'i', kids: inlineTokens(m[4] ?? m[5]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}
