// Bóveda de secretos: tokens y contraseñas que el agente puede USAR sin VERLOS.
// - Viven solo en este equipo (.env, codificados, igual que las contraseñas de servidores) como VAULT_<NOMBRE>.
// - El agente escribe {{secreto:NOMBRE}} en sus comandos; la oficina pone el valor justo al ejecutar (por stdin del SSH,
//   nunca en la línea de comandos), así que no queda en el registro, en la pantalla de aprobación ni en el modelo.
// - Si un valor guardado aparece en una salida, se tapa con su marcador antes de que lo vea el modelo.
import { setEnvVar } from './envfile.js';
import { encodePass, decodePass } from './infra.js';

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
export const PLACEHOLDER_RE = /\{\{secreto:([A-Z][A-Z0-9_]{1,47})\}\}/g;
export const placeholder = (name) => `{{secreto:${name}}}`;
export const vaultVar = (name) => `VAULT_${name}`;
const MAX_SECRET = 220; // codificado en base64 cabe en el límite de 300 del .env
const MIN_MASK = 4;     // valores más cortos no se tapan en las salidas (taparían texto normal)

/** Nombres que suenan a secreto: lo que el usuario escribe como NOMBRE=valor con ellos se guarda en la bóveda. */
const SECRET_KEY_RE = /(TOKEN|PASSWORD|PASSWD|PASS|PWD|SECRET|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLAVE|CONTRASENA|CREDENTIAL)/;

export function validateSecret(name, value) {
  if (!SECRET_NAME_RE.test(name ?? '')) return 'Nombre inválido: MAYÚSCULAS, números y _ (p. ej. SITRA_IPS_TOKEN)';
  if (typeof value !== 'string' || !value.length) return 'Falta el valor';
  if (value.length > MAX_SECRET) return `Demasiado largo (máx. ${MAX_SECRET} caracteres)`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'El valor no puede tener saltos de línea ni caracteres de control';
  return null;
}

/**
 * Sustituye {{secreto:X}} por el valor, escapado según dónde esté (sin comillas, entre '…' o entre "…"),
 * para que el valor sea siempre texto y nunca pueda romper las comillas ni inyectar órdenes.
 */
export function expandCommand(command, get) {
  const missing = new Set(); const used = new Set();
  let out = ''; let quote = null;
  for (let i = 0; i < command.length; i++) {
    PLACEHOLDER_RE.lastIndex = i;
    const m = command.startsWith('{{secreto:', i) ? PLACEHOLDER_RE.exec(command) : null;
    if (m && m.index === i) {
      const value = get(m[1]);
      if (value == null) missing.add(m[1]);
      else {
        used.add(m[1]);
        out += quote === "'" ? value.replace(/'/g, "'\\''")
          : quote === '"' ? value.replace(/[\\$`"]/g, '\\$&')
            : `'${value.replace(/'/g, "'\\''")}'`;
      }
      i += m[0].length - 1;
      continue;
    }
    const c = command[i];
    if (quote === '"' && c === '\\') { out += c + (command[i + 1] ?? ''); i++; continue; }
    if (!quote && c === '\\') { out += c + (command[i + 1] ?? ''); i++; continue; }
    if (quote ? c === quote : c === "'" || c === '"') quote = quote ? null : c;
    out += c;
  }
  return { script: out, missing: [...missing], used: [...used] };
}

export function createVault({ envFile, env = process.env, setVar = setEnvVar } = {}) {
  const names = () => Object.keys(env).filter((k) => k.startsWith('VAULT_') && decodePass(env[k]) !== null).map((k) => k.slice(6)).filter((n) => SECRET_NAME_RE.test(n)).sort();
  const get = (name) => (SECRET_NAME_RE.test(name ?? '') ? decodePass(env[vaultVar(name)]) : null);
  function set(name, value) {
    const err = validateSecret(name, value);
    if (err) throw new Error(err);
    const v = encodePass(value);
    setVar(envFile, vaultVar(name), v); env[vaultVar(name)] = v;
  }
  function remove(name) {
    if (!SECRET_NAME_RE.test(name ?? '')) throw new Error('Nombre inválido');
    setVar(envFile, vaultVar(name), null); delete env[vaultVar(name)];
  }
  /** Tapa en un texto cualquier valor guardado (los más largos primero, por si uno contiene a otro). */
  function mask(text) {
    if (!text) return text;
    let s = String(text);
    const all = names().map((n) => [n, get(n)]).filter(([, v]) => v && v.length >= MIN_MASK).sort((a, b) => b[1].length - a[1].length);
    for (const [n, v] of all) if (s.includes(v)) s = s.split(v).join(placeholder(n));
    return s;
  }
  /**
   * Lo que escribe el usuario: las líneas NOMBRE_TOKEN=valor (o PASSWORD, SECRET, API_KEY…) se guardan en la bóveda
   * y en el texto queda NOMBRE_TOKEN={{secreto:NOMBRE_TOKEN}}. Devuelve el texto limpio y los nombres guardados.
   */
  function capture(text) {
    const saved = [];
    const clean = String(text ?? '').replace(/^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]{1,47})[ \t]*=[ \t]*(.*?)[ \t]*$/gm, (line, pre, name, raw) => {
      if (!SECRET_KEY_RE.test(name)) return line;
      const value = raw.replace(/^(["'])(.*)\1$/, '$2');
      if (!value || /^\{\{secreto:/.test(value) || /^<.*>$/.test(value) || validateSecret(name, value)) return line;
      set(name, value); saved.push({ name, value });
      return `${pre}${name}=${placeholder(name)}`;
    });
    return { text: mask(clean), saved };
  }
  return { names, get, set, remove, mask, capture, expand: (cmd) => expandCommand(cmd, get) };
}
