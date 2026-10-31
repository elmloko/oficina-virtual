// Espacio de trabajo en «Documentos»: cada misión que guarda archivos lo hace en una carpeta NUEVA con el nombre de su tema.
import { mkdirSync, existsSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const NAME_MAX = 60;

/** Nombre de carpeta válido en Windows a partir del título de la misión. */
export function topicName(title) {
  let n = String(title ?? '').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).replace(/[\s.]+$/g, '');
  if (!n || RESERVED.test(n.split('.')[0])) n = n ? `Tema ${n}` : 'Tema';
  return n;
}

/** ¿`path` está estrictamente dentro de `base`? (no vale la propia base ni escapar con ..). */
export const insideBase = (path, base) => {
  const p = resolve(path); const b = resolve(base);
  return p !== b && p.toLowerCase().startsWith((b + sep).toLowerCase());
};

/** Crea `base/<tema>`; si ya existe una carpeta con ese nombre añade (2), (3)… Nunca reutiliza una existente. */
export function createTopicFolder(base, title) {
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error('La carpeta Documentos no existe');
  const name = topicName(title);
  for (let i = 1; i <= 99; i++) {
    const dir = join(base, i === 1 ? name : `${name} (${i})`);
    if (!insideBase(dir, base)) throw new Error('Nombre de carpeta no válido');
    try { mkdirSync(dir); return dir; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('Demasiadas carpetas con el mismo nombre');
}

/** Archivos guardados en la carpeta (hasta 3 niveles), rutas relativas. */
export function listFiles(dir, { max = 25 } = {}) {
  const out = [];
  let total = 0;
  const walk = (d, depth) => {
    let items = [];
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = join(d, it.name);
      if (it.isDirectory()) { if (depth < 3) walk(full, depth + 1); } else { total++; if (out.length < max) out.push(full.slice(dir.length + 1).replaceAll('\\', '/')); }
    }
  };
  walk(dir, 1);
  return { files: out, total };
}

/** Quita la carpeta solo si quedó vacía (rmdir nunca borra contenido). */
export function removeIfEmpty(dir) {
  try { rmdirSync(dir); return true; } catch { return false; }
}
