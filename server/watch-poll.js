// Arranque para Docker con el código montado en vivo: reinicia el servidor cuando cambia un .js de server/.
// `node --watch` no sirve aquí: Docker Desktop no pasa al contenedor los avisos de cambios de las carpetas de Windows,
// así que se comparan las fechas de modificación cada poco (sondeo).
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const EVERY_MS = 1500;

function snapshot() {
  const out = new Map();
  for (const f of readdirSync(dir, { recursive: true })) {
    if (!String(f).endsWith('.js') || String(f).endsWith('.test.js')) continue;
    try { out.set(String(f), statSync(join(dir, f)).mtimeMs); } catch { /* borrado entre listar y leer */ }
  }
  return out;
}

const changed = (a, b) => a.size !== b.size || [...a].some(([f, t]) => b.get(f) !== t);

let child = null;
function start() {
  child = spawn(process.execPath, [join(dir, 'index.js')], { stdio: 'inherit' });
  child.on('exit', (code, signal) => { if (!restarting && signal !== 'SIGTERM') console.log(`[watch] el servidor terminó (código ${code}); espero un cambio para arrancarlo`); });
}

let restarting = false;
let last = snapshot();
setInterval(() => {
  const now = snapshot();
  if (!changed(last, now)) return;
  last = now;
  console.log('[watch] cambio en server/: reinicio el servidor');
  restarting = true;
  const relaunch = () => { restarting = false; start(); };
  if (child && child.exitCode === null) { child.once('exit', relaunch); child.kill('SIGTERM'); } else relaunch();
}, EVERY_MS);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child?.kill(sig); process.exit(0); });
start();
