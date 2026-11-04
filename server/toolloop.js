// Bucle de herramientas para los motores que solo chatean (Ollama, LM Studio, proveedores en internet).
// El modelo pide UNA acción por respuesta en un bloque ```accion {json}```; la oficina la ejecuta con las mismas
// reglas que a Claude Code (carpeta permitida, guard contra lo catastrófico, aprobación de lo fuerte en servidores)
// y le devuelve el resultado. Cuando responde sin bloque de acción, esa es su respuesta final.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const MAX_STEPS = 40;
const OUT_LIMIT = 12_000; // lo que se le devuelve al modelo de cada acción
const READ_LIMIT = 40_000;
const CMD_TIMEOUT = 10 * 60_000;

/** Lo catastrófico nunca se ejecuta (mismas reglas que el hook guard de Claude Code). */
const BLOCKED = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)[a-z]*\s+("|')?(\/|~|\$HOME|[a-z]:|\/[a-z])[\\/]?("|')?(\s|$|\*)/i, why: 'borrado recursivo de la raíz, un disco o el home' },
  { re: /\bRemove-Item\b(?=.*-Recurse)(?=.*\s("|')?([a-z]:\\?|~[\\/]?|\$HOME|\$env:USERPROFILE)("|')?(\s|$))/i, why: 'borrado recursivo de un disco o del perfil de usuario' },
  { re: /\b(rd|rmdir)\s+\/s\b.*\s[a-z]:\\?(\s|$)/i, why: 'borrado recursivo de un disco' },
  { re: /\bdel\s+\/[sq].*\s[a-z]:\\(\*|\s|$)/i, why: 'borrado masivo de un disco' },
  { re: /\b(format(-volume)?|mkfs(\.\w+)?|diskpart|clear-disk)\b\s/i, why: 'formateo de disco' },
  { re: /\bdd\s+.*of=\/dev\//i, why: 'escritura directa a un dispositivo' },
  { re: /\bgit\s+push\b.*(\s--force(?!-with-lease)\b|\s-f\b).*\b(main|master)\b/i, why: 'push --force a main/master' },
  { re: /\bgit\s+push\b.*\b(main|master)\b.*(\s--force(?!-with-lease)\b|\s-f\b)/i, why: 'push --force a main/master' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, why: 'ejecutar un script descargado sin revisarlo' },
  { re: /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i, why: 'ejecutar un script descargado sin revisarlo' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork bomb' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/i, why: 'permisos 777 sobre la raíz' },
  { re: /\b(shutdown|Stop-Computer|Restart-Computer)\b/i, why: 'apagar o reiniciar el equipo' },
  { re: /\b(Set-MpPreference\b.*-Disable|netsh\s+advfirewall\s+set\b.*\boff\b)/i, why: 'desactivar el antivirus o el firewall' },
];
export const guardReason = (command) => BLOCKED.find((r) => r.re.test(String(command)))?.why ?? null;

// Bloques de acción: ```accion``` (lo pedido) o ```json``` / sin etiqueta con "herramienta" (lo que suelen escribir los modelos pequeños).
const BLOCK_RE = /```[ \t]*(accion|acción|action|json)?[ \t]*\r?\n([\s\S]*?)```/gi;
const isActionBlock = (m) => /^(accion|acción|action)$/i.test(m[1] ?? '') || /"herramienta"\s*:/.test(m[2]);
export const stripActions = (text) => String(text).replace(BLOCK_RE, (...m) => (isActionBlock(m) ? '' : m[0])).trim();

/** Interpreta la PRIMERA acción de la respuesta (una por turno: lo que venga después lo inventó sin ver el resultado). null = respuesta final. */
export function parseAction(text) {
  const blocks = [...String(text).matchAll(BLOCK_RE)].filter(isActionBlock);
  if (!blocks.length) return null;
  const extra = blocks.length > 1;
  try {
    const a = JSON.parse(blocks[0][2].trim());
    if (!a || typeof a !== 'object' || typeof a.herramienta !== 'string') return { error: 'Falta "herramienta" en la acción.' };
    return extra ? { ...a, extra } : a;
  } catch (e) { return { error: `La acción no es JSON válido (${e.message}). Escapa los saltos de línea como \\n y las comillas como \\".` }; }
}

const cut = (s, n = OUT_LIMIT) => (s.length > n ? `${s.slice(0, n)}\n[… recortado: ${s.length - n} caracteres más]` : s);

/** Qué herramientas tiene cada modo y cómo pedirlas (va en el prompt del modelo). */
export function toolsPrompt(mode, root) {
  const tools = [
    '- {"herramienta":"listar","ruta":"carpeta"} → lista archivos y carpetas.',
    '- {"herramienta":"leer","ruta":"archivo"} → devuelve el contenido.',
    '- {"herramienta":"buscar","ruta":"carpeta","texto":"palabra"} → archivos y líneas que contienen ese texto.',
    '- {"herramienta":"escribir","ruta":"archivo","contenido":"texto completo"} → crea o reemplaza el archivo entero.',
    '- {"herramienta":"reemplazar","ruta":"archivo","buscar":"texto exacto","poner":"texto nuevo"} → cambia un trozo (el texto a buscar debe aparecer una sola vez).',
  ];
  if (mode === 'full') tools.push(`- {"herramienta":"comando","comando":"…"} → ejecuta un comando en ${process.platform === 'win32' ? 'PowerShell' : 'la shell'} de este equipo y devuelve su salida.`);
  if (mode === 'infra') {
    tools.length = 0;
    tools.push('- {"herramienta":"comando","comando":"…"} → ejecuta UN comando en el servidor por SSH (la oficina te pregunta al usuario si es fuerte).',
      '- {"herramienta":"comando","comando":"…","salida":"solo_usuario"} → la salida la ve solo el usuario (tú recibes un aviso).',
      '- {"herramienta":"comando","comando":"…","salida":"guardar_secreto","nombre":"NOMBRE"} → guarda la salida como {{secreto:NOMBRE}} sin verla.');
  }
  const where = mode === 'infra' ? '' : `Carpeta de trabajo: ${root}. Las rutas relativas parten de ahí${mode === 'edit' ? ' y no puedes salir de ella' : '; puedes usar rutas absolutas en cualquier otra'}.\n`;
  return ['--- Herramientas (la oficina las ejecuta por ti) ---',
    'Para actuar, termina tu respuesta con UN bloque así (JSON válido, una sola acción):',
    '```accion', '{"herramienta":"leer","ruta":"README.md"}', '```',
    'Después del bloque DETENTE: la oficina ejecuta la acción y te devuelve el resultado en el siguiente mensaje; entonces pides la siguiente. Nunca pongas dos acciones en la misma respuesta. Herramientas:',
    ...tools,
    where + 'Trabaja paso a paso: mira antes de cambiar, verifica después. NO inventes resultados: espera la respuesta de cada acción.',
    'Cuando termines, responde SIN bloque de acción: ese texto es tu respuesta final para el usuario (resume qué hiciste y qué comprobaste).'].join('\n');
}

/**
 * Ejecutor de acciones locales (archivos y comandos de este equipo).
 * mode 'edit': solo archivos y solo dentro de `root`. mode 'full': archivos en cualquier sitio y comandos (con guard).
 */
export function localTools({ mode, root, env = process.env, spawnFn = spawn, onKill = () => {} }) {
  const base = resolve(root);
  const pathOf = (p) => {
    if (typeof p !== 'string' || !p.trim()) throw new Error('Falta "ruta".');
    const full = resolve(base, p.trim().replace(/^~(?=[\\/]|$)/, homedir()));
    if (mode === 'edit') {
      const rel = relative(base, full);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Fuera del proyecto: ${p}. Solo puedes trabajar dentro de ${base}.`);
      if (/(^|[\\/])\.git([\\/]|$)/.test(rel)) throw new Error('La carpeta .git no se toca.');
    }
    return full;
  };

  async function search(dir, text, out = [], depth = 0) {
    if (out.length >= 100 || depth > 8) return out;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['node_modules', '.git', 'vendor'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await search(p, text, out, depth + 1);
      else {
        const st = await stat(p).catch(() => null);
        if (!st || st.size > 1_000_000) continue;
        const lines = (await readFile(p, 'utf8').catch(() => '')).split('\n');
        lines.forEach((l, i) => { if (out.length < 100 && l.includes(text)) out.push(`${relative(base, p)}:${i + 1}: ${l.trim().slice(0, 200)}`); });
      }
    }
    return out;
  }

  function run(command) {
    const why = guardReason(command);
    if (why) return Promise.resolve(`✕ Bloqueado (${why}). No intentes rodearlo: explícale al usuario qué querías hacer y que lo haga él si hace falta.`);
    const [bin, args] = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['sh', ['-c', command]];
    return new Promise((done) => {
      const child = spawnFn(bin, args, { cwd: base, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { out += '\n✕ Superó el tiempo máximo (10 min) y se canceló.'; child.kill(); }, CMD_TIMEOUT);
      onKill(() => child.kill());
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', (e) => { clearTimeout(timer); done(`✕ No se pudo ejecutar: ${e.message}`); });
      child.on('close', (code) => { clearTimeout(timer); done(`${out.trim() || '(sin salida)'}\n[código de salida: ${code}]`); });
    });
  }

  return async function exec(a) {
    switch (a.herramienta) {
      case 'listar': {
        const dir = pathOf(a.ruta || '.');
        const items = await readdir(dir, { withFileTypes: true });
        return items.slice(0, 300).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(carpeta vacía)';
      }
      case 'leer': {
        const p = pathOf(a.ruta);
        return cut(await readFile(p, 'utf8'), READ_LIMIT);
      }
      case 'buscar': {
        if (typeof a.texto !== 'string' || !a.texto) throw new Error('Falta "texto".');
        const hits = await search(pathOf(a.ruta || '.'), a.texto);
        return hits.join('\n') || 'Sin coincidencias.';
      }
      case 'escribir': {
        if (typeof a.contenido !== 'string') throw new Error('Falta "contenido" (texto).');
        const p = pathOf(a.ruta);
        const existed = existsSync(p);
        if (existed && mode === 'full') await copyFile(p, `${p}.bak`); // copia antes de cambiar algo que ya existía
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, a.contenido, 'utf8');
        return `✓ ${existed ? 'Reemplazado' : 'Creado'}: ${p} (${a.contenido.length} caracteres)${existed && mode === 'full' ? ` · copia en ${p}.bak` : ''}`;
      }
      case 'reemplazar': {
        if (typeof a.buscar !== 'string' || !a.buscar || typeof a.poner !== 'string') throw new Error('Faltan "buscar" y "poner" (texto).');
        const p = pathOf(a.ruta);
        const text = await readFile(p, 'utf8');
        const n = text.split(a.buscar).length - 1;
        if (n !== 1) throw new Error(n ? `El texto aparece ${n} veces: incluye más contexto para que sea único.` : 'No se encontró ese texto exacto (lee el archivo y copia el trozo tal cual).');
        await writeFile(p, text.replace(a.buscar, () => a.poner), 'utf8');
        return `✓ Cambiado en ${p}`;
      }
      case 'comando':
        if (mode !== 'full') throw new Error('En este modo no puedes ejecutar comandos: solo leer y editar archivos.');
        if (typeof a.comando !== 'string' || !a.comando.trim()) throw new Error('Falta "comando".');
        return cut(await run(a.comando));
      default: throw new Error(`Herramienta desconocida: ${a.herramienta}`);
    }
  };
}

/** Ejecutor del modo servidor: cada comando pasa por /api/infra/exec (clasificación, aprobaciones, secretos), igual que con Claude Code. */
export function infraTools({ url, taskId, token, fetchFn = fetch }) {
  return async function exec(a) {
    if (a.herramienta !== 'comando') throw new Error('En un servidor solo existe la herramienta "comando".');
    if (typeof a.comando !== 'string' || !a.comando.trim()) throw new Error('Falta "comando".');
    const output = a.salida === 'solo_usuario' ? 'user' : a.salida === 'guardar_secreto' ? 'secret' : 'agent';
    const res = await fetchFn(`${url}/api/infra/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, token, command: a.comando, output, secret_name: output === 'secret' ? a.nombre : null }),
      signal: AbortSignal.timeout(20 * 60_000), // incluye lo que tarde el usuario en aprobar
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error ?? `Error ${res.status}`);
    if (r.denied) return `✕ EL USUARIO RECHAZÓ ESTE COMANDO${r.note ? ` (${r.note})` : ''}. No lo reintentes ni lo disimules: propón otra alternativa o termina.`;
    return cut([r.stdout?.replace(/\n$/, ''), r.stderr?.replace(/\n$/, ''), r.note ? `ℹ ${r.note}` : '', r.timedOut ? '✕ Superó el tiempo máximo y se canceló.' : '', `[código de salida: ${r.code}]`].filter(Boolean).join('\n'));
  };
}

/**
 * Conversa con el modelo hasta que dé su respuesta final.
 * send(messages) → texto del modelo; exec(acción) → resultado en texto; log(kind, text) para el registro.
 */
export async function runToolLoop({ system, prompt, send, exec, log = () => {}, isCancelled = () => false, maxSteps = MAX_STEPS }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  for (let step = 0; step < maxSteps; step++) {
    if (isCancelled()) throw new Error('Cancelada');
    const text = await send(messages);
    messages.push({ role: 'assistant', content: text });
    const action = parseAction(text);
    if (!action) { log('text', text); return text; }
    const said = stripActions(text);
    if (said) log('text', said);
    let result;
    if (action.error) result = `✕ ${action.error}`;
    else {
      log('tool', `${action.herramienta} ${String(action.ruta ?? action.comando ?? '').slice(0, 300)}`);
      try { result = await exec(action); } catch (e) { result = `✕ ${e.message}`; }
      if (action.extra) result += '\n\n⚠ Solo se ejecutó tu PRIMERA acción. Pide una sola por respuesta y espera su resultado antes de la siguiente; no inventes resultados.';
    }
    if (isCancelled()) throw new Error('Cancelada');
    messages.push({ role: 'user', content: `Resultado de la acción:\n${result}\n\nSigue con la siguiente acción, o responde sin bloque de acción si ya terminaste.` });
  }
  const last = 'Se alcanzó el máximo de pasos sin una respuesta final. Revisa el registro para ver lo que alcanzó a hacer.';
  log('error', last);
  throw new Error(last);
}
