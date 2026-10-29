// Renderizado pixel-art 2D de la oficina (Canvas): salas con ventanales al espacio, escritorios con
// hologramas, props temáticos y personajes animados (caminan, teclean, saludan, parpadean, se averían).
import { CANVAS, CHAR, DEPARTMENTS, OPS_ROOM, DESK, GAP, layoutOffice, stepToward, wanderTarget } from './office-layout.js';
import { getSprite } from './sprites.js';

const FONT = '"Cascadia Mono", Consolas, monospace';
const STATE_COLOR = { working: '#4aa3ff', queued: '#9aa6cc', review: '#b18cff', failed: '#ff5a5a' };
const WIN = { x: 6, y: 18, h: 34 }; // ventanal dentro de cada sala
const WALK_DESK = 90; // px/s al ir a trabajar
const WALK_IDLE = 34; // px/s al deambular

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rand01 = (seed, a, b = 0) => { const v = Math.sin(seed * 12.9898 + a * 78.233 + b * 37.719) * 43758.5453; return v - Math.floor(v); };
const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
const mod = (a, n) => ((a % n) + n) % n;

// ---------- capas estáticas por sala (cacheadas) ----------
function buildRoomLayer(dept, w, h, ops = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const seed = hash(dept.id);
  // suelo de placas metálicas con juntas y desgaste
  for (let ty = 0; ty < h; ty += 24) for (let tx = 0; tx < w; tx += 24) {
    px(ctx, tx, ty, 24, 24, (tx / 24 + ty / 24) % 2 ? '#10152a' : '#0e1326');
    px(ctx, tx, ty, 24, 1, '#070a16'); px(ctx, tx, ty, 1, 24, '#070a16');
    px(ctx, tx + 1, ty + 1, 22, 1, '#ffffff08');
    if (rand01(seed, tx, ty) > 0.78) px(ctx, tx + 3 + Math.floor(rand01(seed, ty, tx) * 16), ty + 3 + Math.floor(rand01(seed, tx, ty + 1) * 16), 2, 1, '#ffffff10');
  }
  // pared superior con paneles y franja de color
  px(ctx, 0, 0, w, 62, '#0a0e1c');
  for (let x = 0; x < w; x += 48) { px(ctx, x, 52, 1, 10, '#05070f'); px(ctx, x + 1, 53, 46, 1, '#ffffff0a'); }
  px(ctx, 0, 60, w, 2, dept.color + '66');
  // marco del ventanal
  px(ctx, WIN.x - 3, WIN.y - 3, w - 2 * (WIN.x - 3), WIN.h + 6, '#1a2038');
  px(ctx, WIN.x - 3, WIN.y - 3, w - 2 * (WIN.x - 3), 1, dept.color + 'aa');
  // alfombra / zona de descanso
  if (!ops) {
    ctx.fillStyle = dept.color + '12'; ctx.fillRect(6, 214, w - 12, h - 220);
    ctx.strokeStyle = dept.color + '55'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.strokeRect(6.5, 214.5, w - 13, h - 221); ctx.setLineDash([]);
    ctx.fillStyle = dept.color + '99'; ctx.font = `9px ${FONT}`; ctx.fillText('DESCANSO', 12, 226 - 4 + 0);
    // alfombrillas bajo escritorios y línea guía
    for (const [dx, dy] of [[18, 66], [160, 66], [18, 150], [160, 150]]) px(ctx, dx - 4, dy + 8, DESK.w + 8, DESK.h + 14, '#00000030');
    ctx.fillStyle = dept.color + '33';
    for (let x = 10; x < w - 10; x += 12) ctx.fillRect(x, 207, 6, 2);
  }
  // rótulo
  px(ctx, 2, 2, w - 4, 14, '#000c');
  ctx.fillStyle = dept.color; ctx.font = `bold 11px ${FONT}`;
  ctx.fillText(dept.label.toUpperCase(), 18, 13);
  px(ctx, 8, 6, 6, 6, dept.color); px(ctx, 10, 4, 2, 10, dept.color); px(ctx, 6, 8, 10, 2, dept.color); // rombo
  // borde
  ctx.strokeStyle = dept.color; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.strokeStyle = dept.color + '33'; ctx.lineWidth = 1; ctx.strokeRect(4.5, 4.5, w - 9, h - 9);
  return c;
}

// ---------- ventanal animado ----------
function drawWindow(ctx, room, dept, t) {
  const x = room.rect.x + WIN.x; const y = room.rect.y + WIN.y; const w = room.rect.w - 2 * WIN.x; const h = WIN.h;
  const seed = hash(dept.id);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#02030a'); g.addColorStop(1, '#0a1030');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  // nebulosa tenue
  ctx.fillStyle = dept.color + '14'; ctx.beginPath(); ctx.ellipse(x + w * ((seed % 70) / 100 + 0.1), y + h * 0.7, 46, 12, 0, 0, Math.PI * 2); ctx.fill();
  // estrellas con paralaje
  for (const [n, speed, size, alpha] of [[18, 3, 1, 0.45], [11, 8, 1, 0.8], [6, 18, 2, 1]]) {
    for (let i = 0; i < n; i++) {
      const sx = mod(rand01(seed, i, speed) * w - t * speed, w);
      const sy = rand01(seed, i + 40, speed) * (h - 2);
      const tw = 0.6 + 0.4 * Math.sin(t * 2 + i * 1.7);
      ctx.fillStyle = `rgba(255,255,255,${alpha * tw})`; ctx.fillRect(Math.floor(x + sx), Math.floor(y + sy), size, size);
    }
  }
  // planeta con anillo
  const pw = w + 80;
  const planetX = x + mod((seed % 200) - t * 1.6, pw) - 40;
  const planetY = y + 12 + (seed % 9);
  const pc = ['#c97a4a', '#4a8ac9', '#8ac94a', '#b36ac9', '#c9b34a', '#4ac9b3', '#c94a6a'][seed % 7];
  ctx.fillStyle = pc; ctx.beginPath(); ctx.arc(planetX, planetY, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#00000055'; ctx.beginPath(); ctx.arc(planetX + 4, planetY + 2, 8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(planetX, planetY, 17, 4, -0.3, 0, Math.PI * 2); ctx.stroke();
  // nave que cruza cada ~12 s
  const cyc = 12; const prog = mod(t + (seed % cyc), cyc) / cyc;
  if (prog < 0.5) {
    const sx = x - 12 + (prog / 0.5) * (w + 24); const sy = y + 6 + (seed % 14);
    px(ctx, sx - 10, sy + 1, 8, 1, '#4ae0ff55'); // estela
    px(ctx, sx - 2, sy, 8, 3, '#9aa4b8'); px(ctx, sx, sy - 2, 2, 7, '#7b8599'); px(ctx, sx + 6, sy + 1, 2, 1, '#e8f4ff'); px(ctx, sx - 3, sy + 1, 1, 1, '#4ae0ff');
  }
  // montantes del ventanal
  for (let bx = 72; bx < w; bx += 72) px(ctx, x + bx, y, 3, h, '#1a2038');
  ctx.restore();
  ctx.strokeStyle = dept.color + '66'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // luces de la pared pulsando
  for (let i = 0; i < 6; i++) {
    const on = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + i * 0.9 + seed));
    ctx.fillStyle = dept.color; ctx.globalAlpha = on; ctx.fillRect(room.rect.x + 14 + i * 46, room.rect.y + 56, 12, 2); ctx.globalAlpha = 1;
  }
}

// ---------- decoración temática (columna central entre escritorios) ----------
function drawProp(ctx, id, room, t) {
  const cx = room.rect.x + GAP.x + GAP.w / 2; const top = room.rect.y + 80; const base = room.rect.y + 196;
  const glow = (_c, col, a, r, x, y) => { const g = ctx.createRadialGradient(x, y, 1, x, y, r); g.addColorStop(0, col + a); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
  switch (id) {
    case 'mando': { // pedestal con globo holográfico
      px(ctx, cx - 9, base - 8, 18, 8, '#2a3150'); px(ctx, cx - 4, base - 30, 8, 22, '#1a2038');
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
      px(ctx, cx - 8, top + 16, 16, 4, '#2a3150'); px(ctx, cx - 2, top + 10, 4, 6, '#ff5a5a');
      break; }
    case 'flota': { // reactor con burbujas de plasma
      px(ctx, cx - 9, base - 6, 18, 6, '#2a3150'); px(ctx, cx - 9, top + 14, 18, 4, '#2a3150');
      px(ctx, cx - 6, top + 18, 12, base - top - 24, '#0a1a2e');
      glow(ctx, '#4aa3ff', '66', 34, cx, (top + base) / 2);
      for (let i = 0; i < 6; i++) { const by = base - 10 - mod(t * (14 + i * 3) + i * 19, base - top - 36); px(ctx, cx - 4 + ((i * 5) % 8), Math.round(by), 2, 2, '#9fd0ff'); }
      px(ctx, cx - 6, top + 18, 2, base - top - 24, '#ffffff22');
      break; }
    case 'diplomacia': { // estandarte y planta
      px(ctx, cx - 9, top - 14, 18, 3, '#8b6b3d');
      px(ctx, cx - 7, top - 11, 14, 46, '#8a2a2a'); px(ctx, cx - 7, top + 35, 7, 5, '#8a2a2a'); px(ctx, cx, top + 35, 7, 5, '#0a0e1c');
      px(ctx, cx - 3, top + 4, 6, 6, '#d9c7a0'); px(ctx, cx - 1, top + 2, 2, 10, '#d9c7a0'); px(ctx, cx - 5, top + 6, 10, 2, '#d9c7a0');
      px(ctx, cx - 7, base - 14, 14, 14, '#5b3b24'); px(ctx, cx - 7, base - 14, 14, 2, '#7a5233');
      const sw = Math.sin(t * 1.4) * 1.5;
      px(ctx, cx - 1 + sw, base - 30, 2, 16, '#3a8a4a'); px(ctx, cx - 7 + sw, base - 26, 6, 3, '#4aae5a'); px(ctx, cx + 1 + sw, base - 32, 6, 3, '#4aae5a');
      break; }
    case 'taller': { // cristal flotante sobre pedestal
      px(ctx, cx - 8, base - 8, 16, 8, '#2a3150'); px(ctx, cx - 3, base - 22, 6, 14, '#1a2038');
      const by = base - 46 + Math.sin(t * 1.6) * 3; glow(ctx, '#b18cff', '77', 24, cx, by);
      ctx.fillStyle = '#c9a8ff'; ctx.beginPath(); ctx.moveTo(cx, by - 12); ctx.lineTo(cx + 7, by); ctx.lineTo(cx, by + 12); ctx.lineTo(cx - 7, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff88'; ctx.beginPath(); ctx.moveTo(cx, by - 12); ctx.lineTo(cx + 3, by - 2); ctx.lineTo(cx, by); ctx.lineTo(cx - 4, by - 2); ctx.closePath(); ctx.fill();
      break; }
    case 'reconocimiento': { // antena de radar giratoria
      px(ctx, cx - 3, base - 70, 6, 70, '#1a2038'); px(ctx, cx - 9, base - 6, 18, 6, '#2a3150');
      const a = t * 1.4; const ry = base - 74;
      ctx.strokeStyle = '#9aa4b8'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 14, ry - Math.sin(a) * 4); ctx.lineTo(cx + Math.cos(a) * 14, ry + Math.sin(a) * 4); ctx.stroke();
      px(ctx, cx - 2, ry - 2, 4, 4, '#4ade80');
      glow(ctx, '#4ade80', '44', 22, cx, ry);
      break; }
    default: break;
  }
}

// ---------- escritorios ----------
function drawDeskBack(ctx, d, state, t, seed) {
  const mx = d.x + 70; const my = d.y + 6;
  px(ctx, mx + 12, my + 20, 8, 6, '#1a2038'); // pie
  px(ctx, mx, my, 34, 22, '#10152a'); px(ctx, mx + 1, my + 1, 32, 20, '#0a0e1c');
  const on = state != null;
  if (!on) { px(ctx, mx + 3, my + 3, 28, 16, '#0f1a2e'); if (Math.floor(t * 0.8 + seed) % 2) px(ctx, mx + 15, my + 10, 2, 2, '#2a6a8a'); return; }
  const col = state === 'failed' ? '#ff5a5a' : state === 'review' ? '#b18cff' : state === 'queued' ? '#9aa6cc' : '#4ae0ff';
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

function drawDeskFront(ctx, d, state, t) {
  px(ctx, d.x, d.y + 30, d.w, 8, '#7a5a3a'); px(ctx, d.x, d.y + 30, d.w, 1, '#a07a50'); // tablero
  px(ctx, d.x, d.y + 38, d.w, 14, '#4a3524'); px(ctx, d.x, d.y + 38, d.w, 1, '#2a1c10');
  px(ctx, d.x + 6, d.y + 38, 4, 14, '#35261a'); px(ctx, d.x + d.w - 10, d.y + 38, 4, 14, '#35261a');
  px(ctx, d.x + 16, d.y + 31, 28, 5, '#2a3042'); px(ctx, d.x + 17, d.y + 32, 26, 1, '#4a5470'); // teclado
  if (state === 'working' && Math.floor(t * 9) % 2) px(ctx, d.x + 20 + (Math.floor(t * 9) % 18), d.y + 33, 3, 1, '#4ae0ff');
  px(ctx, d.x + 54, d.y + 24, 6, 7, '#d9d9e0'); px(ctx, d.x + 60, d.y + 26, 2, 3, '#d9d9e0'); // taza
  if (state === 'working') { const s = Math.sin(t * 3); px(ctx, d.x + 56 + s, d.y + 19, 1, 3, '#ffffff55'); }
}

// ---------- sala de operaciones ----------
function drawOpsBack(ctx, room, stats, t) {
  const { x, y, w } = room.rect;
  const cx = x + w / 2; const cy = y + 150;
  const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 96); g.addColorStop(0, '#7dd3fc44'); g.addColorStop(1, '#7dd3fc00'); ctx.fillStyle = g; ctx.fillRect(cx - 100, cy - 100, 200, 200);
  px(ctx, cx - 56, cy + 22, 112, 14, '#1a2038'); px(ctx, cx - 50, cy + 18, 100, 6, '#2a3150'); // base de la holomesa
  // galaxia espiral giratoria
  for (let i = 0; i < 90; i++) {
    const arm = i % 3; const k = i / 90; const ang = t * 0.5 + k * 9 + arm * 2.09; const rad = 4 + k * 48;
    ctx.fillStyle = `rgba(125,211,252,${0.9 - k * 0.6})`; ctx.fillRect(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad * 0.38), 2, 2);
  }
  px(ctx, cx - 3, cy - 2, 6, 4, '#fff6c8');
  const a = t * 1.1; px(ctx, cx + Math.cos(a) * 62 - 2, cy + Math.sin(a) * 24 - 2, 5, 5, '#ffd84a');
  // panel de datos
  px(ctx, x + 14, y + 214, w - 28, 80, '#06101a'); ctx.strokeStyle = '#7dd3fc88'; ctx.lineWidth = 1; ctx.strokeRect(x + 14.5, y + 214.5, w - 29, 79);
  ctx.fillStyle = '#7dd3fc'; ctx.font = `11px ${FONT}`; ctx.textAlign = 'left';
  const lines = [
    `Claude   ${stats?.active.claude ?? 0}/${stats?.limit?.claude ?? 2} activos`,
    `Ollama   ${stats?.active.ollama ?? 0}/${stats?.limit?.ollama ?? 1} activos`,
    `En espera ${stats?.waiting ?? 0}`,
    `Costo hoy $${(stats?.costToday ?? 0).toFixed(2)}`,
  ];
  lines.forEach((l, i) => ctx.fillText(l, x + 24, y + 234 + i * 17));
  if (Math.floor(t * 2) % 2) px(ctx, x + w - 30, y + 224, 6, 6, '#4ade80');
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

function drawActor(ctx, a, t) {
  const pose = poseOf(a, t);
  if (a.seat !== 'desk' || a.walking) { // sombra en el suelo
    ctx.fillStyle = '#00000066'; ctx.beginPath(); ctx.ellipse(a.x, a.y - 1, 12, 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  const hop = a.walking && pose.leg === 1 ? -1 : 0;
  const sprite = getSprite(a.dept, a.agent, pose);
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
  let layout = layoutOffice([], []);
  const actors = new Map();
  const layers = new Map();
  let hover = null;
  let raf = 0;
  let last = 0;

  const layerFor = (room, dept) => {
    if (!layers.has(room.id)) layers.set(room.id, buildRoomLayer(dept ?? OPS_ROOM, room.rect.w, room.rect.h, !dept));
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

    ctx.fillStyle = '#05060c'; ctx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    const drawables = [];
    for (const room of layout.rooms) {
      const dept = DEPARTMENTS.find((d) => d.id === room.id);
      ctx.drawImage(layerFor(room, dept), room.rect.x, room.rect.y);
      if (!dept) { drawWindow(ctx, room, OPS_ROOM, t); drawOpsBack(ctx, room, model.stats, t); continue; }
      drawWindow(ctx, room, dept, t);
      drawProp(ctx, room.id, room, t);
      // estado de cada escritorio según quién lo ocupa
      const sitting = [...actors.values()].filter((a) => a.dept === room.id && a.seat === 'desk');
      room.desks.forEach((d, i) => {
        const occupant = sitting.find((a) => Math.abs(a.home.x - (d.x + 34)) < 1 && Math.abs(a.home.y - (d.y + 44)) < 1);
        const st = occupant?.state ?? null;
        drawDeskBack(ctx, d, st, t, i);
        drawables.push({ y: d.y + d.h, draw: () => drawDeskFront(ctx, d, st, t) });
      });
    }
    for (const a of actors.values()) drawables.push({ y: a.y, draw: () => drawActor(ctx, a, t), fx: () => drawEffects(ctx, a, t) });
    drawables.sort((p, q) => p.y - q.y);
    for (const d of drawables) d.draw();
    for (const d of drawables) d.fx?.();

    if (hover) {
      const a = actors.get(hover);
      if (a) {
        const text = `${a.agent} · ${a.state === 'idle' ? 'libre' : { working: 'trabajando', queued: 'en cola', review: 'por revisar', failed: 'falló' }[a.state]}`;
        ctx.font = `bold 11px ${FONT}`; ctx.textAlign = 'left';
        const tw = ctx.measureText(text).width + 12;
        const tx = Math.max(2, Math.min(a.x - tw / 2, CANVAS.w - tw - 2)); const ty = Math.max(2, a.y - CHAR.h - 34);
        px(ctx, tx, ty, tw, 18, '#000e'); ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 1; ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, 17);
        ctx.fillStyle = '#ffd84a'; ctx.fillText(text, tx + 6, ty + 13);
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
    if (a.taskId) onSelect?.(a.taskId); else onSelectAgent?.(a.agent);
  });

  return {
    update(next) { model = { ...model, ...next }; layout = layoutOffice(model.agents, model.tasks); sync(); if (reduced) draw(); },
    start() { cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(draw); if (reduced) draw(); },
    stop() { cancelAnimationFrame(raf); },
    get layout() { return layout; },
    get actors() { return actors; },
  };
}
