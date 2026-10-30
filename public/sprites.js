// Sprites pixel-art procedurales (arquetipos de saga espacial, dibujados a mano en código).
// Cada sprite se pinta en un lienzo nativo de 16x22 px con caja útil de 14x20 (+1 px de margen),
// se le añade un contorno oscuro automático y se cachea. Se escala x2 al dibujarlo en la oficina.
// Cada skin viste a los departamentos con un arquetipo y una paleta (`pal`) que sobrescribe sus colores.
const OUTLINE = [10, 12, 20, 255];
export const NATIVE = { w: 16, h: 22 };

const SKINS = ['#f1c9a5', '#d9a577', '#a9744f', '#7a4e32', '#c9a0dc', '#9fd3a8'];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (arr, h, shift = 0) => arr[(h >>> shift) % arr.length];
/** Color de la paleta del skin; si es una lista, elige uno según el agente (cada agente se ve distinto). */
const P = (v, key, fallback, shift = 0) => {
  const c = v.pal?.[key];
  return c === undefined ? fallback : Array.isArray(c) ? pick(c, v.h, shift) : c;
};

const cache = new Map();

/** Une las partes pintadas con `r` y devuelve un lienzo con contorno. */
function build(draw, outline = OUTLINE) {
  const c = document.createElement('canvas');
  c.width = NATIVE.w; c.height = NATIVE.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const r = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x + 1, y + 1, w, h); };
  draw(r);
  const img = ctx.getImageData(0, 0, NATIVE.w, NATIVE.h);
  const { data, width, height } = img;
  const solid = (x, y) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] > 0;
  const out = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) out.push([x, y]);
  }
  ctx.fillStyle = `rgb(${outline[0]},${outline[1]},${outline[2]})`;
  for (const [x, y] of out) ctx.fillRect(x, y, 1, 1);
  return c;
}

// ---- piezas comunes ----
const mirror = (x, w) => 14 - x - w;

/** Brazos humanoides. pose.arm: down | typeA | typeB | waveA | waveB | check */
function arms(r, arm, sleeve, hand, shade = sleeve) {
  const L = (x, y, w, h, c) => r(x, y, w, h, c);
  const R = (x, y, w, h, c) => r(mirror(x, w), y, w, h, c);
  const down = (f) => { f(1, 7, 2, 5, sleeve); f(1, 12, 2, 1, hand); f(1, 8, 1, 4, shade); };
  const upTyping = (f) => { f(1, 7, 2, 3, sleeve); f(2, 10, 3, 2, sleeve); f(4, 10, 2, 2, hand); };
  switch (arm) {
    case 'typeA': upTyping(L); down(R); break;
    case 'typeB': down(L); upTyping(R); break;
    case 'waveA': down(L); R(1, 2, 2, 6, sleeve); R(1, 1, 2, 2, hand); break;
    case 'waveB': down(L); R(0, 2, 2, 6, sleeve); R(0, 1, 2, 2, hand); break;
    case 'check': down(L); R(1, 7, 2, 3, sleeve); R(3, 9, 3, 2, sleeve); R(3, 8, 2, 2, hand); break;
    default: down(L); down(R);
  }
}

/** Piernas: leg 0 = parado, 1/2 = paso. */
function legs(r, leg, thigh, boot, shade = thigh) {
  const lh = leg === 1 ? 5 : 6; // la pierna levantada se acorta
  const rh = leg === 2 ? 5 : 6;
  r(3, 14, 3, lh - 2, thigh); r(3, 14 + lh - 2, 3, 2, boot); r(3, 14, 1, lh - 2, shade);
  r(8, 14, 3, rh - 2, thigh); r(8, 14 + rh - 2, 3, 2, boot); r(8, 14, 1, rh - 2, shade);
}

const eyesRow = (r, y, xs, blink, col = '#0a0c14') => { for (const x of xs) r(x, blink ? y + 1 : y, 1, blink ? 1 : 2, col); };

// ---- arquetipos ----

/** Soldado de armadura (Seguridad). */
function trooper(r, v, p) {
  const W = P(v, 'armor', '#f1f4f8'), S = P(v, 'shade', '#bcc6d4'), K = '#1a1d26', G = P(v, 'under', '#3a3f4d');
  const HI = P(v, 'hi', '#ffffff'), EYE = P(v, 'eye', K);
  const acc = P(v, 'acc', pick(['#e0553a', '#3a8dde', '#e8b73a', '#f1f4f8'], v.h));
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(3, 0 + dy, 8, 7, W); r(4, 0 + dy, 6, 1, HI); r(3, 5 + dy, 8, 2, S);
  if (p.blink) { r(4, 3 + dy, 2, 1, EYE); r(8, 3 + dy, 2, 1, EYE); } else { r(4, 2 + dy, 2, 2, EYE); r(8, 2 + dy, 2, 2, EYE); }
  r(6, 4 + dy, 2, 1, S); r(6, 6 + dy, 2, 1, K); // nariz / rejilla
  r(3, 7, 8, 7, W); r(3, 7, 8, 1, S); r(6, 8, 2, 2, G); r(3, 12, 8, 1, K); r(6, 12, 2, 1, '#8a8f9c');
  r(2, 7, 3, 2, W); r(9, 7, 3, 2, W); r(2, 7, 3, 1, acc); // hombreras
  arms(r, p.arm, G, W, K);
  legs(r, p.leg, W, K, S);
}

/** Piloto de traje y casco. */
function pilot(r, v, p) {
  const O = P(v, 'suit', pick(['#e8742a', '#e8742a', '#e0553a', '#d9a521'], v.h)), OS = P(v, 'suitShade', '#a8491a');
  const W = P(v, 'helm', '#f1f4f8'), K = '#1a1d26', HI = P(v, 'hi', '#ffffff'), HN = P(v, 'harness', '#f1f4f8');
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  const stripe = P(v, 'stripe', pick(['#e8742a', '#e0c13a', '#3a8dde', '#e0553a'], v.h, 4));
  const visor = P(v, 'visor', pick(['#2b4a7a', '#7a4a2b', '#2b6a5a'], v.h, 7), 7);
  r(3, 0 + dy, 8, 7, W); r(4, 0 + dy, 6, 1, HI); r(3, 0 + dy, 8, 2, W); r(6, 0 + dy, 2, 2, stripe); // casco con franja
  r(4, 3 + dy, 6, 3, visor); r(4, 3 + dy, 3, 1, '#8fd3ff'); // visor con brillo
  if (p.blink) r(4, 4 + dy, 6, 1, '#10182a');
  r(3, 6 + dy, 8, 1, '#9aa4b8');
  r(3, 7, 8, 7, O); r(3, 7, 2, 7, OS); r(5, 7, 1, 6, HN); r(8, 7, 1, 6, HN); // arneses
  r(3, 12, 8, 1, K); r(6, 12, 2, 1, '#e8b73a');
  arms(r, p.arm, O, K, OS);
  legs(r, p.leg, O, K, OS);
}

/** Droide astromecánico: cúpula giratoria, sin brazos. */
function astromech(r, v, p) {
  const W = P(v, 'body', '#dfe6ee'), S = P(v, 'shade', '#a8b4c4');
  const acc = P(v, 'acc', pick(['#2f7fd6', '#d6432f', '#2fa86a', '#c58a1e', '#7a4fd0'], v.h));
  const dy = p.slump ? 1 : 0;
  const ds = p.dome ?? 0;
  r(4, 1 + dy, 6, 1, W); r(3, 2 + dy, 8, 3, W); r(4, 5 + dy, 6, 1, S); // cúpula
  r(3, 3 + dy, 8, 1, acc); r(5 + ds, 2 + dy, 1, 1, acc);
  if (p.blink) r(6 + ds, 3 + dy, 2, 1, '#400'); else { r(6 + ds, 2 + dy, 2, 2, '#ff4a3a'); r(6 + ds, 2 + dy, 1, 1, '#ffd0c8'); } // ojo
  r(10, 0 + dy, 1, 2, S); // antena
  r(3, 6, 8, 8, W); r(3, 6, 8, 1, S); r(3, 13, 8, 1, S);
  r(4, 8, 6, 1, acc); r(4, 10, 2, 3, acc); r(7, 10, 3, 2, S); r(8, 10, 1, 1, '#ff4a3a');
  const lh = p.leg === 1 ? 7 : 8;
  r(1, 8, 2, lh, S); r(11, 8, 2, p.leg === 2 ? 7 : 8, S); // patas laterales
  r(0, 8 + lh - 1, 3, 2, '#5b6478'); r(11, 8 + (p.leg === 2 ? 6 : 7), 3, 2, '#5b6478');
  r(5, 14, 4, 5, S); r(5, 18, 4, 2, '#5b6478'); // pata central
  if (p.arm === 'typeA' || p.arm === 'typeB') r(11, 9, p.arm === 'typeA' ? 3 : 2, 1, '#9aa4b8'); // herramienta
  if (p.arm === 'waveA' || p.arm === 'waveB') r(12, p.arm === 'waveA' ? 1 : 2, 1, 6, '#9aa4b8'); // antena de aviso
}

/** Droide de protocolo (Embajada). `gold` es un par [color, sombra]. */
function protocol(r, v, p) {
  const [G, GS] = v.pal?.gold ?? pick([['#e7b93c', '#a97e14'], ['#c9ced6', '#8590a0'], ['#d98a4a', '#9a5a26'], ['#e7b93c', '#a97e14']], v.h);
  const D = '#4a3a10';
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(4, 0 + dy, 6, 7, G); r(3, 2 + dy, 8, 3, G); r(4, 0 + dy, 6, 1, '#fff3c0'); r(4, 6 + dy, 6, 1, GS);
  if (p.blink) { r(4, 3 + dy, 2, 1, '#2a8aa0'); r(8, 3 + dy, 2, 1, '#2a8aa0'); } else { r(4, 2 + dy, 2, 2, '#8be9ff'); r(8, 2 + dy, 2, 2, '#8be9ff'); }
  r(6, 5 + dy, 2, 1, D);
  r(5, 7, 4, 1, D);
  r(3, 7, 8, 6, G); r(2, 7, 10, 1, GS); r(6, 8, 2, 3, GS); r(6, 8, 2, 1, '#fff3c0'); r(3, 12, 8, 1, D);
  arms(r, p.arm, G, GS, GS);
  r(4, 13, 6, 1, GS);
  legs(r, p.leg, G, GS, GS);
}

/** Caballero de túnica con sable de luz (Templo de Diseño). */
function sage(r, v, p) {
  const robe = P(v, 'robe', pick(['#8a6a45', '#e9e2d0', '#5a5f6b', '#4f7a55'], v.h)), RS = P(v, 'robeShade', '#5f4528');
  const under = P(v, 'under', '#e9e2d0');
  const skin = pick(SKINS.slice(0, 4), v.h, 3);
  const blade = P(v, 'blade', pick(['#4aa3ff', '#4ade80', '#b18cff', '#ffe066'], v.h, 5), 5);
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(3, 0 + dy, 8, 3, robe); r(3, 3 + dy, 1, 4, robe); r(10, 3 + dy, 1, 4, robe); // capucha
  r(4, 2 + dy, 6, 5, skin); r(4, 2 + dy, 6, 1, RS);
  eyesRow(r, 4 + dy, [5, 8], p.blink);
  r(6, 6 + dy, 2, 1, '#00000033');
  r(2, 6, 10, 8, robe); r(6, 7, 2, 7, under); r(3, 10, 8, 1, '#5a3a1a'); r(2, 13, 10, 1, RS);
  r(9, 10, 1, 2, '#9aa4b8'); // empuñadura
  arms(r, p.arm, robe, skin, RS);
  r(3, 14, 3, 6, RS); r(8, 14, 3, 6, RS); r(3, 18, 3, 2, '#2a1c0c'); r(8, 18, 3, 2, '#2a1c0c');
  if (p.saber) { r(12, 0, 1, 8, '#ffffff'); r(11, 0, 3, 8, blade + '99'); r(12, 8, 1, 2, '#9aa4b8'); } // sable en alto
}

/** Oficial de mando con gorra. */
function officer(r, v, p) {
  const U = P(v, 'U', pick(['#7f8794', '#46567a', '#4d5c46', '#6a4f5a'], v.h)), US = P(v, 'shade', '#4c5360');
  const cap = P(v, 'cap', '#23283a'), badge = P(v, 'badge', '#e8b73a');
  const skin = pick(SKINS.slice(0, 4), v.h, 3);
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(3, 0 + dy, 8, 2, cap); r(2, 2 + dy, 10, 1, '#0f1220'); r(6, 1 + dy, 2, 1, badge); // gorra
  r(4, 3 + dy, 6, 4, skin);
  eyesRow(r, 4 + dy, [5, 8], p.blink);
  r(6, 6 + dy, 2, 1, '#8a4a3a');
  r(3, 7, 8, 1, cap);
  r(3, 7, 8, 7, U); r(3, 7, 2, 7, US); r(2, 7, 2, 1, badge); r(10, 7, 2, 1, badge);
  r(4, 9, 2, 1, '#e0553a'); r(4, 10, 2, 1, '#3a8dde'); r(7, 9, 2, 1, badge);
  r(3, 12, 8, 1, '#0f1220'); r(6, 12, 2, 1, badge);
  arms(r, p.arm, U, '#0f1220', US);
  legs(r, p.leg, P(v, 'pants', '#2a2f3d'), '#0f1220', '#1c2030');
}

/** Explorador con casco de visor en T. */
function scout(r, v, p) {
  const A = P(v, 'armor', pick(['#3f7d5a', '#7d3f3f', '#3f5a7d', '#9a8450'], v.h)), AS = P(v, 'shade', '#2a4d38'), K = '#14171f', H = '#ffffff55';
  const chest = P(v, 'chest', '#5fa07a');
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(3, 0 + dy, 8, 6, A); r(4, 0 + dy, 3, 1, H); r(3, 5 + dy, 8, 1, AS);
  if (p.blink) r(4, 3 + dy, 6, 1, K); else { r(4, 2 + dy, 6, 1, K); r(6, 3 + dy, 2, 3, K); }
  r(11, 0 + dy, 1, 3, '#9aa4b8'); // antena
  r(5, 6, 4, 1, K);
  r(2, 8, 1, 5, K); r(11, 8, 1, 5, K); // mochila propulsora
  r(3, 7, 8, 7, A); r(4, 8, 6, 3, chest); r(5, 9, 2, 1, K); r(3, 13, 8, 1, K); r(4, 13, 2, 1, '#c9a96a');
  arms(r, p.arm, A, K, AS);
  legs(r, p.leg, A, K, AS);
}

/** Figura encapuchada de ojos brillantes (jawas, cazarrecompensas, acólitos). */
function hooded(r, v, p) {
  const C = P(v, 'cloak', '#6a4a2a'), CS = P(v, 'cloakShade', '#45301a'), E = P(v, 'eyes', '#ffd84a'), B = P(v, 'belt', '#c9a96a');
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(4, 1 + dy, 6, 1, C); r(3, 2 + dy, 8, 5, C); r(3, 2 + dy, 1, 5, CS); r(10, 2 + dy, 1, 5, CS); // capucha
  r(4, 3 + dy, 6, 3, '#08080c'); // rostro en sombra
  if (!p.blink) { r(5, 4 + dy, 1, 2, E); r(8, 4 + dy, 1, 2, E); }
  r(2, 7, 10, 7, C); r(2, 7, 2, 7, CS); r(3, 11, 8, 1, '#2a1c0c'); r(6, 11, 2, 1, B); r(2, 13, 10, 1, CS);
  arms(r, p.arm, C, '#08080c', CS);
  r(3, 14, 3, 6, CS); r(8, 14, 3, 6, CS); r(3, 18, 3, 2, '#1a1208'); r(8, 18, 3, 2, '#1a1208');
}

/** Señor oscuro de casco, capa y sable rojo. */
function sith(r, v, p) {
  const A = P(v, 'armor', '#14141a'), AS = P(v, 'shade', '#2a2a34'), CP = P(v, 'cape', '#5a0e12'), B = P(v, 'blade', '#ff2a2a');
  const EYE = P(v, 'eye', '#ff3a3a');
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(2, 7, 10, 10, CP); r(2, 7, 1, 10, '#00000055'); // capa
  r(3, 0 + dy, 8, 7, A); r(2, 2 + dy, 10, 3, A); r(4, 0 + dy, 6, 1, AS); // casco
  r(4, 3 + dy, 6, 2, '#08080c');
  if (!p.blink) { r(5, 3 + dy, 1, 1, EYE); r(8, 3 + dy, 1, 1, EYE); }
  r(6, 5 + dy, 2, 2, AS); r(5, 6 + dy, 4, 1, AS);
  r(3, 7, 8, 7, A); r(5, 8, 4, 3, '#1e1e26'); r(5, 9, 1, 1, '#ff2a2a'); r(7, 9, 1, 1, '#3a8dde'); r(8, 9, 1, 1, '#4ade80');
  r(3, 12, 8, 1, AS); r(6, 12, 2, 1, '#9aa4b8');
  arms(r, p.arm, A, '#08080c', AS);
  legs(r, p.leg, A, '#08080c', AS);
  if (p.saber) { r(12, 0, 1, 8, '#ffffff'); r(11, 0, 3, 8, B + '99'); r(12, 8, 1, 2, '#9aa4b8'); }
}

/** Guerrero con casco de visor en T, jetpack y capa corta. */
function mandalorian(r, v, p) {
  const A = P(v, 'armor', '#b0b8c4'), AS = P(v, 'shade', '#7a8494'), T = P(v, 'trim', '#c9a96a'), CP = P(v, 'cape', '#6a4a3a');
  const K = '#0a0c12';
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(2, 8, 1, 5, '#5b6478'); r(11, 8, 1, 5, '#5b6478'); // jetpack
  r(3, 0 + dy, 8, 7, A); r(4, 0 + dy, 3, 1, '#ffffff66'); r(3, 5 + dy, 8, 2, AS); // casco
  r(4, 3 + dy, 6, 1, p.blink ? '#3a4152' : K); r(6, 4 + dy, 2, 2, K); // visor en T
  r(3, 7, 8, 7, A); r(3, 7, 8, 1, '#ffffff44'); r(4, 8, 2, 3, AS); r(8, 8, 2, 3, AS); r(6, 9, 2, 1, T);
  r(3, 12, 8, 1, '#3a2a1a'); r(6, 12, 2, 1, T);
  r(9, 7, 3, 3, CP); r(2, 7, 3, 2, A); r(2, 7, 3, 1, T); // capa corta y hombrera
  arms(r, p.arm, AS, '#2a2f3d', A);
  legs(r, p.leg, P(v, 'pants', '#4a3f35'), A, '#2f2822');
}

/** Droide alto de cabeza estrecha y ojos brillantes (K-2SO, IG-11). */
function tallDroid(r, v, p) {
  const B = P(v, 'body', '#4a4f5c'), S = P(v, 'shade', '#2a2d38'), E = P(v, 'eyes', '#8be9ff');
  const dy = p.slump ? 1 : p.bob ? 1 : 0;
  r(5, 0 + dy, 4, 6, B); r(5, 0 + dy, 4, 1, '#ffffff44'); r(4, 1 + dy, 1, 3, S); r(9, 1 + dy, 1, 3, S); // cabeza
  if (p.blink) r(5, 3 + dy, 4, 1, E + '88'); else { r(5, 2 + dy, 1, 2, E); r(8, 2 + dy, 1, 2, E); }
  r(6, 6 + dy, 2, 1, S);
  r(3, 7, 8, 7, B); r(3, 7, 8, 1, '#ffffff33'); r(2, 7, 3, 2, S); r(9, 7, 3, 2, S);
  r(5, 9, 4, 1, S); r(5, 11, 4, 1, S); r(6, 8, 2, 1, E);
  arms(r, p.arm, S, B, B);
  legs(r, p.leg, S, B, B);
}

export const ARCHETYPES = { officer, pilot, trooper, astromech, protocol, sage, scout, hooded, sith, mandalorian, tallDroid };
/** Atuendo por defecto de cada departamento (skin Clásico). */
export const DEFAULT_COSTUME = { mando: 'officer', hangar: 'pilot', inteligencia: 'trooper', flota: 'astromech', diplomacia: 'protocol', taller: 'sage', reconocimiento: 'scout' };

/** Devuelve el lienzo cacheado del personaje para la pose y el skin dados. */
export function getSprite(dept, agent, pose, skin = null) {
  const [name, pal] = skin?.costumes?.[dept] ?? [DEFAULT_COSTUME[dept] ?? 'pilot'];
  const key = [skin?.id ?? '', dept, agent, pose.leg, pose.arm, pose.bob, pose.blink, pose.slump, pose.dome, pose.saber].join('|');
  let c = cache.get(key);
  if (!c) {
    const v = { h: hash(agent), pal };
    const draw = ARCHETYPES[name] ?? pilot;
    c = build((r) => draw(r, v, pose), skin?.outline ?? OUTLINE);
    cache.set(key, c);
  }
  return c;
}
