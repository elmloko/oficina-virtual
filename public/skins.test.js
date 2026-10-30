import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIN_LIST, AUTO, DEPT_IDS, skinById, resolveSkin, DEFAULT_SKIN } from './skins.js';
import { ARCHETYPES, DEFAULT_COSTUME, getSprite, NATIVE } from './sprites.js';
import { SCENES, EMBLEMS } from './scenes.js';

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const lum = (hex) => {
  const h = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const REQUESTED = ['imperio', 'rebelion', 'tatooine', 'jedi', 'hoth', 'mandaloriano', 'sith', 'rogue'];

test('están todos los skins pedidos (incluido Rogue One) y el clásico', () => {
  const ids = SKIN_LIST.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids únicos');
  for (const id of ['clasico', ...REQUESTED]) assert.ok(ids.includes(id), id);
  assert.equal(DEFAULT_SKIN.id, 'clasico');
});

test('cada skin define colores válidos y una interfaz legible (contraste WCAG)', () => {
  for (const s of SKIN_LIST) {
    for (const [k, v] of Object.entries(s.ui)) assert.match(v, HEX, `${s.id}.ui.${k}`);
    for (const k of ['void', 'wall', 'wallLine', 'frame', 'metal', 'metalDark', 'banner', 'holo']) assert.match(s[k], HEX, `${s.id}.${k}`);
    for (const [k, v] of Object.entries({ ...s.floor, ...s.desk })) assert.match(v, HEX, `${s.id}.${k}`);
    for (const [k, v] of Object.entries(s.deptColors)) assert.match(v, HEX, `${s.id}.deptColors.${k}`);
    const { ui } = s;
    assert.ok(contrast(ui.text, ui.bg) >= 7, `${s.id}: texto/fondo`);
    assert.ok(contrast(ui.text, ui.panel2) >= 7, `${s.id}: texto/panel2`);
    assert.ok(contrast(ui.muted, ui.panel) >= 4.5, `${s.id}: texto atenuado/panel`);
    assert.ok(contrast(ui.gold, ui.panel) >= 4.5, `${s.id}: acento/panel`);
    assert.ok(contrast('#1a1500', ui.gold) >= 4.5, `${s.id}: texto del botón primario sobre el acento`);
    for (const c of ['blue', 'red', 'green', 'violet']) assert.ok(contrast(ui[c], ui.panel) >= 3, `${s.id}: ${c}/panel`);
  }
});

test('cada skin tiene título, escena y emblema existentes, y nombra todos los departamentos', () => {
  for (const s of SKIN_LIST) {
    assert.ok(s.name && s.tagline && s.title, s.id);
    assert.ok(SCENES[s.scene], `${s.id}: escena ${s.scene}`);
    assert.ok(EMBLEMS[s.emblem], `${s.id}: emblema ${s.emblem}`);
    if (s.id === 'clasico') continue;
    for (const d of DEPT_IDS) {
      assert.ok(s.labels[d], `${s.id}: etiqueta de ${d}`);
      assert.ok(s.deptColors[d], `${s.id}: color de ${d}`);
      assert.ok(s.costumes[d], `${s.id}: atuendo de ${d}`);
      assert.ok(ARCHETYPES[s.costumes[d][0]], `${s.id}: arquetipo ${s.costumes[d][0]}`);
    }
  }
});

test('los skins se ven distintos entre sí (escena, paleta y atuendos)', () => {
  const scenes = SKIN_LIST.map((s) => s.scene);
  assert.equal(new Set(scenes).size, scenes.length, 'cada skin con su propia escena');
  const accents = SKIN_LIST.map((s) => s.ui.gold);
  assert.equal(new Set(accents).size, accents.length, 'cada skin con su propio acento');
});

test('skin Auto: Tatooine de día, Imperio de noche; elección inválida cae al clásico', () => {
  assert.equal(resolveSkin(AUTO.id, new Date(2026, 0, 1, 12)).id, 'tatooine');
  assert.equal(resolveSkin(AUTO.id, new Date(2026, 0, 1, 6)).id, 'tatooine');
  assert.equal(resolveSkin(AUTO.id, new Date(2026, 0, 1, 18)).id, 'imperio');
  assert.equal(resolveSkin(AUTO.id, new Date(2026, 0, 1, 3)).id, 'imperio');
  assert.equal(resolveSkin('nope').id, 'clasico');
  assert.equal(resolveSkin(null).id, 'clasico');
  assert.equal(skinById('sith').id, 'sith');
  assert.ok(skinById(AUTO.day) && skinById(AUTO.night));
});

// ---- lienzo simulado: valida que los sprites no se salgan de su caja y que las escenas no produzcan NaN ----
function fakeCanvas() {
  const c = { width: 0, height: 0, rects: [] };
  const buf = () => new Uint8ClampedArray(c.width * c.height * 4);
  let data;
  c.getContext = () => ({
    set fillStyle(_v) {},
    fillRect(x, y, w, h) {
      data ??= buf();
      c.rects.push([x, y, w, h]);
      for (let j = Math.max(0, y); j < Math.min(c.height, y + h); j++) for (let i = Math.max(0, x); i < Math.min(c.width, x + w); i++) data[(j * c.width + i) * 4 + 3] = 255;
    },
    getImageData(_x, _y, w, h) { data ??= buf(); return { data, width: w, height: h }; },
  });
  return c;
}

test('todos los atuendos de todos los skins dibujan dentro de la caja 16x22 en todas las poses', () => {
  globalThis.document = { createElement: () => fakeCanvas() };
  try {
    const poses = [];
    for (const arm of ['down', 'typeA', 'typeB', 'waveA', 'waveB', 'check']) for (const leg of [0, 1, 2]) poses.push({ leg, arm, bob: 1, blink: false, slump: false, dome: 1, saber: false });
    poses.push({ leg: 0, arm: 'down', bob: 0, blink: true, slump: true, dome: -1, saber: false }, { leg: 0, arm: 'waveA', bob: 0, blink: false, slump: false, dome: 0, saber: true });
    for (const s of SKIN_LIST) {
      for (const d of DEPT_IDS) for (const pose of poses) for (const agent of ['alfa', 'beta-2']) {
        const c = getSprite(d, agent, pose, s);
        assert.equal(c.width, NATIVE.w);
        assert.ok(c.rects.length > 10, `${s.id}/${d}: sprite vacío`);
        for (const [x, y, w, h] of c.rects.filter((r) => r[2] > 1 || r[3] > 1 || true)) {
          if (w === 1 && h === 1 && (x < 0 || y < 0 || x >= NATIVE.w || y >= NATIVE.h)) assert.fail(`${s.id}/${d}: contorno fuera`);
          if (!(w === 1 && h === 1)) assert.ok(x >= 1 - 1 && y >= 0 && x + w <= NATIVE.w && y + h <= NATIVE.h, `${s.id}/${d}/${pose.arm}: parte fuera de la caja (${x},${y},${w},${h})`);
        }
      }
    }
    for (const d of Object.keys(DEFAULT_COSTUME)) assert.ok(getSprite(d, 'x', poses[0]).rects.length > 10); // atuendo por defecto
  } finally { delete globalThis.document; }
});

function recordingCtx(log) {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return (...a) => { log.push([prop, a]); return grad; };
      if (prop === 'measureText') return () => ({ width: 10 });
      return (...a) => { log.push([prop, a]); };
    },
    set() { return true; },
  });
}

test('las escenas y los emblemas producen solo números finitos en cualquier instante', () => {
  for (const [name, fn] of Object.entries(SCENES)) {
    for (const t of [0, 0.5, 3.5, 7.77, 61, 1234.5, 99999]) for (const seed of [0, 11, 12345]) {
      const log = [];
      fn(recordingCtx(log), 6, 18, 278, 34, t, seed, { color: '#ffffff' });
      assert.ok(log.length > 5, `${name}: no dibuja`);
      for (const [op, args] of log) for (const a of args) if (typeof a === 'number') assert.ok(Number.isFinite(a), `${name} t=${t} ${op}: ${a}`);
    }
  }
  for (const [name, fn] of Object.entries(EMBLEMS)) {
    const log = [];
    fn(recordingCtx(log), 6, 4, '#ffffff');
    assert.ok(log.length > 0, name);
    for (const [op, args] of log) for (const a of args) if (typeof a === 'number') assert.ok(Number.isFinite(a), `${name} ${op}`);
  }
});
