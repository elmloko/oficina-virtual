// Renderizado pixel-art 2D de la oficina (Canvas). Todo el arte es procedural y original.
import { CANVAS, DEPARTMENTS, OPS_ROOM, DESK, layoutOffice } from './office-layout.js';

const S = 2; // escala del sprite: cada "pixel" del personaje mide 2x2
const SKINS = ['#f1c9a5', '#d9a577', '#a9744f', '#7a4e32', '#c8d4dc'];
const PALETTE = {
  mando: { suit: '#2c3e73', accent: '#ffd84a', head: 'cap' },
  hangar: { suit: '#e8742a', accent: '#fff2cf', head: 'helmet' },
  inteligencia: { suit: '#3a3f4d', accent: '#ff5a5a', head: 'scout' },
  flota: { suit: '#2b6cb0', accent: '#ffe066', head: 'goggles' },
  diplomacia: { suit: '#d9c7a0', accent: '#8b6b3d', head: 'hood' },
  taller: { suit: '#7c5cbf', accent: '#7dd3fc', head: 'droid' },
  reconocimiento: { suit: '#2f855a', accent: '#c6f6d5', head: 'probe' },
};
const STATE_COLOR = { working: '#4aa3ff', queued: '#8591b8', review: '#b18cff', failed: '#ff5a5a' };

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

function drawCharacter(ctx, ch, frame) {
  const pal = PALETTE[ch.dept] ?? PALETTE.hangar;
  const skin = SKINS[hash(ch.agent) % SKINS.length];
  const x = ch.x - 5 * S; // sprite de 10 px de ancho
  const y = ch.y - 14 * S; // sprite de 14 px de alto
  const p = (dx, dy, w, h, c) => px(ctx, x + dx * S, y + dy * S, w * S, h * S, c);
  const working = ch.state === 'working';
  const bob = working ? frame : 0;
  const sitting = ch.seat === 'desk';
  const idleBob = !sitting && ch.state === 'idle' ? (frame && hash(ch.agent) % 2 ? 1 : 0) : 0;
  const oy = idleBob;

  ctx.fillStyle = '#0006'; // sombra
  ctx.fillRect(x + 1 * S, ch.y - 1, 8 * S, 2);

  // piernas
  p(2, 11 + oy, 2, 3 - oy, '#1b1f2e'); p(6, 11 + oy, 2, 3 - oy, '#1b1f2e');
  // torso y brazos
  p(2, 6 + oy, 6, 5, pal.suit);
  p(2, 6 + oy, 6, 1, pal.accent);
  p(0, 6 + oy + (working ? bob : 0), 2, 4, pal.suit); p(8, 6 + oy + (working ? 1 - bob : 0), 2, 4, pal.suit);
  p(0, 10 + oy + (working ? bob : 0), 2, 1, skin); p(8, 10 + oy + (working ? 1 - bob : 0), 2, 1, skin);

  // cabeza según departamento
  switch (pal.head) {
    case 'cap': p(2, 0 + oy, 6, 6, skin); p(2, 0 + oy, 6, 2, '#1a2447'); p(4, 0 + oy, 2, 1, pal.accent); p(3, 3 + oy, 1, 1, '#111'); p(6, 3 + oy, 1, 1, '#111'); break;
    case 'helmet': p(2, 0 + oy, 6, 6, pal.suit); p(3, 2 + oy, 4, 2, '#8fd3ff'); p(2, 0 + oy, 6, 1, pal.accent); p(3, 4 + oy, 4, 2, skin); break;
    case 'scout': p(2, 0 + oy, 6, 6, '#d8dde6'); p(3, 2 + oy, 4, 1, pal.accent); p(3, 3 + oy, 4, 1, '#222'); p(3, 4 + oy, 4, 2, '#d8dde6'); break;
    case 'goggles': p(2, 0 + oy, 6, 2, '#f2c94c'); p(2, 2 + oy, 6, 4, skin); p(2, 3 + oy, 6, 1, '#222'); p(3, 3 + oy, 1, 1, pal.accent); p(6, 3 + oy, 1, 1, pal.accent); break;
    case 'hood': p(1, 0 + oy, 8, 2, pal.suit); p(1, 2 + oy, 2, 4, pal.suit); p(7, 2 + oy, 2, 4, pal.suit); p(3, 2 + oy, 4, 4, skin); p(4, 3 + oy, 1, 1, '#111'); p(6, 3 + oy, 1, 1, '#111'); break;
    case 'droid': p(2, 1 + oy, 6, 5, '#c9ced6'); p(3, 0 + oy, 4, 1, '#c9ced6'); p(3, 3 + oy, 2, 2, pal.accent); p(6, 3 + oy, 1, 1, pal.suit); break;
    default: p(2, 2 + oy, 6, 4, '#aab2bf'); p(4, 0 + oy, 2, 2, pal.accent); p(3, 1 + oy, 4, 1, '#aab2bf'); p(4, 3 + oy, 2, 2, '#ff5a5a'); // sonda
  }
}

function drawBadge(ctx, ch, frame) {
  if (ch.state === 'idle') return;
  const color = STATE_COLOR[ch.state];
  const x = ch.x;
  const y = ch.y - 14 * S - 8;
  ctx.fillStyle = color;
  ctx.font = 'bold 12px "Cascadia Mono", Consolas, monospace';
  ctx.textAlign = 'center';
  const text = ch.state === 'working' ? '.'.repeat(1 + (frame % 3)) : { queued: 'z', review: '!', failed: '✕' }[ch.state];
  ctx.fillText(text, x, y);
}

function drawRoom(ctx, room, dept, tick, frame) {
  const { x, y, w, h } = room.rect;
  // suelo tipo placa metálica
  for (let ty = 0; ty < h; ty += 16) for (let tx = 0; tx < w; tx += 16) {
    px(ctx, x + tx, y + ty, 16, 16, (tx / 16 + ty / 16) % 2 ? '#11162a' : '#0e1325');
  }
  // ventanal al espacio
  px(ctx, x, y, w, 22, '#05060d');
  for (let i = 0; i < 14; i++) { const sx = x + ((hash(dept.id) * (i + 3) * 37) % (w - 4)); px(ctx, sx, y + 4 + ((i * 7 + hash(dept.id)) % 14), 2, 2, i % 3 ? '#fff9' : dept.color); }
  // borde y rótulo
  ctx.strokeStyle = dept.color; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  px(ctx, x + 2, y + 2, w - 4, 16, '#000b');
  ctx.fillStyle = dept.color; ctx.font = 'bold 11px "Cascadia Mono", Consolas, monospace'; ctx.textAlign = 'left';
  ctx.fillText(dept.label.toUpperCase(), x + 8, y + 14);
  // zona de descanso
  px(ctx, x + 8, y + 218, w - 16, 2, dept.color + '55');
  ctx.fillStyle = '#8591b8'; ctx.font = '9px "Cascadia Mono", Consolas, monospace';
  ctx.fillText('descanso', x + w - 56, y + 216);
  for (const d of room.desks) drawDesk(ctx, d, dept, tick, frame);
}

function drawDesk(ctx, d, dept, tick, frame) {
  px(ctx, d.x, d.y + 22, d.w, d.h - 22, '#5b3b24'); // mesa
  px(ctx, d.x, d.y + 22, d.w, 4, '#7a5233');
  px(ctx, d.x + d.w / 2 - 20, d.y, 40, 24, '#1b1f2e'); // monitor
  const glow = d.occupied ? (frame ? '#4ade80' : '#22c55e') : '#243049';
  px(ctx, d.x + d.w / 2 - 17, d.y + 3, 34, 16, glow);
  if (d.occupied) for (let i = 0; i < 4; i++) px(ctx, d.x + d.w / 2 - 14, d.y + 5 + i * 3, 10 + ((tick + i * 3) % 14), 1, '#0b3d1f');
  px(ctx, d.x + d.w / 2 - 4, d.y + 24, 8, 3, '#1b1f2e');
  px(ctx, d.x + 8, d.y + 30, 18, 5, '#9aa4b8'); // teclado
}

function drawOps(ctx, room, stats, tick) {
  const { x, y, w, h } = room.rect;
  for (let ty = 0; ty < h; ty += 16) for (let tx = 0; tx < w; tx += 16) px(ctx, x + tx, y + ty, 16, 16, (tx / 16 + ty / 16) % 2 ? '#0d1a26' : '#0a1620');
  ctx.strokeStyle = OPS_ROOM.color; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  px(ctx, x + 2, y + 2, w - 4, 16, '#000b');
  ctx.fillStyle = OPS_ROOM.color; ctx.font = 'bold 11px "Cascadia Mono", Consolas, monospace'; ctx.textAlign = 'left';
  ctx.fillText(OPS_ROOM.label.toUpperCase(), x + 8, y + 14);
  // holomesa
  const cx = x + w / 2; const cy = y + 120;
  for (let r = 0; r < 4; r++) { ctx.strokeStyle = `rgba(125,211,252,${0.9 - r * 0.2})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(cx, cy, 30 + r * 14, 10 + r * 5, 0, 0, Math.PI * 2); ctx.stroke(); }
  const a = tick / 12; // planeta que orbita
  px(ctx, cx - 6, cy - 6, 12, 12, '#7dd3fc'); px(ctx, cx + Math.cos(a) * 58 - 3, cy + Math.sin(a) * 25 - 3, 6, 6, '#ffd84a');
  ctx.fillStyle = '#cfe9ff'; ctx.font = '11px "Cascadia Mono", Consolas, monospace';
  const lines = [
    `Claude  ${stats?.active.claude ?? 0}/${stats?.limit?.claude ?? 2} activos`,
    `Ollama  ${stats?.active.ollama ?? 0}/${stats?.limit?.ollama ?? 1} activos`,
    `En espera: ${stats?.waiting ?? 0}`,
    `Costo hoy: $${(stats?.costToday ?? 0).toFixed(2)}`,
  ];
  lines.forEach((l, i) => ctx.fillText(l, x + 22, y + 206 + i * 18));
}

export function createOffice(canvas, { onSelect, onSelectAgent } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS.w; canvas.height = CANVAS.h;
  ctx.imageSmoothingEnabled = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let model = { agents: [], tasks: [], stats: null };
  let layout = layoutOffice([], []);
  let hover = null;
  let raf = 0;

  function draw(now = 0) {
    const tick = Math.floor(now / 120);
    const frame = reduced ? 0 : Math.floor(now / 350) % 2;
    ctx.fillStyle = '#07090f'; ctx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    for (const room of layout.rooms) {
      const dept = DEPARTMENTS.find((d) => d.id === room.id);
      if (dept) drawRoom(ctx, room, dept, reduced ? 0 : tick, frame); else drawOps(ctx, room, model.stats, reduced ? 0 : tick);
    }
    const ordered = [...layout.chars].sort((a, b) => a.y - b.y); // los de abajo se pintan encima
    for (const ch of ordered) { drawCharacter(ctx, ch, frame); drawBadge(ctx, ch, tick % 3); }
    if (hover) {
      const text = `${hover.agent} · ${hover.state === 'idle' ? 'libre' : hover.state}`;
      ctx.font = 'bold 11px "Cascadia Mono", Consolas, monospace'; ctx.textAlign = 'left';
      const tw = ctx.measureText(text).width + 10;
      const tx = Math.min(hover.x - tw / 2, CANVAS.w - tw - 2); const ty = hover.y - 14 * S - 24;
      px(ctx, Math.max(2, tx), ty, tw, 16, '#000e'); ctx.fillStyle = '#ffd84a'; ctx.fillText(text, Math.max(2, tx) + 5, ty + 12);
    }
    if (!reduced) raf = requestAnimationFrame(draw);
  }

  const hit = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (CANVAS.w / r.width);
    const y = (ev.clientY - r.top) * (CANVAS.h / r.height);
    return layout.chars.find((c) => x >= c.x - 5 * S && x <= c.x + 5 * S && y >= c.y - 14 * S && y <= c.y);
  };
  canvas.addEventListener('mousemove', (ev) => { hover = hit(ev) ?? null; canvas.style.cursor = hover ? 'pointer' : 'default'; if (reduced) draw(); });
  canvas.addEventListener('mouseleave', () => { hover = null; if (reduced) draw(); });
  canvas.addEventListener('click', (ev) => {
    const c = hit(ev);
    if (!c) return;
    if (c.taskId) onSelect?.(c.taskId); else onSelectAgent?.(c.agent);
  });

  const api = {
    update(next) { model = { ...model, ...next }; layout = layoutOffice(model.agents, model.tasks); if (reduced) draw(); },
    start() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); if (reduced) draw(); },
    stop() { cancelAnimationFrame(raf); },
    get layout() { return layout; },
  };
  return api;
}
