// Archivos adjuntos a una misión: validación, almacenamiento en disco y texto que se añade al prompt.
// El nombre del archivo en disco sale de los ids (<dir>/<tarea>/<adjunto>.<ext>), nunca del nombre que manda el cliente.
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_TASK = 10;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const INLINE_FILE_CHARS = 20_000; // texto que se copia al prompt de motores que no leen archivos
const INLINE_TOTAL_CHARS = 40_000;

const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT = ['txt', 'md', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'sql', 'php', 'js', 'ts', 'css', 'html'];
export const ALLOWED = { ...IMAGES, pdf: 'application/pdf', ...Object.fromEntries(TEXT.map((e) => [e, 'text/plain'])) };

const MAGIC = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG',
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  gif: (b) => b.toString('latin1', 0, 3) === 'GIF',
  webp: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  pdf: (b) => b.toString('latin1', 0, 5) === '%PDF-',
};
MAGIC.jpeg = MAGIC.jpg;

export const isImage = (ext) => ext in IMAGES;
export const extOf = (name) => (/\.([a-z0-9]{1,12})$/i.exec(name)?.[1] ?? '').toLowerCase();

/** Nombre seguro para mostrar: sin rutas ni caracteres de control, longitud acotada. */
export function cleanName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return base.length > 100 ? base.slice(-100) : base;
}

/** Valida nombre, tamaño y contenido. Devuelve { name, ext, mime } o { error }. */
export function checkUpload(rawName, buf) {
  const name = cleanName(rawName);
  if (!name) return { error: 'Falta el nombre del archivo' };
  const ext = extOf(name);
  if (!ALLOWED[ext]) return { error: `Tipo de archivo no permitido (.${ext || '?'}). Permitidos: imágenes, PDF y texto/código` };
  if (!buf.length) return { error: 'El archivo está vacío' };
  if (buf.length > MAX_FILE_BYTES) return { error: `El archivo supera ${MAX_FILE_BYTES / 1024 / 1024} MB` };
  if (MAGIC[ext]) { if (!MAGIC[ext](buf)) return { error: `El contenido no corresponde a un .${ext}` }; }
  else if (buf.includes(0)) return { error: 'El archivo de texto contiene datos binarios' };
  return { name, ext, mime: ALLOWED[ext] };
}

export const dirFor = (root, taskId) => join(root, String(Number(taskId)));
export const fileFor = (root, att) => join(dirFor(root, att.task_id), `${Number(att.id)}.${extOf(att.name)}`);

export async function saveFile(root, att, buf) {
  await mkdir(dirFor(root, att.task_id), { recursive: true });
  await writeFile(fileFor(root, att), buf);
}
export const readStored = (root, att) => readFile(fileFor(root, att));
export const removeFile = (root, att) => rm(fileFor(root, att), { force: true });
export const removeTaskDir = (root, taskId) => rm(dirFor(root, taskId), { recursive: true, force: true });

/**
 * Texto que se añade al prompt. Claude lee los archivos con sus herramientas (por eso va la ruta);
 * Ollama y los proveedores solo reciben texto, así que se copia el contenido de los archivos de texto.
 */
export async function promptSection(root, atts, engine) {
  if (!atts.length) return '';
  const lines = ['--- Archivos adjuntos por el usuario ---'];
  if (engine === 'claude') {
    lines.push('Léelos con tus herramientas (Read) antes de responder:');
    for (const a of atts) lines.push(`- ${fileFor(root, a)} («${a.name}», ${a.mime}, ${a.size} bytes)`);
    return lines.join('\n');
  }
  let budget = INLINE_TOTAL_CHARS;
  for (const a of atts) {
    const ext = extOf(a.name);
    if (a.mime !== 'text/plain' || budget <= 0) { lines.push(`- «${a.name}» (${a.mime}): este motor no puede leer ese archivo, solo el texto de la misión.`); continue; }
    let text;
    try { text = (await readStored(root, a)).toString('utf8'); } catch { lines.push(`- «${a.name}»: no se pudo leer.`); continue; }
    const cut = text.slice(0, Math.min(INLINE_FILE_CHARS, budget));
    budget -= cut.length;
    lines.push(`### ${a.name}${cut.length < text.length ? ' (recortado)' : ''}`, '```' + ext, cut, '```');
  }
  return lines.join('\n');
}
