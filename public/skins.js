// Skins de la oficina: datos puros (sin DOM) para poder validarlos en Node.
// Un skin define la paleta de la interfaz, el decorado de las salas, la escena del ventanal,
// el emblema, los nombres de los departamentos y cómo se viste cada personaje.
import { DEPARTMENTS } from './office-layout.js';

const BASE = {
  ui: { bg: '#07090f', panel: '#0f1422', panel2: '#161d33', line: '#26304f', text: '#dfe6ff', muted: '#8591b8', gold: '#ffd84a', blue: '#4aa3ff', red: '#ff5a5a', green: '#4ade80', violet: '#b18cff', star1: '#fff8', star2: '#ffd84a66' },
  void: '#05060c',
  floor: { a: '#10152a', b: '#0e1326', joint: '#070a16', speck: '#ffffff10' },
  wall: '#0a0e1c', wallLine: '#05070f', frame: '#1a2038',
  metal: '#2a3150', metalDark: '#1a2038', banner: '#8a2a2a',
  desk: { top: '#7a5a3a', topHi: '#a07a50', body: '#4a3524', bodyDark: '#2a1c10', leg: '#35261a' },
  holo: '#4ae0ff',
  outline: [10, 12, 20], // contorno de los personajes (RGB); más claro en skins de suelo oscuro
};

const merge = (base, o) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(o)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  return out;
};
const skin = (o) => merge(BASE, o);

export const SKIN_LIST = [
  skin({
    id: 'clasico', name: 'Clásico', tagline: 'Base rebelde original', title: 'BASE REBELDE', scene: 'space', emblem: 'diamond',
    labels: {}, deptColors: {}, costumes: {},
  }),
  skin({
    id: 'imperio', name: 'Imperio', tagline: 'Estrella de la Muerte', title: 'ESTRELLA DE LA MUERTE', scene: 'deathstar', emblem: 'empire',
    ui: { bg: '#0a0a0d', panel: '#121318', panel2: '#1b1d24', line: '#3a3d48', text: '#e6e8ee', muted: '#9096a5', gold: '#ff4a3a', blue: '#8aa4c8', red: '#ff7a6a', green: '#6fcf8a', violet: '#a58cd0', star1: '#ffffff88', star2: '#ff4a3a66' },
    void: '#050507',
    floor: { a: '#1a1c22', b: '#16181e', joint: '#0a0b0e', speck: '#ffffff0c' },
    wall: '#1c1e26', wallLine: '#0a0b0e', frame: '#2a2d38', metal: '#3a3d48', metalDark: '#23252e', banner: '#8a1a1a',
    desk: { top: '#4a4f5c', topHi: '#6a7080', body: '#2a2d38', bodyDark: '#14151a', leg: '#1c1e26' },
    holo: '#ff5a4a',
    outline: [74, 80, 98],
    labels: { mando: 'Puente del Destructor', hangar: 'Hangar TIE', inteligencia: 'Cuartel de Stormtroopers', flota: 'Droides Imperiales', diplomacia: 'Oficina del Moff', taller: 'Sala de Inquisidores', reconocimiento: 'Exploradores Imperiales' },
    deptColors: { mando: '#ff4a3a', hangar: '#d98a6a', inteligencia: '#e8ecf4', flota: '#8aa4c8', diplomacia: '#c0c4cc', taller: '#ff6a8a', reconocimiento: '#9ab08a' },
    costumes: {
      mando: ['officer', { U: ['#5b6372', '#4a5160'], shade: '#343a46', cap: '#1b1e28', badge: '#e0553a' }],
      hangar: ['pilot', { suit: '#2b2f3a', suitShade: '#1a1d26', helm: '#16181f', hi: '#4a4d5a', harness: '#6a7080', visor: '#0b0c10', stripe: '#e0553a' }],
      inteligencia: ['trooper', { acc: '#e0553a' }],
      flota: ['astromech', { body: '#8a909c', shade: '#5a606c', acc: '#e0553a' }],
      diplomacia: ['protocol', { gold: ['#c9ced6', '#8590a0'] }],
      taller: ['sage', { robe: '#1b1b22', robeShade: '#0e0e12', under: '#3a3a44', blade: '#ff3a3a' }],
      reconocimiento: ['scout', { armor: '#c9ced6', shade: '#8a909c', chest: '#e8ecf4' }],
    },
  }),
  skin({
    id: 'rebelion', name: 'Rebelión', tagline: 'Base Yavin 4', title: 'BASE YAVIN 4', scene: 'yavin', emblem: 'rebel',
    ui: { bg: '#0b100a', panel: '#121a10', panel2: '#1b2618', line: '#3a4a30', text: '#e6f0da', muted: '#94a68a', gold: '#ff9a3c', blue: '#5ac8e8', red: '#ff6a5a', green: '#8ae04a', violet: '#c0a0ff', star1: '#e6f0da66', star2: '#ff9a3c66' },
    void: '#050805',
    floor: { a: '#26301f', b: '#212a1a', joint: '#10160c', speck: '#c9e0a010' },
    wall: '#1a2216', wallLine: '#0a0f08', frame: '#34442a', metal: '#4a5a3a', metalDark: '#2a3820', banner: '#c0561a',
    desk: { top: '#8a6a3a', topHi: '#b08a4a', body: '#5a4a2a', bodyDark: '#2a2010', leg: '#3a3018' },
    holo: '#5ae8d0',
    labels: { mando: 'Centro de Mando Rebelde', hangar: 'Hangar de Escuadrones', inteligencia: 'Guarnición Rebelde', flota: 'Taller de Droides', diplomacia: 'Embajada Rebelde', taller: 'Templo de la Fuerza', reconocimiento: 'Patrulla de la Selva' },
    deptColors: { mando: '#ffb84a', hangar: '#ff7a2a', inteligencia: '#e86a5a', flota: '#5ac8ff', diplomacia: '#e0d4a0', taller: '#c0a0ff', reconocimiento: '#8ae04a' },
    costumes: {
      mando: ['officer', { U: ['#6a7a5a', '#5a6a4a'], shade: '#3a4a2a', cap: '#3a4a2a', badge: '#e0553a' }],
      hangar: ['pilot', {}],
      inteligencia: ['trooper', { armor: '#b8b08a', shade: '#8a8460', under: '#4a4a34', acc: ['#e0553a', '#3a8dde'] }],
      flota: ['astromech', {}],
      diplomacia: ['protocol', { gold: ['#e7b93c', '#a97e14'] }],
      taller: ['sage', { robe: '#e9e2d0', robeShade: '#a89870', under: '#8a6a45', blade: '#4ade80' }],
      reconocimiento: ['scout', {}],
    },
  }),
  skin({
    id: 'tatooine', name: 'Tatooine', tagline: 'Cantina y desierto', title: 'CANTINA DE MOS EISLEY', scene: 'tatooine', emblem: 'suns',
    ui: { bg: '#120d08', panel: '#1c140c', panel2: '#281c10', line: '#4a3620', text: '#f4e6cf', muted: '#b09a78', gold: '#ffb84a', blue: '#6ab4d8', red: '#ff6a4a', green: '#9ac86a', violet: '#c49ad8', star1: '#f4e6cf66', star2: '#ffb84a66' },
    void: '#0a0604',
    floor: { a: '#3a2c1c', b: '#34271a', joint: '#1c140c', speck: '#e8c07030' },
    wall: '#4a3622', wallLine: '#2a1c10', frame: '#6a4a2a', metal: '#6a5236', metalDark: '#3e2e1c', banner: '#a8481a',
    desk: { top: '#9a7a4a', topHi: '#c09a62', body: '#6a4a2a', bodyDark: '#3a2410', leg: '#4a3018' },
    holo: '#ffd070',
    labels: { mando: 'Cantina de Mos Eisley', hangar: 'Hangar de Podracers', inteligencia: 'Guardia Arenera', flota: 'Taller de Chatarra', diplomacia: 'Palacio de Jabba', taller: 'Campamento Jawa', reconocimiento: 'Patrulla del Desierto' },
    deptColors: { mando: '#ffd070', hangar: '#ff8a3a', inteligencia: '#f0e0b0', flota: '#c88a4a', diplomacia: '#e0a0a0', taller: '#ffa86a', reconocimiento: '#9ac86a' },
    costumes: {
      mando: ['sage', { robe: '#8a6a45', robeShade: '#5f4528', under: '#c9b48a', blade: '#4aa3ff' }],
      hangar: ['pilot', { suit: ['#c98a3a', '#b87333', '#a8693a'], suitShade: '#7a4a1a', helm: '#8a6a45', hi: '#c0a070', harness: '#d9c7a0', visor: '#e8c070' }],
      inteligencia: ['trooper', { armor: '#d9c7a0', shade: '#a89870', under: '#6a5a3a', acc: '#e8742a' }],
      flota: ['astromech', { body: '#b88a5a', shade: '#8a5a30', acc: ['#c0502a', '#6a8a4a'] }],
      diplomacia: ['protocol', { gold: ['#d98a4a', '#9a5a26'] }],
      taller: ['hooded', { cloak: '#6a4a2a', cloakShade: '#45301a', eyes: '#ffd84a' }],
      reconocimiento: ['scout', { armor: ['#9a8450', '#8a7440'], shade: '#5a4a28', chest: '#c9b48a' }],
    },
  }),
  skin({
    id: 'jedi', name: 'Templo Jedi', tagline: 'Coruscant, la República', title: 'TEMPLO JEDI', scene: 'coruscant', emblem: 'jedi',
    ui: { bg: '#080b16', panel: '#0f1526', panel2: '#172038', line: '#2c3c66', text: '#e8eeff', muted: '#93a2cc', gold: '#e8c870', blue: '#6ab8ff', red: '#ff6a7a', green: '#6ae0a8', violet: '#b8a0ff', star1: '#e8eeff77', star2: '#e8c87066' },
    void: '#04060e',
    floor: { a: '#1a2036', b: '#161c30', joint: '#0a0e1c', speck: '#e8e0b012' },
    wall: '#161c32', wallLine: '#080b16', frame: '#2c3860', metal: '#3a4878', metalDark: '#222c50', banner: '#c0a050',
    desk: { top: '#c8c0a8', topHi: '#e8e0c8', body: '#8a8068', bodyDark: '#4a4430', leg: '#6a6450' },
    holo: '#8ac8ff',
    labels: { mando: 'Consejo Jedi', hangar: 'Hangar de la República', inteligencia: 'Legión Clon', flota: 'Bahía de Droides', diplomacia: 'Senado Galáctico', taller: 'Archivos Jedi', reconocimiento: 'Exploradores del Templo' },
    deptColors: { mando: '#f0d890', hangar: '#7ab8ff', inteligencia: '#9ad0ff', flota: '#5a98e8', diplomacia: '#e8e0c0', taller: '#b8a0ff', reconocimiento: '#7ae0b0' },
    costumes: {
      mando: ['sage', { robe: '#e9e2d0', robeShade: '#a89870', under: '#8a6a45', blade: '#4aa3ff' }],
      hangar: ['pilot', { suit: '#e9edf2', suitShade: '#a8b4c4', helm: '#f1f4f8', harness: '#3a8dde', visor: '#2b4a7a', stripe: '#3a8dde' }],
      inteligencia: ['trooper', { acc: '#3a8dde' }],
      flota: ['astromech', { acc: '#2f7fd6' }],
      diplomacia: ['protocol', { gold: ['#e7b93c', '#a97e14'] }],
      taller: ['sage', { robe: ['#8a6a45', '#4f7a55', '#5a5f6b'], blade: ['#4ade80', '#4aa3ff', '#b18cff'] }],
      reconocimiento: ['scout', { armor: '#3f5a7d', shade: '#2a3f5a', chest: '#6a8ab0' }],
    },
  }),
  skin({
    id: 'hoth', name: 'Hoth', tagline: 'Base Eco, planeta helado', title: 'BASE ECO · HOTH', scene: 'hoth', emblem: 'snow',
    ui: { bg: '#0a1018', panel: '#111a26', panel2: '#1a2636', line: '#34506c', text: '#e8f2fc', muted: '#8fa6c0', gold: '#8ad8ff', blue: '#5aa8ff', red: '#ff6a7a', green: '#6ae8b8', violet: '#b0b8ff', star1: '#e8f2fc88', star2: '#8ad8ff66' },
    void: '#04080e',
    floor: { a: '#1c2a3a', b: '#182434', joint: '#0a121c', speck: '#cfe8ff20' },
    wall: '#18283a', wallLine: '#080e16', frame: '#2c4a68', metal: '#5a7a98', metalDark: '#324a62', banner: '#4a8ac8',
    desk: { top: '#8a9aa8', topHi: '#b8c8d4', body: '#5a6a78', bodyDark: '#2a3640', leg: '#3a4a56' },
    holo: '#9ae8ff',
    outline: [10, 12, 20],
    labels: { mando: 'Centro de Mando Eco', hangar: 'Hangar de Snowspeeders', inteligencia: 'Guarnición Eco', flota: 'Taller de Droides', diplomacia: 'Sala de Comunicaciones', taller: 'Cuarto de Entrenamiento', reconocimiento: 'Patrulla de Tauntauns' },
    deptColors: { mando: '#8ad8ff', hangar: '#ff9a4a', inteligencia: '#c8e0f8', flota: '#4aa8ff', diplomacia: '#e8f0f8', taller: '#b0b8ff', reconocimiento: '#7ae8c0' },
    costumes: {
      mando: ['officer', { U: ['#6a7a8a', '#5a6a7a'], shade: '#3a4a5a', cap: '#3a4a5a', badge: '#8ad8ff' }],
      hangar: ['pilot', { suit: '#e8742a', suitShade: '#a8491a', helm: '#c9d3de', visor: '#3a5a7a', stripe: '#ffffff' }],
      inteligencia: ['trooper', { armor: '#d9e3ee', shade: '#9fb0c4', under: '#3a4a5a', acc: '#3a8dde' }],
      flota: ['astromech', { body: '#eef4fb', shade: '#b8c8d8', acc: '#3a8dde' }],
      diplomacia: ['protocol', { gold: ['#c9ced6', '#8590a0'] }],
      taller: ['sage', { robe: '#e9edf2', robeShade: '#9fb0c4', under: '#8a6a45', blade: '#4aa3ff' }],
      reconocimiento: ['scout', { armor: '#aab8c8', shade: '#6a7a8c', chest: '#d9e3ee' }],
    },
  }),
  skin({
    id: 'mandaloriano', name: 'Mandaloriano', tagline: 'Nevarro y el Razor Crest', title: 'NEVARRO · EL CAMINO', scene: 'nevarro', emblem: 'mando',
    ui: { bg: '#0f0c0a', panel: '#191410', panel2: '#241c16', line: '#4a3d30', text: '#efe6dc', muted: '#a8978a', gold: '#d8b878', blue: '#7a9ab8', red: '#ff7a5a', green: '#a8c870', violet: '#b89ad0', star1: '#efe6dc66', star2: '#d8b87866' },
    void: '#080605',
    floor: { a: '#2a221c', b: '#251e18', joint: '#120e0a', speck: '#c9a96a14' },
    wall: '#241c16', wallLine: '#0e0a08', frame: '#4a3a2a', metal: '#6a5a48', metalDark: '#3a2e22', banner: '#7a3a1a',
    desk: { top: '#5a4a3a', topHi: '#8a7860', body: '#3a2e22', bodyDark: '#1a120a', leg: '#2a2016' },
    holo: '#ffb04a',
    outline: [96, 78, 60],
    labels: { mando: 'Gremio de Cazarrecompensas', hangar: 'Hangar del Razor Crest', inteligencia: 'Guardia Mandaloriana', flota: 'Droides de Nevarro', diplomacia: 'Cantina de Nevarro', taller: 'La Forja', reconocimiento: 'Rastreadores' },
    deptColors: { mando: '#c9d0dc', hangar: '#e8a24a', inteligencia: '#9aa4b8', flota: '#7ac0e8', diplomacia: '#d8b878', taller: '#e08a3a', reconocimiento: '#a8c870' },
    costumes: {
      mando: ['mandalorian', { armor: '#b0b8c4', shade: '#7a8494', trim: '#c9a96a', cape: '#6a4a3a' }],
      hangar: ['mandalorian', { armor: ['#b0b8c4', '#3f5a7d', '#7d3f3f', '#3f7d5a', '#9a8450'], trim: '#e8b73a', cape: ['#6a4a3a', '#3a4a5a'] }],
      inteligencia: ['trooper', { armor: '#2b2f3a', shade: '#1a1d26', under: '#444a58', hi: '#5a6070', eye: '#cfd6e4', acc: '#9aa4b8' }],
      flota: ['tallDroid', { body: '#cfd5dd', shade: '#7a8494', eyes: '#ff3a3a' }],
      diplomacia: ['officer', { U: ['#6a4a3a', '#5a3f30'], shade: '#3a2a20', cap: '#8a6a45', badge: '#c9a96a' }],
      taller: ['mandalorian', { armor: '#b87333', shade: '#7a4a1a', trim: '#e8b73a', cape: '#3a2a1a' }],
      reconocimiento: ['hooded', { cloak: '#4a3a2a', cloakShade: '#2a2016', eyes: '#ff8a3a' }],
    },
  }),
  skin({
    id: 'sith', name: 'Lado Oscuro', tagline: 'Mustafar, fortaleza Sith', title: 'FORTALEZA DE MUSTAFAR', scene: 'mustafar', emblem: 'sith',
    ui: { bg: '#0a0306', panel: '#14080c', panel2: '#1f0c12', line: '#4a1a22', text: '#f2dede', muted: '#b08a8e', gold: '#ff3a3a', blue: '#ff7a5a', red: '#ff9a9a', green: '#8ac870', violet: '#c05aff', star1: '#ff5a3a77', star2: '#ff3a3a66' },
    void: '#040102',
    floor: { a: '#1c0e12', b: '#180a0e', joint: '#0a0406', speck: '#ff3a1a14' },
    wall: '#14080c', wallLine: '#060204', frame: '#3a1018', metal: '#4a2028', metalDark: '#2a0e14', banner: '#7a0e12',
    desk: { top: '#2a2a34', topHi: '#4a4a58', body: '#18181e', bodyDark: '#0a0a0e', leg: '#101014' },
    holo: '#ff4a3a',
    outline: [130, 44, 54],
    labels: { mando: 'Trono Sith', hangar: 'Hangar de TIE Oscuros', inteligencia: 'Guardia Sombra', flota: 'Forja de Droides', diplomacia: 'Corte del Emperador', taller: 'Sala de Inquisidores', reconocimiento: 'Acólitos' },
    deptColors: { mando: '#ff3a3a', hangar: '#ff7a3a', inteligencia: '#e8e0e8', flota: '#c04a8a', diplomacia: '#ff9a8a', taller: '#b04aff', reconocimiento: '#ff5a8a' },
    costumes: {
      mando: ['sith', { armor: '#14141a', cape: '#5a0e12', blade: '#ff2a2a' }],
      hangar: ['pilot', { suit: '#2b2f3a', suitShade: '#1a1d26', helm: '#16181f', hi: '#4a4d5a', harness: '#5a6070', visor: '#0b0c10', stripe: '#ff3a3a' }],
      inteligencia: ['trooper', { armor: '#1c1d24', shade: '#0e0f14', under: '#14151a', hi: '#4a4d5a', eye: '#ff5a4a', acc: '#ff2a2a' }],
      flota: ['astromech', { body: '#2a2d38', shade: '#14161c', acc: '#ff2a2a' }],
      diplomacia: ['officer', { U: '#2a2d38', shade: '#14161c', cap: '#0e0f14', badge: '#ff3a3a' }],
      taller: ['sith', { armor: '#2a1c3a', shade: '#3a2a4a', cape: '#2a0e3a', blade: '#ff4a2a', eye: '#ffb04a' }],
      reconocimiento: ['hooded', { cloak: '#2a0e12', cloakShade: '#14080c', eyes: '#ff3a3a', belt: '#7a0e12' }],
    },
  }),
  skin({
    id: 'rogue', name: 'Rogue One', tagline: 'Scarif, la misión imposible', title: 'ROGUE ONE · SCARIF', scene: 'scarif', emblem: 'rogue',
    ui: { bg: '#080d10', panel: '#0f171c', panel2: '#172229', line: '#2c4650', text: '#e4f0f2', muted: '#8aa6ae', gold: '#4ad8c8', blue: '#6aa8e8', red: '#ff6a5a', green: '#8ad870', violet: '#b09ad0', star1: '#e4f0f277', star2: '#4ad8c866' },
    void: '#04090a',
    floor: { a: '#1e2a2e', b: '#1a262a', joint: '#0c1416', speck: '#cfeff014' },
    wall: '#182226', wallLine: '#080e10', frame: '#34505a', metal: '#5a7480', metalDark: '#2e424a', banner: '#2a6a7a',
    desk: { top: '#6a7a80', topHi: '#8aa0a8', body: '#3e4e54', bodyDark: '#1c262a', leg: '#2a3a40' },
    holo: '#5ae8d8',
    outline: [64, 84, 92],
    labels: { mando: 'Puesto de Mando Rebelde', hangar: 'Escuadrón Azul', inteligencia: 'Comandos de Scarif', flota: 'K-2SO y Droides', diplomacia: 'Alto Mando Imperial', taller: 'Archivos de Jedha', reconocimiento: 'Equipo Rogue' },
    deptColors: { mando: '#5ad8c8', hangar: '#ffa84a', inteligencia: '#e8e8e8', flota: '#6aa8e8', diplomacia: '#e8dca0', taller: '#d0b080', reconocimiento: '#8ad870' },
    costumes: {
      mando: ['officer', { U: ['#5f6a4a', '#6a7a5a'], shade: '#3a4a2a', cap: '#2a3a28', badge: '#4ad8c8' }],
      hangar: ['pilot', { suit: '#e8742a', suitShade: '#a8491a', helm: '#d9dde4', stripe: '#3a8dde', visor: '#2b4a7a' }],
      inteligencia: ['trooper', { armor: '#1c1d24', shade: '#0e0f14', under: '#14151a', hi: '#4a4d5a', eye: '#cfd6e4', acc: '#e0553a' }],
      flota: ['tallDroid', { body: '#4a4f5c', shade: '#2a2d38', eyes: '#8be9ff' }],
      diplomacia: ['officer', { U: '#e9edf2', shade: '#a8b4c4', cap: '#c9ced6', badge: '#e0553a' }],
      taller: ['sage', { robe: '#8a6a45', robeShade: '#5f4528', under: '#c9b48a', blade: '#e8c070' }],
      reconocimiento: ['scout', { armor: ['#3f7d5a', '#9a8450', '#4a6a5a'], shade: '#2a3d30', chest: '#8ab098' }],
    },
  }),
];

export const DEFAULT_SKIN = SKIN_LIST[0];
export const AUTO = { id: 'auto', name: 'Auto', tagline: 'Tatooine de día, Imperio de noche', day: 'tatooine', night: 'imperio' };

export const skinById = (id) => SKIN_LIST.find((s) => s.id === id) ?? null;

/** Convierte la elección guardada (puede ser 'auto' o inválida) en el skin concreto a pintar. */
export function resolveSkin(choice, date = new Date()) {
  if (choice === AUTO.id) {
    const h = date.getHours();
    return skinById(h >= 6 && h < 18 ? AUTO.day : AUTO.night);
  }
  return skinById(choice) ?? DEFAULT_SKIN;
}

export const deptView = (dept, skin) => ({ ...dept, label: skin.labels[dept.id] ?? dept.label, color: skin.deptColors[dept.id] ?? dept.color });
export const DEPT_IDS = DEPARTMENTS.map((d) => d.id);
