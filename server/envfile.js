import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

/** Una clave solo puede tener caracteres imprimibles ASCII sin espacios (evita inyectar líneas en el .env). */
export const KEY_RE = /^[\x21-\x7E]{8,300}$/;
export const VAR_RE = /^[A-Z][A-Z0-9_]{2,60}$/;

/**
 * Pone (o quita, si value es null) NAME=valor en un archivo .env conservando el resto de líneas y comentarios.
 * Escritura atómica (archivo temporal + rename).
 */
export function setEnvVar(file, name, value) {
  if (!VAR_RE.test(name)) throw new Error('Nombre de variable inválido');
  if (value !== null && !KEY_RE.test(value)) throw new Error('Valor inválido (8-300 caracteres imprimibles, sin espacios)');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  if (value === null) { if (idx >= 0) lines.splice(idx, 1); } else if (idx >= 0) lines[idx] = `${name}=${value}`;
  else {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(`${name}=${value}`, '');
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  renameSync(tmp, file);
}
