#!/usr/bin/env node
// Herramienta que usa el agente en modo infraestructura: envía UN comando a la oficina, que decide si lo ejecuta
// directamente (solo lectura) o te lo pregunta (algo fuerte) y lo corre por SSH con tus llaves.
// Uso: node infra-exec.mjs "<comando>"   (variables que fija la oficina: OFICINA_URL, OFICINA_TASK, OFICINA_TOKEN)
const command = process.argv.slice(2).join(' ').trim();
const { OFICINA_URL: url, OFICINA_TASK: task, OFICINA_TOKEN: token } = process.env;
if (!command) { console.error('Falta el comando. Uso: node infra-exec.mjs "<comando>"'); process.exit(2); }
if (!url || !task || !token) { console.error('Esta herramienta solo funciona dentro de una misión en modo infraestructura de la oficina.'); process.exit(2); }

try {
  const res = await fetch(`${url}/api/infra/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: Number(task), token, command }),
    signal: AbortSignal.timeout(20 * 60_000), // incluye el tiempo que tarde el usuario en aprobar
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`✕ ${r.error ?? `Error ${res.status}`}`); process.exit(res.status === 403 ? 3 : 1); }
  if (r.denied) { console.log(`✕ EL USUARIO RECHAZÓ ESTE COMANDO${r.note ? ` (${r.note})` : ''}. No lo reintentes ni lo disimules: propón otra alternativa o termina.`); process.exit(3); }
  if (r.stdout) console.log(r.stdout.replace(/\n$/, ''));
  if (r.stderr) console.error(r.stderr.replace(/\n$/, ''));
  if (r.timedOut) console.error('✕ El comando superó el tiempo máximo y se canceló.');
  process.exit(r.code === 0 ? 0 : (r.code ?? 1) < 0 ? 1 : r.code);
} catch (e) {
  console.error(`✕ No se pudo contactar con la oficina: ${e.message}`);
  process.exit(1);
}
