// Renderizado pixel-art 2D de la oficina (Canvas): salas con ventanales al espacio, escritorios con
// hologramas, props temáticos y personajes animados (caminan, teclean, saludan, parpadean, se averían).
import { CANVAS, CHAR, DEPARTMENTS, OPS_ROOM, DESK, GAP, layoutOffice, stepToward, wanderTarget } from './office-layout.js';
import { getSprite } from './sprites.js';
import { SCENES, EMBLEMS } from './scenes.js';
import { DEFAULT_SKIN, deptView } from './skins.js';
import { arc, progress, prune, FLIGHT_MS } from './comms.js';

const FONT = '"Cascadia Mono", Consolas, monospace';
const STATE_COLOR = { working: '#4aa3ff', queued: '#9aa6cc', review: '#b18cff', failed: '#ff5a5a' };
const WIN = { x: 6, y: 22, h: 30 }; // ventanal dentro de cada sala
const WALK_DESK = 90; // px/s al ir a trabajar
const WALK_IDLE = 34; // px/s al deambular

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rand01 = (seed, a, b = 0) => { const v = Math.sin(seed * 12.9898 + a * 78.233 + b * 37.719) * 43758.5453; return v - Math.floor(v); };
const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
const mod = (a, n) => ((a % n) + n) % n;

// ---------- capas estáticas por sala (cacheadas) ----------
function buildRoomLayer(dept, w, h, ops = false, skin = DEFAULT_SKIN) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const seed = hash(dept.id);
  // suelo de placas metálicas con juntas y desgaste
  for (let ty = 0; ty < h; ty += 24) for (let tx = 0; tx < w; tx += 24) {
    px(ctx, tx, ty, 24, 24, (tx / 24 + ty / 24) % 2 ? skin.floor.a : skin.floor.b);
    px(ctx, tx, ty, 24, 1, skin.floor.joint); px(ctx, tx, ty, 1, 24, skin.floor.joint);
    px(ctx, tx + 1, ty + 1, 22, 1, '#ffffff08');
    if (rand01(seed, tx, ty) > 0.78) px(ctx, tx + 3 + Math.floor(rand01(seed, ty, tx) * 16), ty + 3 + Math.floor(rand01(seed, tx, ty + 1) * 16), 2, 1, skin.floor.speck);
  }
  // pared superior con paneles y franja de color
  px(ctx, 0, 0, w, 62, skin.wall);
  for (let x = 0; x < w; x += 48) { px(ctx, x, 52, 1, 10, skin.wallLine); px(ctx, x + 1, 53, 46, 1, '#ffffff0a'); }
  px(ctx, 0, 60, w, 2, dept.color + '66');
  // marco del ventanal
  px(ctx, WIN.x - 3, WIN.y - 3, w - 2 * (WIN.x - 3), WIN.h + 6, skin.frame);
  px(ctx, WIN.x - 3, WIN.y - 3, w - 2 * (WIN.x - 3), 1, dept.color + 'aa');
  // alfombra / zona de descanso
  if (!ops) {
    ctx.fillStyle = dept.color + '12'; ctx.fillRect(6, 214, w - 12, h - 220);
    ctx.strokeStyle = dept.color + '55'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.strokeRect(6.5, 214.5, w - 13, h - 221); ctx.setLineDash([]);
    ctx.fillStyle = dept.color + '99'; ctx.font = `bold 10px ${FONT}`; ctx.fillText('DESCANSO', 12, 226 - 4 + 0);
    // alfombrillas bajo escritorios y línea guía
    for (const [dx, dy] of [[18, 66], [160, 66], [18, 150], [160, 150]]) px(ctx, dx - 4, dy + 8, DESK.w + 8, DESK.h + 14, '#00000030');
    ctx.fillStyle = dept.color + '33';
    for (let x = 10; x < w - 10; x += 12) ctx.fillRect(x, 207, 6, 2);
  }
  // borde
  ctx.strokeStyle = dept.color; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.strokeStyle = dept.color + '33'; ctx.lineWidth = 1; ctx.strokeRect(4.5, 4.5, w - 9, h - 9);
  return c;
}

/** Rótulo de la sala: barra oscura con emblema y nombre. `k` (1–1.25) lo agranda cuando el mapa se ve reducido en pantallas pequeñas. */
function drawRoomTitle(ctx, room, label, color, k, skin) {
  const { x, y, w } = room.rect;
  const H = Math.round(18 * k); const size = Math.round(13 * k);
  px(ctx, x + 2, y + 2, w - 4, H, '#000d'); px(ctx, x + 2, y + 2 + H, w - 4, 1, color + '88');
  (EMBLEMS[skin.emblem] ?? EMBLEMS.diamond)(ctx, x + 6, y + 2 + Math.round((H - 8) / 2), color); // emblema del skin
  ctx.font = `bold ${size}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const text = clip(ctx, label.toUpperCase(), w - 36);
  const ty = y + 2 + H / 2 + 1; const tx = x + 20 + Math.round((k - 1) * 8);
  ctx.fillStyle = '#000'; ctx.fillText(text, tx + 1, ty + 1); // sombra para que se lea sobre cualquier fondo
  ctx.fillStyle = color; ctx.fillText(text, tx, ty);
  ctx.textBaseline = 'alphabetic';
}

// ---------- ventanal animado ----------
function drawWindow(ctx, room, dept, t, skin) {
  const x = room.rect.x + WIN.x; const y = room.rect.y + WIN.y; const w = room.rect.w - 2 * WIN.x; const h = WIN.h;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  (SCENES[skin.scene] ?? SCENES.space)(ctx, x, y, w, h, t, hash(dept.id), dept);
  for (let bx = 72; bx < w; bx += 72) px(ctx, x + bx, y, 3, h, skin.frame); // montantes
  ctx.restore();
  ctx.strokeStyle = dept.color + '66'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const seed = hash(dept.id);
  // luces de la pared pulsando
  for (let i = 0; i < 6; i++) {
    const on = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + i * 0.9 + seed));
    ctx.fillStyle = dept.color; ctx.globalAlpha = on; ctx.fillRect(room.rect.x + 14 + i * 46, room.rect.y + 56, 12, 2); ctx.globalAlpha = 1;
  }
}

// ---------- decoración temática (columna central entre escritorios) ----------
function drawProp(ctx, id, room, t, skin) {
  const M = skin.metal; const MD = skin.metalDark;
  const cx = room.rect.x + GAP.x + GAP.w / 2; const top = room.rect.y + 80; const base = room.rect.y + 196;
  const glow = (_c, col, a, r, x, y) => { const g = ctx.createRadialGradient(x, y, 1, x, y, r); g.addColorStop(0, col + a); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
  switch (id) {
    case 'mando': { // pedestal con globo holográfico
      px(ctx, cx - 9, base - 8, 18, 8, M); px(ctx, cx - 4, base - 30, 8, 22, MD);
      const gy = base - 52; glow(ctx, '#ffd84a', '55', 28, cx, gy);
      ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.ellipse(cx, gy, 12 * Math.abs(Math.cos(t * 0.8 + i * 1.05)) + 1, 12, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.beginPath(); ctx.ellipse(cx, gy, 12, 4, 0, 0, Math.PI * 2); ctx.stroke();
      break; }
    case 'hangar': { // cajas de carga con franjas de peligro
      for (const [dx, dy, s] of [[-12, 0, 24], [-8, -24, 18], [4, -16, 12]]) {
        px(ctx, cx + dx, base - 24 + dy + 24 - s, s, s, '#6b5a3a'); px(ctx, cx + dx, base - s + dy + 0, s, 3, '#e8b73a');
        px(ctx, cx + dx + 2, base - s + dy + 3, s - 4, 1, '#00000055');
      }
      px(ctx, cx - 14, base, 28, 3, '#00000066');
      break; }
    case 'inteligencia': { // pilar escáner con barrido rojo
      px(ctx, cx - 7, top + 20, 14, base - top - 20, '#1a1f30'); px(ctx, cx - 5, top + 24, 10, base - top - 28, '#0c1020');
      const sy = top + 28 + mod(t * 30, base - top - 40); glow(ctx, '#ff5a5a', '88', 16, cx, sy); px(ctx, cx - 5, Math.round(sy), 10, 1, '#ff8a8a');
      px(ctx, cx - 8, top + 16, 16, 4, M); px(ctx, cx - 2, top + 10, 4, 6, '#ff5a5a');
      break; }
    case 'flota': { // reactor con burbujas de plasma
      px(ctx, cx - 9, base - 6, 18, 6, M); px(ctx, cx - 9, top + 14, 18, 4, M);
      px(ctx, cx - 6, top + 18, 12, base - top - 24, '#0a1a2e');
      glow(ctx, '#4aa3ff', '66', 34, cx, (top + base) / 2);
      for (let i = 0; i < 6; i++) { const by = base - 10 - mod(t * (14 + i * 3) + i * 19, base - top - 36); px(ctx, cx - 4 + ((i * 5) % 8), Math.round(by), 2, 2, '#9fd0ff'); }
      px(ctx, cx - 6, top + 18, 2, base - top - 24, '#ffffff22');
      break; }
    case 'diplomacia': { // estandarte y planta
      px(ctx, cx - 9, top - 14, 18, 3, '#8b6b3d');
      px(ctx, cx - 7, top - 11, 14, 46, skin.banner); px(ctx, cx - 7, top + 35, 7, 5, skin.banner); px(ctx, cx, top + 35, 7, 5, '#0a0e1c');
      px(ctx, cx - 3, top + 4, 6, 6, '#d9c7a0'); px(ctx, cx - 1, top + 2, 2, 10, '#d9c7a0'); px(ctx, cx - 5, top + 6, 10, 2, '#d9c7a0');
      px(ctx, cx - 7, base - 14, 14, 14, '#5b3b24'); px(ctx, cx - 7, base - 14, 14, 2, '#7a5233');
      const sw = Math.sin(t * 1.4) * 1.5;
      px(ctx, cx - 1 + sw, base - 30, 2, 16, '#3a8a4a'); px(ctx, cx - 7 + sw, base - 26, 6, 3, '#4aae5a'); px(ctx, cx + 1 + sw, base - 32, 6, 3, '#4aae5a');
      break; }
    case 'taller': { // cristal flotante sobre pedestal
      px(ctx, cx - 8, base - 8, 16, 8, M); px(ctx, cx - 3, base - 22, 6, 14, MD);
      const by = base - 46 + Math.sin(t * 1.6) * 3; glow(ctx, '#b18cff', '77', 24, cx, by);
      ctx.fillStyle = '#c9a8ff'; ctx.beginPath(); ctx.moveTo(cx, by - 12); ctx.lineTo(cx + 7, by); ctx.lineTo(cx, by + 12); ctx.lineTo(cx - 7, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff88'; ctx.beginPath(); ctx.moveTo(cx, by - 12); ctx.lineTo(cx + 3, by - 2); ctx.lineTo(cx, by); ctx.lineTo(cx - 4, by - 2); ctx.closePath(); ctx.fill();
      break; }
    case 'reconocimiento': { // antena de radar giratoria
      px(ctx, cx - 3, base - 70, 6, 70, MD); px(ctx, cx - 9, base - 6, 18, 6, M);
      const a = t * 1.4; const ry = base - 74;
      ctx.strokeStyle = '#9aa4b8'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 14, ry - Math.sin(a) * 4); ctx.lineTo(cx + Math.cos(a) * 14, ry + Math.sin(a) * 4); ctx.stroke();
      px(ctx, cx - 2, ry - 2, 4, 4, '#4ade80');
      glow(ctx, '#4ade80', '44', 22, cx, ry);
      break; }
    default: break;
  }
}

// ---------- escritorios ----------
function drawDeskBack(ctx, d, state, t, seed, skin) {
  const mx = d.x + 70; const my = d.y + 6;
  px(ctx, mx + 12, my + 20, 8, 6, skin.metalDark); // pie
  px(ctx, mx, my, 34, 22, '#10152a'); px(ctx, mx + 1, my + 1, 32, 20, '#0a0e1c');
  const on = state != null;
  if (!on) { px(ctx, mx + 3, my + 3, 28, 16, '#0f1a2e'); if (Math.floor(t * 0.8 + seed) % 2) px(ctx, mx + 15, my + 10, 2, 2, '#2a6a8a'); return; }
  const col = state === 'failed' ? '#ff5a5a' : state === 'review' ? '#b18cff' : state === 'queued' ? '#9aa6cc' : skin.holo;
  px(ctx, mx + 3, my + 3, 28, 16, state === 'failed' ? '#2a0a0e' : '#06202c');
  ctx.fillStyle = col;
  for (let i = 0; i < 5; i++) {
    const len = state === 'working' ? 6 + ((Math.floor(t * 6) + i * 5) % 18) : 12 + ((i * 7) % 12);
    ctx.globalAlpha = state === 'queued' ? 0.35 : 0.9; ctx.fillRect(mx + 5, my + 5 + i * 3, len, 1);
  }
  ctx.globalAlpha = 1;
  if (state === 'working' && Math.floor(t * 3) % 2) px(ctx, mx + 6 + ((Math.floor(t * 6)) % 18), my + 5 + (Math.floor(t * 2) % 5) * 3, 2, 2, '#ffffff');
  const g = ctx.createRadialGradient(mx + 17, my + 11, 2, mx + 17, my + 11, 34); g.addColorStop(0, col + '33'); g.addColorStop(1, col + '00');
  ctx.fillStyle = g; ctx.fillRect(mx - 18, my - 12, 70, 56);
}

function drawDeskFront(ctx, d, state, t, skin) {
  const D = skin.desk;
  px(ctx, d.x, d.y + 30, d.w, 8, D.top); px(ctx, d.x, d.y + 30, d.w, 1, D.topHi); // tablero
  px(ctx, d.x, d.y + 38, d.w, 14, D.body); px(ctx, d.x, d.y + 38, d.w, 1, D.bodyDark);
  px(ctx, d.x + 6, d.y + 38, 4, 14, D.leg); px(ctx, d.x + d.w - 10, d.y + 38, 4, 14, D.leg);
  px(ctx, d.x + 16, d.y + 31, 28, 5, '#2a3042'); px(ctx, d.x + 17, d.y + 32, 26, 1, '#4a5470'); // teclado
  if (state === 'working' && Math.floor(t * 9) % 2) px(ctx, d.x + 20 + (Math.floor(t * 9) % 18), d.y + 33, 3, 1, skin.holo);
  px(ctx, d.x + 54, d.y + 24, 6, 7, '#d9d9e0'); px(ctx, d.x + 60, d.y + 26, 2, 3, '#d9d9e0'); // taza
  if (state === 'working') { const s = Math.sin(t * 3); px(ctx, d.x + 56 + s, d.y + 19, 1, 3, '#ffffff55'); }
}

// ---------- comunicación entre agentes ----------
function drawBubble(ctx, x, y, text, color) {
  ctx.font = `bold 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = Math.max(18, ctx.measureText(text).width + 10);
  px(ctx, x - w / 2, y - 9, w, 17, '#000d'); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2 + 0.5, y - 8.5, w - 1, 16);
  px(ctx, x - 2, y + 8, 4, 3, color); // cola del globo
  ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

function drawEnvelope(ctx, x, y, color, check) {
  px(ctx, x - 8, y - 6, 16, 12, '#000'); px(ctx, x - 7, y - 5, 14, 10, '#f4f1de'); // sobre
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(x - 7.5, y - 5.5, 15, 11);
  ctx.strokeStyle = '#8a8472'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 7, y - 5); ctx.lineTo(x, y + 1); ctx.lineTo(x + 7, y - 5); ctx.stroke(); // solapa
  if (check) { ctx.fillStyle = '#4ade80'; ctx.beginPath(); ctx.arc(x + 8, y + 6, 5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#05140a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 5.5, y + 6); ctx.lineTo(x + 7.5, y + 8); ctx.lineTo(x + 10.5, y + 4); ctx.stroke(); }
  else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 8, y + 6, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#000'; ctx.font = `bold 9px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', x + 8, y + 6.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; }
}

/** Enlaces de las consultas en curso (arco punteado con puntos que viajan) y sobres que vuelan entre agentes. */
function drawComms(ctx, actors, comms, t, skin, reduced) {
  if (!comms) return;
  const now = Date.now();
  const pos = (n) => { const a = actors.get(n); return a ? { x: a.x, y: a.y - CHAR.h / 2 } : null; };
  const gold = skin.ui.gold;
  (comms.links ?? []).forEach((l, n) => {
    const a = pos(l.from); const b = pos(l.to);
    if (!a || !b) return;
    const lift = 46 + n * 24; // cada consulta en curso vuela en su propio arco para que no se encimen
    const cx = (a.x + b.x) / 2; const cy = Math.min(a.y, b.y) - lift;
    ctx.save();
    ctx.strokeStyle = gold; ctx.globalAlpha = 0.9; ctx.lineWidth = 3; ctx.setLineDash([7, 5]); ctx.lineDashOffset = -((t * 22) % 12);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, b.x, b.y); ctx.stroke();
    ctx.restore();
    if (!reduced) for (let i = 0; i < 3; i++) { const p = arc(a, b, (t * 0.3 + i / 3) % 1, lift); px(ctx, p.x - 3, p.y - 3, 6, 6, gold); }
    const mid = arc(a, b, 0.5, lift);
    ctx.font = `bold 12px ${FONT}`; const label = `${l.from} ⇄ ${l.to}`; const w = ctx.measureText(label).width + 12;
    px(ctx, mid.x - w / 2, mid.y - 20, w, 17, '#000e'); ctx.strokeStyle = gold; ctx.lineWidth = 1; ctx.strokeRect(mid.x - w / 2 + 0.5, mid.y - 19.5, w - 1, 16);
    ctx.fillStyle = gold; ctx.textAlign = 'center'; ctx.fillText(label, mid.x, mid.y - 7); ctx.textAlign = 'left';
    drawBubble(ctx, a.x, a.y - CHAR.h / 2 - 12, '¿?', gold); // quien pregunta espera
    drawBubble(ctx, b.x, b.y - CHAR.h / 2 - 12, l.state === 'running' ? '.'.repeat(1 + (Math.floor(t * 3) % 3)) : 'z', skin.holo); // quien responde, escribiendo
  });
  for (const f of prune(comms.flights ?? [], now)) {
    const a = pos(f.from); const b = pos(f.to);
    if (!a || !b) continue;
    const p = progress(f, now);
    const color = f.kind === 'answer' ? '#4ade80' : gold;
    for (let i = 1; i <= 4; i++) { const q = arc(a, b, Math.max(0, p - i * 0.04), 60); ctx.globalAlpha = 0.5 - i * 0.1; px(ctx, q.x - 2, q.y - 2, 4, 4, color); }
    ctx.globalAlpha = 1;
    const pt = arc(a, b, p, 60);
    drawEnvelope(ctx, pt.x, pt.y, color, f.kind === 'answer');
    if (p >= 1) { // destello al llegar
      const k = Math.min(1, (now - f.t0 - FLIGHT_MS * 0.8) / (FLIGHT_MS * 0.2));
      ctx.globalAlpha = 1 - k; ellipse(ctx, b.x, b.y, 8 + k * 22, 8 + k * 22, color, 2); ctx.globalAlpha = 1;
    }
  }
}

// ---------- sala de operaciones ----------
// Cada skin tiene su propia galaxia: brazos, giro, núcleo y extras distintos (anillos, cinturón, nieve, brasas…).
const GALAXY = {
  clasico: { arms: 3, turns: 9, spin: 0.5, rx: 66, tilt: 0.36, alt: '#ffffff', orb: '#ffd84a', core: 'plain' },
  imperio: { arms: 2, turns: 7, spin: 0.35, rx: 62, tilt: 0.34, alt: '#ff9a8a', orb: '#cfd3dc', core: 'sphere' },
  rebelion: { arms: 4, turns: 8, spin: 0.55, rx: 66, tilt: 0.36, alt: '#c9ff8a', orb: '#8ae04a', core: 'plain', moon: true },
  tatooine: { arms: 3, turns: 6, spin: 0.4, rx: 64, tilt: 0.34, alt: '#ffe9b0', orb: '#ff9a3c', core: 'binary' },
  jedi: { arms: 5, turns: 10, spin: 0.45, rx: 68, tilt: 0.36, alt: '#fff3c8', orb: '#e8c870', core: 'plain', ring: true },
  hoth: { arms: 3, turns: 8, spin: 0.3, rx: 64, tilt: 0.36, alt: '#ffffff', orb: '#bfefff', core: 'plain', snow: true },
  mandaloriano: { arms: 3, turns: 7, spin: 0.4, rx: 56, tilt: 0.36, alt: '#d8b878', orb: '#cfd6e0', core: 'plain', belt: true },
  sith: { arms: 2, turns: 9, spin: 0.6, rx: 66, tilt: 0.34, alt: '#ffb04a', orb: '#ff3a3a', core: 'pulse', embers: true },
  rogue: { arms: 3, turns: 9, spin: 0.5, rx: 66, tilt: 0.36, alt: '#d8fff6', orb: '#4ad8c8', core: 'shield' },
};
const ellipse = (ctx, cx, cy, rx, ry, color, w = 1) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke(); };

function drawGalaxy(ctx, cx, cy, t, skin) {
  const G = GALAXY[skin.id] ?? GALAXY.clasico;
  const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 90); g.addColorStop(0, skin.holo + '44'); g.addColorStop(1, skin.holo + '00');
  ctx.fillStyle = g; ctx.fillRect(cx - 95, cy - 60, 190, 120);
  px(ctx, cx - 56, cy + 26, 112, 12, skin.metalDark); px(ctx, cx - 50, cy + 22, 100, 5, skin.metal); // base de la holomesa
  if (G.ring) { ctx.globalAlpha = 0.5; ellipse(ctx, cx, cy, 78, 28, G.orb); ctx.globalAlpha = 1; }
  if (G.belt) for (let i = 0; i < 30; i++) { const a = t * 0.25 + i * 0.21 + rand01(7, i) * 0.2; const r = 70 + rand01(3, i) * 5; ctx.globalAlpha = 0.75; px(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.36, i % 4 ? 1 : 2, i % 4 ? 1 : 2, '#9a8a78'); }
  for (let i = 0; i < 100; i++) {
    const arm = i % G.arms; const k = i / 100;
    const ang = t * G.spin + k * G.turns + arm * ((Math.PI * 2) / G.arms); const rad = 5 + k * G.rx;
    ctx.globalAlpha = 0.95 - k * 0.65;
    px(ctx, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad * G.tilt, 2, 2, i % 3 ? skin.holo : G.alt);
  }
  ctx.globalAlpha = 1;
  if (G.core === 'sphere') { // Estrella de la Muerte
    ctx.fillStyle = '#9096a4'; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c9ced8'; ctx.beginPath(); ctx.arc(cx - 2, cy - 2, 5, 0, Math.PI * 2); ctx.fill();
    px(ctx, cx + 2, cy - 4, 3, 3, '#3a3d48'); px(ctx, cx - 8, cy, 16, 1, '#5a5e6a');
  } else if (G.core === 'binary') { // dos soles
    const a = t * 1.6; px(ctx, cx + Math.cos(a) * 6 - 2, cy + Math.sin(a) * 3 - 2, 5, 5, '#ffe9b0'); px(ctx, cx - Math.cos(a) * 6 - 2, cy - Math.sin(a) * 3 - 2, 4, 4, '#ff9a3c');
  } else if (G.core === 'pulse') { // núcleo en brasa
    const r = 3 + Math.abs(Math.sin(t * 2.4)) * 3; ctx.fillStyle = '#ffd0a0'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.4; ellipse(ctx, cx, cy, r + 5, (r + 5) * 0.5, '#ff3a3a'); ctx.globalAlpha = 1;
  } else if (G.core === 'shield') { // escudo planetario de Scarif
    px(ctx, cx - 3, cy - 2, 6, 4, '#e8fffa'); ctx.globalAlpha = 0.6 + Math.sin(t * 3) * 0.3; ellipse(ctx, cx, cy, 18, 8, '#8afff0', 2); ctx.globalAlpha = 1;
  } else px(ctx, cx - 3, cy - 2, 6, 4, '#fff6c8');
  if (G.snow) for (let i = 0; i < 16; i++) { const x = cx - 80 + mod(rand01(5, i) * 160 + Math.sin(t + i) * 4, 160); const y = cy - 34 + mod(rand01(9, i) * 76 + t * (10 + (i % 4) * 5), 76); px(ctx, x, y, i % 3 ? 1 : 2, i % 3 ? 1 : 2, '#ffffffcc'); }
  if (G.embers) for (let i = 0; i < 12; i++) { const x = cx - 70 + rand01(4, i) * 140; const y = cy + 34 - mod(rand01(8, i) * 70 + t * (12 + (i % 3) * 6), 70); ctx.globalAlpha = 0.4 + rand01(2, i) * 0.5; px(ctx, x + Math.sin(t * 2 + i) * 3, y, 2, 2, i % 2 ? '#ff6a3a' : '#ffb04a'); ctx.globalAlpha = 1; }
  const a = t * 1.1; px(ctx, cx + Math.cos(a) * 74 - 2, cy + Math.sin(a) * 27 - 2, 5, 5, G.orb); // satélite
  if (G.moon) { const b = -t * 1.7 + 1; px(ctx, cx + Math.cos(b) * 40 - 1, cy + Math.sin(b) * 15 - 1, 3, 3, '#e6f0da'); }
}

const clip = (ctx, s, maxW) => { let r = s; while (r.length > 1 && ctx.measureText(r).width > maxW) r = r.slice(0, -2) + '…'; return r; };

function drawOpsBack(ctx, room, model, t, skin) {
  const { x, y, w } = room.rect;
  const { stats, tasks = [], agents = [] } = model;
  drawGalaxy(ctx, x + w / 2, y + 112, t, skin);

  // datos reales de la oficina
  const count = (s) => tasks.filter((k) => k.status === s && k.kind !== 'objective').length;
  const working = new Set(tasks.filter((k) => k.status === 'running').map((k) => k.agent)).size;
  const claude = [stats?.active?.claude ?? 0, stats?.limit?.claude ?? 2];
  const ollama = [stats?.active?.ollama ?? 0, stats?.limit?.ollama ?? 1];

  // panel de datos (más alto y con letra más grande y clara)
  const px0 = x + 8; const py0 = y + 164; const pw = w - 16; const ph = 130;
  px(ctx, px0, py0, pw, ph, '#050d16'); ctx.strokeStyle = skin.holo + 'aa'; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, pw - 1, ph - 1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 13px ${FONT}`; ctx.fillStyle = skin.holo; ctx.fillText('ESTADO DE LA FLOTA', px0 + 10, py0 + 18);
  const paused = !!stats?.paused;
  const live = paused ? 'EN PAUSA' : stats ? 'EN LÍNEA' : 'SIN DATOS';
  ctx.textAlign = 'right'; ctx.fillStyle = paused ? '#ffd84a' : stats ? '#4ade80' : '#9aa6cc'; ctx.fillText(live, px0 + pw - 10, py0 + 18);
  const lw = ctx.measureText(live).width;
  if (stats && (paused || Math.floor(t * 2) % 2)) px(ctx, px0 + pw - 10 - lw - 12, py0 + 9, 7, 7, paused ? '#ffd84a' : '#4ade80');
  px(ctx, px0 + 8, py0 + 23, pw - 16, 1, skin.holo + '44');

  const cellW = (pw - 30) / 2; const LABEL = '#c4d4e6'; const VAL = '#ffffff';
  const cell = (col, row, label, value, { bar, color = VAL } = {}) => {
    const cx0 = px0 + 10 + col * (cellW + 10); const cy0 = py0 + 45 + row * 25;
    ctx.font = `13px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = LABEL; ctx.fillText(label, cx0, cy0);
    ctx.font = `bold 14px ${FONT}`; ctx.textAlign = 'right'; ctx.fillStyle = color; ctx.fillText(clip(ctx, String(value), cellW - 92), cx0 + cellW, cy0);
    if (bar != null) { px(ctx, cx0, cy0 + 4, cellW, 4, '#1d2c3c'); px(ctx, cx0, cy0 + 4, Math.round(cellW * Math.min(1, bar)), 4, bar >= 1 ? '#ffd84a' : skin.holo); }
  };
  const ratio = ([a, b]) => (b > 0 ? a / b : 0);
  cell(0, 0, 'Claude', `${claude[0]}/${claude[1]}`, { bar: ratio(claude) });
  cell(1, 0, 'Ollama', `${ollama[0]}/${ollama[1]}`, { bar: ratio(ollama) });
  cell(0, 1, 'En espera', stats?.waiting ?? 0, { color: (stats?.waiting ?? 0) > 0 ? '#ffd84a' : VAL });
  cell(1, 1, 'Costo hoy', `$${(stats?.costToday ?? 0).toFixed(2)}`, { color: skin.holo });
  cell(0, 2, 'Agentes activos', `${working}/${agents.length || '–'}`);
  cell(1, 2, 'Completadas', count('done'), { color: '#4ade80' });
  cell(0, 3, 'Por revisar', count('review'), { color: count('review') ? STATE_COLOR.review : VAL });
  cell(1, 3, 'Fallidas', count('failed'), { color: count('failed') ? '#ff6a6a' : VAL });
}

// ---------- personajes ----------
function poseOf(a, t) {
  const ph = a.phase;
  const p = { leg: 0, arm: 'down', bob: 0, blink: false, slump: false, dome: 0, saber: false };
  const tick = (rate) => Math.floor(t * rate + ph);
  if (a.walking) {
    p.leg = 1 + (tick(8) % 2); p.bob = tick(8) % 2;
    if (a.dept === 'flota') p.dome = [-1, 0, 1, 0][tick(4) % 4];
    return p;
  }
  switch (a.state) {
    case 'working': p.arm = tick(7) % 2 ? 'typeA' : 'typeB'; p.bob = tick(2.2) % 5 === 0 ? 1 : 0; if (a.dept === 'flota') p.dome = [-1, 0, 1, 0][tick(3) % 4]; break;
    case 'queued': p.arm = tick(0.7) % 3 === 0 ? 'check' : 'down'; p.bob = tick(1.2) % 2; if (a.dept === 'flota') p.dome = [-1, 0, 1, 0][tick(1.5) % 4]; break;
    case 'review': p.arm = tick(4) % 2 ? 'waveA' : 'waveB'; p.saber = a.dept === 'taller'; break;
    case 'failed': p.slump = true; break;
    default: p.bob = tick(1.2) % 2; if (a.dept === 'flota') p.dome = [-1, 0, 1, 0][tick(0.8) % 4];
  }
  p.blink = mod(t + ph * 0.7, 3.6) < 0.14;
  return p;
}

function drawActor(ctx, a, t, skin) {
  const pose = poseOf(a, t);
  if (a.seat !== 'desk' || a.walking) { // sombra en el suelo
    ctx.fillStyle = '#00000066'; ctx.beginPath(); ctx.ellipse(a.x, a.y - 1, 12, 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  const hop = a.walking && pose.leg === 1 ? -1 : 0;
  const sprite = getSprite(a.dept, a.agent, pose, skin);
  ctx.drawImage(sprite, Math.round(a.x - CHAR.w / 2), Math.round(a.y - CHAR.h + hop), CHAR.w, CHAR.h);
  if (a.state === 'working' && a.seated && a.dept === 'taller') { /* el sable solo aparece al revisar */ }
}

function drawEffects(ctx, a, t) {
  if (a.walking || a.state === 'idle') return;
  const color = STATE_COLOR[a.state];
  const bx = Math.round(a.x); const by = Math.round(a.y - CHAR.h - 8 - (a.state === 'review' ? Math.abs(Math.sin(t * 6 + a.phase)) * 4 : 0));
  // burbuja
  const label = a.state === 'working' ? '.'.repeat(1 + (Math.floor(t * 3) % 3)) : { queued: 'z', review: '!', failed: '✕' }[a.state];
  ctx.font = `bold 12px ${FONT}`; ctx.textAlign = 'center';
  px(ctx, bx - 11, by - 12, 22, 14, '#000d'); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(bx - 10.5, by - 11.5, 21, 13);
  px(ctx, bx - 2, by + 2, 4, 3, '#000d');
  ctx.fillStyle = color; ctx.fillText(label, bx, by - (a.state === 'working' ? 3 : 1));
  if (a.state === 'failed') { // humo / chispas
    for (let i = 0; i < 4; i++) {
      const k = mod(t * 0.9 + i * 0.25 + a.phase, 1);
      ctx.fillStyle = i % 2 ? `rgba(140,140,150,${0.6 * (1 - k)})` : `rgba(255,120,60,${0.9 * (1 - k)})`;
      ctx.fillRect(Math.round(a.x - 8 + i * 5 + Math.sin(k * 8 + i) * 2), Math.round(a.y - CHAR.h + 4 - k * 22), 3, 3);
    }
  }
  if (a.state === 'review') { const s = Math.floor(t * 5 + a.phase) % 2; px(ctx, bx + 12, by - 4 + s * 3, 2, 2, '#ffe9ff'); px(ctx, bx - 14, by + 2 - s * 3, 2, 2, '#ffe9ff'); }
}

// ---------- componente principal ----------
export function createOffice(canvas, { onSelect, onSelectAgent } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS.w; canvas.height = CANVAS.h;
  ctx.imageSmoothingEnabled = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let model = { agents: [], tasks: [], stats: null };
  let comms = null;
  let layout = layoutOffice([], []);
  const actors = new Map();
  const layers = new Map();
  let hover = null;
  let skin = DEFAULT_SKIN;
  let raf = 0;
  let last = 0;

  const layerFor = (room, dept) => {
    if (!layers.has(room.id)) layers.set(room.id, buildRoomLayer(dept ? deptView(dept, skin) : { ...OPS_ROOM, color: skin.holo }, room.rect.w, room.rect.h, !dept, skin));
    return layers.get(room.id);
  };

  function sync() {
    const seen = new Set();
    for (const ch of layout.chars) {
      seen.add(ch.agent);
      let a = actors.get(ch.agent);
      if (!a) { a = { agent: ch.agent, x: ch.x, y: ch.y, phase: (hash(ch.agent) % 100) / 10, pause: 1 + Math.random() * 5, walking: false, seated: false }; actors.set(ch.agent, a); }
      const moved = a.home && (a.home.x !== ch.x || a.home.y !== ch.y);
      Object.assign(a, { dept: ch.dept, state: ch.state, seat: ch.seat, taskId: ch.taskId, home: { x: ch.x, y: ch.y } });
      if (moved || !a.goal) a.goal = { x: ch.x, y: ch.y };
      if (reduced) { a.x = ch.x; a.y = ch.y; }
    }
    for (const k of [...actors.keys()]) if (!seen.has(k)) actors.delete(k);
  }

  function update(dt) {
    for (const a of actors.values()) {
      if (a.seat === 'lounge' && a.state === 'idle') {
        const atGoal = Math.hypot(a.x - a.goal.x, a.y - a.goal.y) < 0.5;
        if (atGoal) {
          a.pause -= dt;
          if (a.pause <= 0) { a.goal = wanderTarget(a.home); a.pause = 2 + Math.random() * 6; }
        }
      } else { a.goal = a.home; }
      const speed = a.seat === 'desk' ? WALK_DESK : WALK_IDLE;
      const s = reduced ? { x: a.goal.x, y: a.goal.y, moved: 0 } : stepToward(a, a.goal, speed * dt);
      a.walking = s.moved > 0.05;
      a.x = s.x; a.y = s.y;
      a.seated = a.seat === 'desk' && !a.walking && Math.abs(a.x - a.home.x) < 1 && Math.abs(a.y - a.home.y) < 1;
    }
  }

  function draw(now = 0) {
    const t = reduced ? 0 : now / 1000;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (!reduced) update(dt);

    const textScale = Math.min(1.25, Math.max(1, Number(canvas.dataset.textScale) || 1)); // lo fija fitOffice() según cuánto se reduce el mapa
    ctx.fillStyle = skin.void; ctx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    const drawables = [];
    for (const room of layout.rooms) {
      const base = DEPARTMENTS.find((d) => d.id === room.id);
      const dept = base && deptView(base, skin);
      ctx.drawImage(layerFor(room, base), room.rect.x, room.rect.y);
      if (!dept) { drawWindow(ctx, room, { ...OPS_ROOM, color: skin.holo }, t, skin); drawOpsBack(ctx, room, model, t, skin); drawRoomTitle(ctx, room, OPS_ROOM.label, skin.holo, textScale, skin); continue; }
      drawWindow(ctx, room, dept, t, skin);
      drawRoomTitle(ctx, room, dept.label, dept.color, textScale, skin);
      drawProp(ctx, room.id, room, t, skin);
      // estado de cada escritorio según quién lo ocupa
      const sitting = [...actors.values()].filter((a) => a.dept === room.id && a.seat === 'desk');
      room.desks.forEach((d, i) => {
        const occupant = sitting.find((a) => Math.abs(a.home.x - (d.x + 34)) < 1 && Math.abs(a.home.y - (d.y + 44)) < 1);
        const st = occupant?.state ?? null;
        drawDeskBack(ctx, d, st, t, i, skin);
        drawables.push({ y: d.y + d.h, draw: () => drawDeskFront(ctx, d, st, t, skin) });
      });
    }
    for (const a of actors.values()) drawables.push({ y: a.y, draw: () => drawActor(ctx, a, t, skin), fx: () => drawEffects(ctx, a, t) });
    drawables.sort((p, q) => p.y - q.y);
    for (const d of drawables) d.draw();
    for (const d of drawables) d.fx?.();
    drawComms(ctx, actors, comms, t, skin, reduced);

    if (hover) {
      const a = actors.get(hover);
      if (a) {
        const text = `${a.agent} · ${a.state === 'idle' ? 'libre' : { working: 'trabajando', queued: 'en cola', review: 'por revisar', failed: 'falló' }[a.state]}`;
        ctx.font = `bold 11px ${FONT}`; ctx.textAlign = 'left';
        const tw = ctx.measureText(text).width + 12;
        const tx = Math.max(2, Math.min(a.x - tw / 2, CANVAS.w - tw - 2)); const ty = Math.max(2, a.y - CHAR.h - 34);
        px(ctx, tx, ty, tw, 18, '#000e'); ctx.strokeStyle = skin.ui.gold; ctx.lineWidth = 1; ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, 17);
        ctx.fillStyle = skin.ui.gold; ctx.fillText(text, tx + 6, ty + 13);
      }
    }
    if (!reduced) raf = requestAnimationFrame(draw);
  }

  const hit = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (CANVAS.w / r.width);
    const y = (ev.clientY - r.top) * (CANVAS.h / r.height);
    return [...actors.values()].filter((a) => x >= a.x - CHAR.w / 2 && x <= a.x + CHAR.w / 2 && y >= a.y - CHAR.h && y <= a.y).sort((p, q) => q.y - p.y)[0];
  };
  canvas.addEventListener('mousemove', (ev) => { const a = hit(ev); hover = a?.agent ?? null; canvas.style.cursor = a ? 'pointer' : 'default'; if (reduced) draw(); });
  canvas.addEventListener('mouseleave', () => { hover = null; if (reduced) draw(); });
  canvas.addEventListener('click', (ev) => {
    const a = hit(ev);
    if (!a) return;
    if (onSelectAgent) onSelectAgent(a.agent); else if (a.taskId) onSelect?.(a.taskId);
  });

  return {
    setSkin(next) { skin = next; layers.clear(); if (reduced) draw(); },
    update(next) { model = { ...model, ...next }; layout = layoutOffice(model.agents, model.tasks); sync(); if (reduced) draw(); },
    setComms(next) { comms = next; if (reduced) draw(); },
    start() { cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(draw); if (reduced) draw(); },
    stop() { cancelAnimationFrame(raf); },
    get layout() { return layout; },
    get actors() { return actors; },
  };
}

/** Miniatura de un skin (sala con ventanal y cuatro personajes). Con `night` se parte en dos: día | noche (skin Auto). */
export function drawSkinPreview(canvas, skin, night = null) {
  const W = 160; const H = 84;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const pose = { leg: 0, arm: 'down', bob: 0, blink: false, slump: false, dome: 0, saber: false };
  const paint = (sk, x0, x1) => {
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, H); ctx.clip();
    ctx.fillStyle = sk.wall; ctx.fillRect(0, 0, W, 44);
    for (let ty = 44; ty < H; ty += 12) for (let tx = 0; tx < W; tx += 12) { ctx.fillStyle = (tx / 12 + ty / 12) % 2 ? sk.floor.a : sk.floor.b; ctx.fillRect(tx, ty, 12, 12); }
    ctx.fillStyle = sk.frame; ctx.fillRect(4, 3, W - 8, 38);
    ctx.save(); ctx.beginPath(); ctx.rect(6, 5, W - 12, 34); ctx.clip();
    (SCENES[sk.scene] ?? SCENES.space)(ctx, 6, 5, W - 12, 34, 3.5, 11, { color: sk.ui.gold });
    ctx.restore();
    ctx.fillStyle = sk.ui.gold; ctx.fillRect(0, 43, W, 1);
    ['mando', 'hangar', 'taller', 'flota'].forEach((d, i) => ctx.drawImage(getSprite(d, `vista${i}`, pose, sk), 14 + i * 36, 52));
    ctx.restore();
  };
  paint(skin, 0, night ? W / 2 : W);
  if (night) { paint(night, W / 2, W); ctx.fillStyle = '#fff'; ctx.fillRect(W / 2 - 1, 0, 2, H); }
}
