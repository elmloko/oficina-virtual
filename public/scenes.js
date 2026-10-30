// Escenas animadas del ventanal de cada sala y emblemas de cada skin (Canvas 2D, sin DOM propio).
// Cada escena se dibuja dentro del rectángulo (x, y, w, h) con h = 34 px; quien llama ya aplicó el recorte.
const rand01 = (seed, a, b = 0) => { const v = Math.sin(seed * 12.9898 + a * 78.233 + b * 37.719) * 43758.5453; return v - Math.floor(v); };
const mod = (a, n) => ((a % n) + n) % n;
const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

function gradient(ctx, x, y, h, stops) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  for (const [at, col] of stops) g.addColorStop(at, col);
  return g;
}

function sky(ctx, x, y, w, h, stops) { ctx.fillStyle = gradient(ctx, x, y, h, stops); ctx.fillRect(x, y, w, h); }

function glow(ctx, col, a, r, cx, cy) {
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
  g.addColorStop(0, col + a); g.addColorStop(1, col + '00');
  ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function stars(ctx, x, y, w, h, t, seed, layers = [[18, 3, 1, 0.45], [11, 8, 1, 0.8], [6, 18, 2, 1]], limit = h - 2) {
  for (const [n, speed, size, alpha] of layers) {
    for (let i = 0; i < n; i++) {
      const sx = mod(rand01(seed, i, speed) * w - t * speed, w);
      const sy = rand01(seed, i + 40, speed) * limit;
      const tw = 0.6 + 0.4 * Math.sin(t * 2 + i * 1.7);
      ctx.fillStyle = `rgba(255,255,255,${alpha * tw})`; ctx.fillRect(Math.floor(x + sx), Math.floor(y + sy), size, size);
    }
  }
}

/** Partículas que caen/suben: n puntos con velocidad (vx, vy) en px/s y envoltura dentro de la ventana. */
function drift(ctx, x, y, w, h, t, seed, n, vx, vy, col, size = 1, sway = 0) {
  ctx.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const k = 0.6 + rand01(seed, i, 3) * 0.8;
    const sx = mod(rand01(seed, i, 1) * w + t * vx * k + Math.sin(t * 0.9 + i) * sway, w);
    const sy = mod(rand01(seed, i, 2) * h + t * vy * k, h);
    ctx.fillRect(Math.floor(x + sx), Math.floor(y + sy), size, size);
  }
}

// ---------- escenas ----------
function space(ctx, x, y, w, h, t, seed, dept) {
  sky(ctx, x, y, w, h, [[0, '#02030a'], [1, '#0a1030']]);
  ctx.fillStyle = dept.color + '14'; ctx.beginPath(); ctx.ellipse(x + w * ((seed % 70) / 100 + 0.1), y + h * 0.7, 46, 12, 0, 0, Math.PI * 2); ctx.fill();
  stars(ctx, x, y, w, h, t, seed);
  const pw = w + 80;
  const planetX = x + mod((seed % 200) - t * 1.6, pw) - 40;
  const planetY = y + 12 + (seed % 9);
  const pc = ['#c97a4a', '#4a8ac9', '#8ac94a', '#b36ac9', '#c9b34a', '#4ac9b3', '#c94a6a'][seed % 7];
  ctx.fillStyle = pc; ctx.beginPath(); ctx.arc(planetX, planetY, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#00000055'; ctx.beginPath(); ctx.arc(planetX + 4, planetY + 2, 8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(planetX, planetY, 17, 4, -0.3, 0, Math.PI * 2); ctx.stroke();
  const cyc = 12; const prog = mod(t + (seed % cyc), cyc) / cyc;
  if (prog < 0.5) {
    const sx = x - 12 + (prog / 0.5) * (w + 24); const sy = y + 6 + (seed % 14);
    px(ctx, sx - 10, sy + 1, 8, 1, '#4ae0ff55');
    px(ctx, sx - 2, sy, 8, 3, '#9aa4b8'); px(ctx, sx, sy - 2, 2, 7, '#7b8599'); px(ctx, sx + 6, sy + 1, 2, 1, '#e8f4ff'); px(ctx, sx - 3, sy + 1, 1, 1, '#4ae0ff');
  }
}

function deathstar(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#010208'], [1, '#0a0c18']]);
  stars(ctx, x, y, w, h, t, seed, [[22, 2, 1, 0.5], [9, 6, 1, 0.9]]);
  const cx = x + 50 + (seed % Math.max(1, w - 130)); const cy = y + 17; const R = 17;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#7a7f8c'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.fillStyle = '#00000077'; ctx.beginPath(); ctx.arc(cx + 7, cy + 4, R, 0, Math.PI * 2); ctx.fill(); // sombra
  ctx.fillStyle = '#2a2d38'; ctx.fillRect(cx - R, cy + 1, R * 2, 2); // trinchera ecuatorial
  for (let i = 0; i < 14; i++) px(ctx, cx - R + rand01(seed, i) * R * 2, cy - R + rand01(seed, i, 9) * R * 2, 2, 1, '#b8bcc8aa'); // luces de superficie
  ctx.restore();
  const dx = cx - 6; const dy = cy - 6; // plato del superláser
  ctx.fillStyle = '#3a3d48'; ctx.beginPath(); ctx.arc(dx, dy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#9aa0b0'; ctx.beginPath(); ctx.arc(dx, dy, 2, 0, Math.PI * 2); ctx.fill();
  const pulse = mod(t, 7) < 0.8 ? 0.6 + 0.4 * Math.sin(t * 20) : 0;
  if (pulse) glow(ctx, '#7aff9a', 'cc', 9, dx, dy);
  for (let k = 0; k < 2; k++) { // cazas TIE
    const cyc = 9; const prog = mod(t + k * 4.5 + (seed % 5), cyc) / cyc;
    const tx = x + w + 10 - prog * (w + 30); const ty = y + 6 + k * 15 + (seed % 4);
    px(ctx, tx, ty - 3, 1, 7, '#8a909c'); px(ctx, tx + 5, ty - 3, 1, 7, '#8a909c'); px(ctx, tx + 1, ty, 4, 1, '#6a707c'); px(ctx, tx + 2, ty - 1, 2, 3, '#aab0bc');
  }
}

function yavin(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#0e3a4a'], [0.6, '#2a8a78'], [1, '#6ac8a0']]);
  stars(ctx, x, y, w, h, t, seed, [[10, 1, 1, 0.5]], 14);
  const gx = x + w * 0.74; const gy = y + 6; // gigante gaseoso
  ctx.save(); ctx.beginPath(); ctx.arc(gx, gy, 26, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#d98a4a'; ctx.fillRect(gx - 26, gy - 26, 52, 52);
  for (const [oy, c] of [[-4, '#b8683a'], [3, '#f0b070'], [9, '#a85a30'], [15, '#e0a060']]) { ctx.fillStyle = c; ctx.fillRect(gx - 26, gy + oy, 52, 3); }
  ctx.fillStyle = '#00000055'; ctx.beginPath(); ctx.arc(gx - 9, gy + 5, 26, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  for (let layer = 0; layer < 2; layer++) { // selva con paralaje
    ctx.fillStyle = layer ? '#0e3a22' : '#1a5a34';
    const base = y + h - (layer ? 5 : 10);
    for (let cx = 0; cx < w + 8; cx += 4) {
      const sx = mod(cx - t * (layer ? 3 : 1.2), w + 8) - 4;
      const hh = (layer ? 6 : 8) + Math.floor(rand01(seed + layer, cx) * 6);
      ctx.fillRect(x + sx, base - hh + (layer ? 5 : 10), 5, hh + 2);
    }
  }
  const tx = x + 26; const ty = y + h - 14; // templo massassi
  px(ctx, tx, ty + 6, 22, 6, '#2c3a2c'); px(ctx, tx + 3, ty + 3, 16, 3, '#34443a'); px(ctx, tx + 7, ty, 8, 3, '#3c4c3a'); px(ctx, tx + 10, ty - 2, 2, 2, '#5ac8ff');
  const cyc = 11; const prog = mod(t + (seed % cyc), cyc) / cyc;
  if (prog < 0.55) { // X-Wing
    const sx = x - 14 + (prog / 0.55) * (w + 28); const sy = y + 8 + (seed % 9);
    px(ctx, sx - 12, sy + 1, 10, 1, '#ff7a3a66'); px(ctx, sx - 2, sy, 10, 2, '#cfd6e4'); px(ctx, sx + 6, sy, 3, 1, '#4a5a6a');
    px(ctx, sx - 1, sy - 3, 5, 1, '#9aa4b8'); px(ctx, sx - 1, sy + 3, 5, 1, '#9aa4b8'); px(ctx, sx - 3, sy - 3, 1, 1, '#ff5a3a'); px(ctx, sx - 3, sy + 3, 1, 1, '#ff5a3a');
  }
}

function tatooine(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#2a1a4a'], [0.45, '#b8502a'], [1, '#f0a040']]);
  const s1x = x + w * 0.3; const s1y = y + 17;
  glow(ctx, '#ffd070', '88', 26, s1x, s1y);
  ctx.fillStyle = '#fff2c0'; ctx.beginPath(); ctx.arc(s1x, s1y, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd8a0'; ctx.beginPath(); ctx.arc(s1x + 16, s1y - 7, 4.5, 0, Math.PI * 2); ctx.fill();
  for (const [layer, col, amp, ph] of [[0, '#8a4420', 5, 0], [1, '#4a2410', 7, 2]]) {
    ctx.fillStyle = col;
    for (let cx = 0; cx < w; cx += 2) {
      const hh = 9 + amp + amp * Math.sin(cx / (layer ? 31 : 22) + ph + (seed % 7));
      ctx.fillRect(x + cx, y + h - hh + (layer ? 0 : 3), 2, hh);
    }
  }
  const vx = x + w * 0.62; // vaporador de humedad
  px(ctx, vx, y + h - 17, 2, 12, '#2a1608'); px(ctx, vx - 2, y + h - 17, 6, 1, '#2a1608'); px(ctx, vx - 2, y + h - 14, 6, 1, '#2a1608'); px(ctx, vx - 2, y + h - 11, 6, 1, '#2a1608');
  drift(ctx, x, y + 12, w, h - 12, t, seed, 16, 46, 2, '#f0c08088', 1, 1);
  const cyc = 14; const prog = mod(t + (seed % cyc), cyc) / cyc;
  if (prog < 0.5) { // speeder
    const sx = x - 14 + (prog / 0.5) * (w + 28); const sy = y + h - 12 + Math.sin(t * 5) * 0.7;
    px(ctx, sx - 8, sy + 1, 7, 1, '#ffd07055'); px(ctx, sx, sy, 11, 3, '#b8a888'); px(ctx, sx + 6, sy - 2, 4, 2, '#6a8aa0'); px(ctx, sx - 1, sy + 1, 1, 1, '#ffd070');
  }
}

function coruscant(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#0a0c24'], [0.7, '#2a1a48'], [1, '#6a3050']]);
  stars(ctx, x, y, w, h, t, seed, [[8, 1, 1, 0.5]], 10);
  for (const [layer, col, minH, maxH] of [[0, '#141a38', 8, 22], [1, '#0a0e22', 12, 30]]) {
    let cx = layer ? 3 : 0; let i = 0;
    while (cx < w) {
      const bw = 6 + Math.floor(rand01(seed + layer, i, 1) * 9);
      const bh = minH + Math.floor(rand01(seed + layer, i, 2) * (maxH - minH));
      px(ctx, x + cx, y + h - bh, bw, bh, col);
      if (layer) {
        for (let wy = y + h - bh + 2; wy < y + h - 2; wy += 3) for (let wx = x + cx + 1; wx < x + cx + bw - 1; wx += 3) {
          const k = rand01(seed, wx, wy);
          if (k > 0.55) { const flick = k > 0.97 && Math.floor(t * 2 + wx) % 2; if (!flick) px(ctx, wx, wy, 1, 1, k > 0.8 ? '#ffd88a' : '#8ac8ff'); }
        }
        if (i % 4 === 0) px(ctx, x + cx + Math.floor(bw / 2), y + h - bh - 3, 1, 3, '#ff4a4a');
      }
      cx += bw + (layer ? 2 : 0); i++;
    }
  }
  for (let lane = 0; lane < 3; lane++) { // tráfico aéreo
    const dir = lane % 2 ? -1 : 1; const ly = y + 7 + lane * 6;
    for (let i = 0; i < 4; i++) {
      const sx = mod(rand01(seed, i, lane) * w + dir * t * (14 + lane * 9), w);
      const bright = lane % 2 ? '#ffb050' : '#ffffff';
      ctx.globalAlpha = 0.35; ctx.fillStyle = bright; ctx.fillRect(Math.floor(x + sx - dir * 5), ly, 5, 1);
      ctx.globalAlpha = 1; ctx.fillRect(Math.floor(x + sx), ly, 2, 1);
    }
  }
}

function hoth(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#7a9ec0'], [1, '#e4f0fa']]);
  ctx.fillStyle = '#6a8aae';
  for (let cx = 0; cx < w; cx += 3) {
    const hh = 8 + 9 * Math.abs(Math.sin(cx / 37 + (seed % 5))) + 3 * Math.sin(cx / 9);
    ctx.fillRect(x + cx, y + h - 6 - hh, 3, hh);
  }
  ctx.fillStyle = '#ffffff55';
  for (let cx = 0; cx < w; cx += 3) { const hh = 8 + 9 * Math.abs(Math.sin(cx / 37 + (seed % 5))) + 3 * Math.sin(cx / 9); ctx.fillRect(x + cx, y + h - 6 - hh, 3, 2); }
  px(ctx, x, y + h - 6, w, 6, '#f4f9fd'); px(ctx, x, y + h - 6, w, 1, '#c8dcee');
  const cyc = 46; const prog = mod(t + (seed % cyc), cyc) / cyc; // AT-AT caminando
  const ax = x - 34 + prog * (w + 68); const gy = y + h - 5;
  const step = Math.sin(t * 2.6) * 1.5;
  ctx.fillStyle = '#5a626c';
  for (const [lx, ph] of [[2, 0], [7, Math.PI], [17, Math.PI], [22, 0]]) { ctx.fillRect(Math.round(ax + lx), gy - 14, 2, 14 + Math.round(Math.sin(t * 2.6 + ph) * 1)); }
  px(ctx, ax, gy - 20 - Math.round(Math.abs(step) * 0.3), 25, 7, '#7a828c'); px(ctx, ax, gy - 20 - Math.round(Math.abs(step) * 0.3), 25, 1, '#9aa2ac');
  px(ctx, ax + 22, gy - 25, 8, 6, '#848c96'); px(ctx, ax + 28, gy - 23, 2, 2, '#ff5a3a'); px(ctx, ax + 24, gy - 19, 1, 4, '#3a424c');
  drift(ctx, x, y, w, h, t, seed, 34, 9, 15, '#ffffff', 1, 3);
  drift(ctx, x, y, w, h, t, seed + 5, 10, 14, 24, '#ffffffcc', 2, 4);
}

function nevarro(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#241008'], [0.6, '#6a2c14'], [1, '#c0662a']]);
  for (const [vx, vw, vh] of [[0.18, 52, 22], [0.62, 64, 26]]) { // volcanes
    const cx = x + w * vx; const top = y + h - vh;
    ctx.fillStyle = '#1a0c08'; ctx.beginPath(); ctx.moveTo(cx - vw / 2, y + h); ctx.lineTo(cx - 6, top); ctx.lineTo(cx + 6, top); ctx.lineTo(cx + vw / 2, y + h); ctx.closePath(); ctx.fill();
    glow(ctx, '#ff7a2a', 'aa', 16, cx, top);
    px(ctx, cx - 5, top, 10, 2, '#ff9a3a'); px(ctx, cx - 1 + Math.sin(t + vx) * 2, top + 3, 1, 8, '#ff6a1a99');
  }
  px(ctx, x, y + h - 5, w, 5, '#140a06');
  drift(ctx, x, y, w, h, t, seed, 14, 6, 7, '#8a7a72aa', 2, 3); // ceniza
  drift(ctx, x, y, w, h, t, seed + 3, 12, 4, -14, '#ffa040', 1, 4); // brasas
  const cyc = 16; const prog = mod(t + (seed % cyc), cyc) / cyc;
  if (prog < 0.55) { // Razor Crest
    const sx = x - 22 + (prog / 0.55) * (w + 44); const sy = y + 6 + (seed % 8) + Math.sin(t * 2) * 1.2;
    px(ctx, sx - 8, sy + 2, 7, 1, '#ffb04a66'); px(ctx, sx, sy, 16, 5, '#6a6a72'); px(ctx, sx + 12, sy + 1, 5, 3, '#8a8a92'); px(ctx, sx + 4, sy - 3, 3, 3, '#5a5a62');
    px(ctx, sx + 2, sy + 5, 5, 2, '#4a4a52'); px(ctx, sx + 14, sy + 2, 2, 1, '#4aa3ff'); px(ctx, sx - 1, sy + 1, 1, 3, '#ffb04a');
  }
}

function mustafar(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#050204'], [0.55, '#3a0806'], [1, '#c0300a']]);
  ctx.fillStyle = '#0a0304';
  for (let cx = 0; cx < w; cx += 9) { // agujas de roca
    const hh = 10 + Math.floor(rand01(seed, cx) * 16);
    ctx.beginPath(); ctx.moveTo(x + cx, y + h - 6); ctx.lineTo(x + cx + 4, y + h - 6 - hh); ctx.lineTo(x + cx + 9, y + h - 6); ctx.closePath(); ctx.fill();
  }
  px(ctx, x, y + h - 7, w, 7, '#ff5a1a'); // río de lava
  for (let i = 0; i < 26; i++) px(ctx, x + mod(rand01(seed, i) * w - t * (6 + (i % 5) * 3), w), y + h - 6 + (i % 5), 3, 1, i % 3 ? '#ffd070' : '#ff9a3a');
  for (let i = 0; i < 6; i++) px(ctx, x + mod(rand01(seed, i, 7) * w - t * 4, w), y + h - 5 + (i % 3), 6, 2, '#3a0a04');
  drift(ctx, x, y, w, h, t, seed, 18, 3, -16, '#ff8a2a', 1, 4);
  const slot = Math.floor(t / 4);
  if (rand01(seed, slot) > 0.55 && mod(t, 4) < 0.18) { // relámpago
    const bx = x + rand01(seed, slot, 5) * w;
    ctx.fillStyle = 'rgba(255,230,210,0.22)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#fff2e0'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx - 3, y + 9); ctx.lineTo(bx + 2, y + 15); ctx.lineTo(bx - 2, y + 24); ctx.stroke();
  }
}

function scarif(ctx, x, y, w, h, t, seed) {
  sky(ctx, x, y, w, h, [[0, '#2a90c8'], [0.6, '#a8e4f0'], [1, '#d8f4f8']]);
  ctx.fillStyle = '#ffffffcc';
  for (let i = 0; i < 3; i++) { const cx = x + mod(rand01(seed, i) * w + t * (1.5 + i * 0.6), w + 40) - 20; ctx.beginPath(); ctx.ellipse(cx, y + 6 + i * 4, 13 + i * 3, 3, 0, 0, Math.PI * 2); ctx.fill(); }
  const sdx = x + mod((seed % 90) + t * 5, w + 110) - 70; const sdy = y + 8; // Destructor Estelar
  ctx.fillStyle = '#9aa4b0'; ctx.beginPath(); ctx.moveTo(sdx + 64, sdy + 4); ctx.lineTo(sdx, sdy); ctx.lineTo(sdx, sdy + 9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#6a727e'; ctx.beginPath(); ctx.moveTo(sdx + 64, sdy + 4); ctx.lineTo(sdx, sdy + 5); ctx.lineTo(sdx, sdy + 9); ctx.closePath(); ctx.fill();
  px(ctx, sdx + 2, sdy - 2, 8, 2, '#8a929e'); px(ctx, sdx + 4, sdy - 4, 4, 2, '#aab2bc'); px(ctx, sdx - 1, sdy + 3, 1, 3, '#7ad8ff');
  px(ctx, x, y + 21, w, 7, '#1e90b8'); // océano
  for (let i = 0; i < 18; i++) { const sh = 0.5 + 0.5 * Math.sin(t * 2 + i * 2.1); ctx.fillStyle = `rgba(255,255,255,${0.5 * sh})`; ctx.fillRect(Math.floor(x + rand01(seed, i, 4) * w), y + 22 + (i % 5), 3, 1); }
  px(ctx, x, y + 28, w, 6, '#f0e0b0'); px(ctx, x, y + 28, w, 1, '#ffffffaa');
  ctx.strokeStyle = '#1a3a22'; ctx.lineWidth = 1;
  for (const px0 of [0.12, 0.45, 0.83]) { // palmeras
    const bx = x + w * px0; const sway = Math.sin(t * 1.2 + px0 * 9) * 1.5;
    ctx.beginPath(); ctx.moveTo(bx, y + h); ctx.quadraticCurveTo(bx + 2, y + 24, bx + sway, y + 17); ctx.stroke();
    for (const a of [-1.2, -0.5, 0.5, 1.2]) { ctx.beginPath(); ctx.moveTo(bx + sway, y + 17); ctx.lineTo(bx + sway + Math.sin(a) * 8, y + 17 + Math.abs(Math.cos(a)) * 4 + 1); ctx.stroke(); }
  }
}

export const SCENES = { space, deathstar, yavin, tatooine, coruscant, hoth, nevarro, mustafar, scarif };

// ---------- emblemas 12x12 ----------
const E = {
  diamond(ctx, x, y, c) { px(ctx, x + 2, y + 2, 6, 6, c); px(ctx, x + 4, y, 2, 10, c); px(ctx, x, y + 4, 10, 2, c); },
  empire(ctx, x, y, c) { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x + 5, y + 5, 4.5, 0, Math.PI * 2); ctx.stroke(); px(ctx, x + 4, y, 2, 10, c); px(ctx, x, y + 4, 10, 2, c); px(ctx, x + 2, y + 2, 1, 1, c); px(ctx, x + 7, y + 2, 1, 1, c); px(ctx, x + 2, y + 7, 1, 1, c); px(ctx, x + 7, y + 7, 1, 1, c); },
  rebel(ctx, x, y, c) { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 5, y); ctx.lineTo(x + 5, y + 10); ctx.moveTo(x + 5, y + 4); ctx.lineTo(x, y + 9); ctx.moveTo(x + 5, y + 4); ctx.lineTo(x + 10, y + 9); ctx.moveTo(x + 5, y + 1); ctx.lineTo(x + 2, y + 5); ctx.moveTo(x + 5, y + 1); ctx.lineTo(x + 8, y + 5); ctx.stroke(); },
  suns(ctx, x, y, c) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 3.5, y + 6, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(x + 8, y + 3, 2.2, 0, Math.PI * 2); ctx.fill(); },
  jedi(ctx, x, y, c) { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x + 5, y + 5, 3.5, 0, Math.PI * 2); ctx.stroke(); px(ctx, x + 4, y, 2, 10, c); px(ctx, x, y + 4, 10, 2, c); },
  snow(ctx, x, y, c) { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 5, y); ctx.lineTo(x + 5, y + 10); ctx.moveTo(x + 1, y + 2.5); ctx.lineTo(x + 9, y + 7.5); ctx.moveTo(x + 9, y + 2.5); ctx.lineTo(x + 1, y + 7.5); ctx.stroke(); px(ctx, x + 4, y + 4, 2, 2, c); },
  mando(ctx, x, y, c) { px(ctx, x + 1, y, 8, 8, c); px(ctx, x + 2, y + 3, 6, 1, '#000a'); px(ctx, x + 4, y + 3, 2, 4, '#000a'); px(ctx, x + 3, y + 8, 4, 2, c); },
  sith(ctx, x, y, c) { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10, y); ctx.lineTo(x + 7, y + 10); ctx.lineTo(x + 3, y + 10); ctx.closePath(); ctx.fill(); px(ctx, x + 4, y + 2, 2, 6, '#000a'); },
  rogue(ctx, x, y, c) { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y + 9); ctx.lineTo(x + 5, y); ctx.lineTo(x + 10, y + 9); ctx.moveTo(x + 2, y + 6); ctx.lineTo(x + 8, y + 6); ctx.stroke(); px(ctx, x + 4, y + 3, 2, 2, c); },
};
export const EMBLEMS = E;
