// Modo infraestructura: el agente puede operar un servidor por SSH, pero todo pasa por aquí.
// - classify(): decide si un comando es de lectura, un cambio leve o algo fuerte.
// - needsApproval(): lo fuerte siempre te lo pregunta; los cambios leves solo corren solos fuera de producción.
// - runSsh(): ejecuta con tus llaves SSH (BatchMode: nunca pide ni guarda contraseñas) y sin shell local.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from 'ssh2';

/** Variable de .env donde vive la contraseña de un servidor (codificada en base64; nunca llega al modelo ni a la web). */
export const passVar = (name) => `SERVER_PASS_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
export const encodePass = (pw) => `b64:${Buffer.from(pw, 'utf8').toString('base64')}`;
export const decodePass = (v) => (typeof v === 'string' && v.startsWith('b64:') ? Buffer.from(v.slice(4), 'base64').toString('utf8') : null);
const fingerprint = (key) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

const MAX_CMD = 2000;
const OUT_CAP = 30_000;
export const SSH_TIMEOUT_MS = 120_000;

/** Patrones que delatan algo destructivo o difícil de revertir: se marcan en rojo al pedirte permiso. */
const DANGER = [
  /(^|[\s;&|])(rm|rmdir|shred|dd|mkfs\S*|fdisk|parted|wipefs|truncate)(\s|$)/,
  /(^|[\s;&|])(shutdown|reboot|halt|poweroff|init|telinit)(\s|$)/,
  /(^|[\s;&|])(kill|killall|pkill)(\s|$)/,
  /(^|[\s;&|])(userdel|groupdel|passwd|usermod|deluser|chpasswd)(\s|$)/,
  /(^|[\s;&|])(iptables|ip6tables|nft|ufw|firewall-cmd)(\s|$)(?!.*(-L|-S|status|--list))/,
  /(^|[\s;&|])(chmod|chown|chgrp)\s+.*-\w*R/,
  /\bcrontab\s+-r\b/,
  /\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b/i,
  /\bgit\s+(push\s+.*(--force|-f)\b|reset\s+--hard|clean\s+-\w*f)/,
  /\b(terraform|tofu)\s+(apply|destroy)\b|\bkubectl\s+(delete|drain|cordon)\b|\bhelm\s+(uninstall|delete)\b/,
  /\bdocker\s+(rm|rmi|kill|stop|system\s+prune|volume\s+rm|network\s+rm|compose\s+down)\b|\bdocker\s+\w+\s+prune\b/,
  /\b(apt(-get)?|yum|dnf|apk|pacman)\s+(remove|purge|autoremove|upgrade|dist-upgrade|install|erase)\b/,
  /\bsystemctl\s+(stop|disable|mask|restart|kill|isolate|poweroff|reboot)\b/,
  />\s*\/dev\/(sd|nvme|vd)|:\(\)\s*\{/,
  /\b(mv|cp)\b.*\s\/(etc|boot|bin|sbin|usr|lib|var|root)(\/|\s|$)/,
];

const LOG_SUBCMD = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'show', 'cat', 'list-dependencies']);
const has = (t, ...flags) => t.some((x) => flags.includes(x) || flags.some((f) => f.length > 2 && x.startsWith(`${f}=`)));
const sub = (t) => t.slice(1).find((x) => !x.startsWith('-'));

/** Cada comando conocido devuelve 'read' | 'mild' | 'strong'. Lo que no está aquí es 'strong'. */
const RULES = {
  ls: () => 'read', cat: () => 'read', head: () => 'read', tail: () => 'read', grep: () => 'read', egrep: () => 'read', zgrep: () => 'read', zcat: () => 'read',
  wc: () => 'read', sort: () => 'read', uniq: () => 'read', cut: () => 'read', tr: () => 'read', nl: () => 'read', column: () => 'read', diff: () => 'read',
  df: () => 'read', du: () => 'read', free: () => 'read', uptime: () => 'read', ps: () => 'read', pstree: () => 'read', vmstat: () => 'read', iostat: () => 'read',
  lsblk: () => 'read', findmnt: () => 'read', uname: () => 'read', hostname: () => 'read', hostnamectl: (t) => (t.length === 1 || sub(t) === 'status' ? 'read' : 'strong'),
  whoami: () => 'read', id: () => 'read', date: (t) => (has(t, '-s', '--set') ? 'strong' : 'read'), pwd: () => 'read', cd: () => 'read', echo: () => 'read', printf: () => 'read',
  stat: () => 'read', file: () => 'read', which: () => 'read', whereis: () => 'read', type: () => 'read', realpath: () => 'read', basename: () => 'read', dirname: () => 'read',
  md5sum: () => 'read', sha256sum: () => 'read', sha1sum: () => 'read', tree: () => 'read', nproc: () => 'read', lscpu: () => 'read', lsmod: () => 'read', lspci: () => 'read',
  lsof: () => 'read', last: () => 'read', w: () => 'read', who: () => 'read', dmesg: (t) => (has(t, '-c', '-C', '--clear') ? 'strong' : 'read'), ss: () => 'read',
  netstat: () => 'read', ifconfig: (t) => (t.length <= 2 ? 'read' : 'strong'),
  ping: (t) => (has(t, '-c') ? 'read' : 'strong'), dig: () => 'read', nslookup: () => 'read', host: () => 'read', traceroute: () => 'read', mtr: (t) => (has(t, '-r', '--report') ? 'read' : 'strong'),
  top: (t) => (has(t, '-b') ? 'read' : 'strong'), mount: (t) => (t.length === 1 ? 'read' : 'strong'), crontab: (t) => (has(t, '-l') ? 'read' : 'strong'),
  ip: (t) => (/^(a|addr|address|r|route|l|link|n|neigh|neighbor)$/.test(sub(t) ?? '') && !t.some((x) => /^(add|del|delete|flush|set|change|replace)$/.test(x)) ? 'read' : 'strong'),
  awk: (t) => (t.join(' ').includes('system(') || has(t, '-i') ? 'strong' : 'read'),
  sed: (t) => (has(t, '-i', '--in-place') || /(^|\s)-\w*i/.test(t.slice(1).filter((x) => /^-[a-z]+$/i.test(x)).join(' ')) || /(^|[^\w])(w|e)\s/.test(t.slice(1).join(' ')) ? 'strong' : 'read'),
  find: (t) => (has(t, '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls') ? 'strong' : 'read'),
  journalctl: (t) => (t.some((x) => /^--(vacuum|rotate|flush|relinquish|sync)/.test(x)) ? 'strong' : 'read'),
  systemctl: (t) => { const s = sub(t); if (LOG_SUBCMD.has(s) || has(t, '--failed')) return 'read'; if (s === 'reload' || s === 'daemon-reload') return 'mild'; return 'strong'; },
  service: (t) => (t[2] === 'status' ? 'read' : t[2] === 'reload' ? 'mild' : 'strong'),
  docker: (t) => {
    const s = sub(t); const rest = t.slice(1).filter((x) => !x.startsWith('-'));
    if (['ps', 'logs', 'inspect', 'images', 'top', 'version', 'info', 'port', 'diff', 'events', 'history'].includes(s)) return 'read';
    if (s === 'stats') return 'read';
    if (['network', 'volume', 'image', 'container', 'system', 'compose'].includes(s) && ['ls', 'inspect', 'ps', 'logs', 'df', 'config', 'images', 'top', 'version'].includes(rest[1])) return 'read';
    return 'strong';
  },
  kubectl: (t) => (['get', 'describe', 'logs', 'top', 'version', 'cluster-info', 'explain', 'api-resources'].includes(sub(t)) ? 'read' : 'strong'),
  git: (t) => { const s = sub(t); if (['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'describe', 'ls-files', 'blame', 'remote', 'tag', 'shortlog', 'config'].includes(s)) return s === 'branch' && has(t, '-d', '-D', '-m', '-M') ? 'strong' : s === 'config' && !has(t, '--get', '--list', '-l') ? 'strong' : s === 'tag' && t.length > 2 && !has(t, '-l', '--list') ? 'strong' : 'read'; return ['pull', 'fetch', 'checkout', 'switch', 'stash'].includes(s) && !has(t, '-f', '--force') ? 'mild' : 'strong'; },
  nginx: (t) => (has(t, '-t', '-T', '-v', '-V') ? 'read' : t.includes('reload') ? 'mild' : 'strong'),
  apachectl: (t) => (has(t, '-t', '-S', '-M', 'configtest') || t.includes('configtest') ? 'read' : 'strong'),
  php: (t) => (has(t, '-v', '-m', '-i', '--version', '--modules', '--ini') ? 'read' : 'strong'),
  node: (t) => (has(t, '-v', '--version') ? 'read' : 'strong'),
  python3: (t) => (has(t, '-V', '--version') ? 'read' : 'strong'), python: (t) => (has(t, '-V', '--version') ? 'read' : 'strong'),
  composer: (t) => (['show', 'diagnose', 'validate', 'outdated', '--version'].includes(sub(t)) || has(t, '--version') ? 'read' : 'strong'),
  npm: (t) => (['ls', 'list', 'outdated', 'view'].includes(sub(t)) ? 'read' : 'strong'),
  pm2: (t) => (['list', 'ls', 'status', 'logs', 'show', 'jlist', 'describe', 'monit'].includes(sub(t)) ? 'read' : 'strong'),
  ufw: (t) => (sub(t) === 'status' ? 'read' : 'strong'),
  iptables: (t) => (has(t, '-L', '-S', '--list') && !has(t, '-F', '-X', '-A', '-D', '-I') ? 'read' : 'strong'),
  openssl: (t) => (['x509', 's_client', 'version'].includes(sub(t)) && !has(t, '-out') ? 'read' : 'strong'),
  curl: (t) => (t.slice(1).some((x) => /^(--request|--data[w-]*|--form|--upload-file|--output|--remote-name|--config)$/.test(x) || (/^-[A-Za-z]+$/.test(x) && /[dFToOKX]/.test(x))) ? 'strong' : 'read'),
  mkdir: () => 'mild', touch: () => 'mild', ln: (t) => (has(t, '-s', '-sf', '-sfn') ? 'mild' : 'strong'),
  cp: (t) => (t.some((x) => /^-\w*[fr]/.test(x)) ? 'strong' : 'mild'),
};

/** Archivos y palabras que suelen guardar secretos: leerlos mandaría la clave al modelo, así que se pregunta. */
const SECRETS = /(\.env\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.key\b|\/etc\/shadow|\.ssh\/|credentials|\.aws\/|\.git-credentials|\.kube\/config|\.npmrc|\.netrc|secret|passw|token)/i;
const stripSafeRedirects = (s) => s.replace(/\d?>\s*\/dev\/null/g, ' ').replace(/2>&1/g, ' ');

/** Clasifica un comando completo (con pipes, && y ;). La categoría es la del peor de sus tramos. */
export function classify(command) {
  const cmd = String(command ?? '').trim();
  const strong = (reason) => ({ tier: 'strong', reason, critical: DANGER.some((re) => re.test(cmd)) });
  if (!cmd) return strong('comando vacío');
  if (cmd.length > MAX_CMD) return strong('comando demasiado largo');
  if (/[\r\n]/.test(cmd)) return strong('varias líneas');
  if (/\$\(|`|<\(|>\(|<<|\$\{|\\\n/.test(cmd)) return strong('sustitución de comandos o heredoc');
  if (/[<>]/.test(stripSafeRedirects(cmd))) return strong('escribe o lee archivos con redirección');
  if (DANGER.some((re) => re.test(cmd))) return strong('acción destructiva o que afecta el servicio');
  let worst = 'read';
  if (SECRETS.test(cmd)) return strong('puede exponer secretos (se enviarían al modelo)');
  for (const seg of stripSafeRedirects(cmd).split(/&&|\|\||;|\||&/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    if (/^\w+=/.test(tokens[0])) return strong('variables de entorno antes del comando');
    const name = tokens[0].replace(/^.*\//, ''); // /usr/bin/ls → ls
    const rule = RULES[name];
    if (!rule) return strong(`«${name}» no está en la lista de comandos de solo lectura`);
    const tier = rule(tokens);
    if (tier === 'strong') return strong(`«${name}» puede modificar el servidor`);
    if (tier === 'mild') worst = 'mild';
  }
  return { tier: worst, reason: worst === 'read' ? 'solo lectura' : 'cambio leve y reversible', critical: false };
}

/** ¿Hay que preguntarte? Lo fuerte siempre; los cambios leves solo en producción. */
export const needsApproval = (tier, env) => tier === 'strong' || (tier === 'mild' && env === 'prod');

const cap = (s) => (s.length > OUT_CAP ? `${s.slice(0, OUT_CAP)}\n…[salida cortada: ${s.length - OUT_CAP} caracteres más]` : s);

/**
 * Ejecuta el comando por SSH con contraseña (cliente SSH incluido, sin tocar el ssh del sistema).
 * La primera vez fija la huella del servidor (`onPin`); si después cambia, se niega a conectar (posible suplantación).
 */
export function runSsh2({ server, command, password, pinned = null, onPin, timeoutMs = SSH_TIMEOUT_MS, ClientCtor = Client }) {
  return new Promise((resolve) => {
    const conn = new ClientCtor();
    let out = ''; let err = ''; let timedOut = false; let done = false; let mismatch = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { conn.end(); } catch { /* ya cerrada */ } resolve(r); };
    const timer = setTimeout(() => { timedOut = true; finish({ code: -1, stdout: cap(out), stderr: cap(err), timedOut: true }); }, timeoutMs);
    conn.on('ready', () => {
      conn.exec(command, (e, stream) => {
        if (e) return finish({ code: -1, stdout: '', stderr: e.message, timedOut: false });
        stream.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
        stream.stderr.on('data', (d) => { if (err.length < OUT_CAP * 2) err += d; });
        stream.on('close', (code) => finish({ code: code ?? -1, stdout: cap(out), stderr: cap(err), timedOut }));
      });
    });
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, reply) => reply(prompts.map(() => password)));
    conn.on('error', (e) => {
      const msg = mismatch ? 'La huella del servidor cambió: podría ser una suplantación o una reinstalación. No se conectó. Si fue un cambio legítimo, quita y vuelve a agregar el servidor.'
        : /authentication/i.test(e.message) ? 'Usuario o contraseña incorrectos (el servidor rechazó el acceso)'
          : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|Timed out/i.test(e.message) ? `No se pudo conectar a ${server.host}:${server.port || 22} (${e.code ?? e.message})` : e.message;
      finish({ code: -1, stdout: '', stderr: msg, timedOut: false });
    });
    conn.connect({
      host: server.host, port: server.port || 22, username: server.user || undefined, password, tryKeyboard: true, readyTimeout: 15_000, keepaliveInterval: 15_000,
      hostVerifier: (key) => {
        const fp = fingerprint(key);
        if (!pinned) { onPin?.(fp); return true; }
        if (pinned === fp) return true;
        mismatch = true; return false;
      },
    });
  });
}

/** Ejecuta el comando por SSH con tus llaves (sin shell local, sin contraseñas). */
export function runSsh({ server, command, spawnFn = spawn, sshBin = 'ssh', timeoutMs = SSH_TIMEOUT_MS }) {
  const target = `${server.user ? `${server.user}@` : ''}${server.host}`;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-p', String(server.port || 22), '--', target, command];
  return new Promise((resolve) => {
    let out = ''; let err = ''; let timedOut = false; let done = false;
    const child = spawnFn(sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    child.stdout.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
    child.stderr.on('data', (d) => { if (err.length < OUT_CAP * 2) err += d; });
    child.on('error', (e) => finish({ code: -1, stdout: '', stderr: e.code === 'ENOENT' ? 'No se encontró «ssh» en este equipo (instala el cliente OpenSSH de Windows)' : e.message, timedOut: false }));
    child.on('close', (code) => finish({ code: timedOut ? -1 : code, stdout: cap(out), stderr: cap(err), timedOut }));
  });
}
