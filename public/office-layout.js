// Distribución de la oficina: lógica pura (sin canvas) para poder probarla en Node.
export const CANVAS = { w: 1560, h: 700 }; // proporción ~2.2:1: casi llena un monitor 16:9 (menos el encabezado) sin franjas
export const CHAR = { w: 32, h: 44 }; // sprite 16x22 a escala 2
const MARGIN = 8;
const COLS = 4;
const ROOM_W = (CANVAS.w - MARGIN * (COLS + 1)) / COLS; // 380
const ROOM_H = (CANVAS.h - MARGIN * 3) / 2; // 298
export const ROOM = { w: ROOM_W, h: ROOM_H };

export const DEPARTMENTS = [
  { id: 'mando', label: 'Puente de Mando', color: '#ffd84a', agents: ['architect', 'spec-writer', 'api-designer', 'reviewer', 'claude', 'arquitecto', 'revisor'] },
  { id: 'hangar', label: 'Hangar de Pilotos', color: '#ff9a3c', agents: ['backend', 'frontend', 'fullstack', 'dba', 'integrator', 'mobile', 'refactor', 'migrator', 'debugger', 'performance', 'figma-to-code', 'laravel', 'base-datos', 'depurador', 'rendimiento'] },
  { id: 'inteligencia', label: 'Guarnición de Seguridad', color: '#ff5a5a', agents: ['tester', 'e2e', 'security', 'a11y', 'responsive', 'deps-auditor', 'netsec', 'seguridad'] },
  { id: 'flota', label: 'Bahía de Droides', color: '#4aa3ff', agents: ['devops', 'cicd', 'sre', 'cloud', 'iac', 'k8s', 'backup-dr', 'cost-optimizer', 'windows-admin'] },
  { id: 'diplomacia', label: 'Embajada y Negocio', color: '#d9c7a0', agents: ['proposal', 'reporter', 'copywriter', 'analyst', 'brand', 'legal-docs', 'presentation', 'landing', 'docs', 'pr-writer', 'translator', 'documentador'] },
  { id: 'taller', label: 'Templo de Diseño', color: '#b18cff', agents: ['designer', 'ui-designer', 'design-system', 'illustrator', 'motion', 'dataviz', 'ux-researcher'] },
  { id: 'reconocimiento', label: 'Exploradores', color: '#4ade80', agents: ['researcher', 'scraper', 'summarizer', 'datos-ia'] },
];
export const OPS_ROOM = { id: 'ops', label: 'Sala de Operaciones', color: '#7dd3fc' };

const DEPT_BY_AGENT = new Map(DEPARTMENTS.flatMap((d) => d.agents.map((a) => [a, d.id])));
const KEYWORDS = [ // en orden: gana la primera que coincida (las de español van antes para que «arquitecto» no caiga en diseño por «ui»)
  [/arquitect|revisor|planific/, 'mando'],
  [/segur|prueba|auditor/, 'inteligencia'],
  [/despliegue|servidor|infraestructura/, 'flota'],
  [/diseñ|disen|ilustra|anima/, 'taller'],
  [/investig|datos|resum/, 'reconocimiento'],
  [/redact|traduc|legal|ventas|negocio/, 'diplomacia'],
  [/test|qa|e2e|secur|audit|a11y/, 'inteligencia'],
  [/ops|cloud|k8s|sre|infra|deploy|ci/, 'flota'],
  [/design|ui|ux|art|motion|illus/, 'taller'],
  [/research|scrap|search|summar/, 'reconocimiento'],
  [/doc|write|copy|report|propos|brand|trans|legal/, 'diplomacia'],
];

export function deptOf(agent) {
  if (DEPT_BY_AGENT.has(agent)) return DEPT_BY_AGENT.get(agent);
  const hit = KEYWORDS.find(([re]) => re.test(agent));
  return hit ? hit[1] : 'hangar';
}

/** Rectángulo de la sala i (0..7), en una grilla de 4x2. */
export function roomRect(i) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return { x: MARGIN + col * (ROOM_W + MARGIN), y: MARGIN + row * (ROOM_H + MARGIN), w: ROOM_W, h: ROOM_H };
}

export const ROOM_ORDER = [...DEPARTMENTS.map((d) => d.id), OPS_ROOM.id];

// Posiciones relativas a la sala.
// El diseño base mide 290 px de ancho de sala; el espacio sobrante se reparte para que todo quede centrado.
const EXTRA = ROOM_W - 290;
const X1 = 18 + EXTRA * 0.25; const X2 = 160 + EXTRA * 0.75;
const DESK_SLOTS = [[X1, 66], [X2, 66], [X1, 150], [X2, 150]];
export const DESK = { w: 112, h: 52 };
export const SEAT = { dx: 34, dy: 44 }; // el personaje se sienta a la izquierda; el monitor queda a la derecha
const LOUNGE = { x: 10 + EXTRA / 2, y: 226, dx: 34, dy: 48, cols: 8 };
export const GAP = { x: 130 + EXTRA / 2, w: 30 }; // columna central entre escritorios (decoración)
const LOUNGE_BOTTOM = ROOM_H - 4; // pies de la última fila: deja margen para deambular (±4 px) sin salir de la sala
const LOUNGE_PAD = 32; // distancia mínima del centro del personaje al borde: medio sprite + deambular (±14 px)
const LOUNGE_MIN_DX = 26; // separación mínima entre personajes al compactar (se solapan un poco, se siguen distinguiendo)

/** Pies (relativos a la sala) del i-ésimo de n agentes en descanso. Con muchos, se compacta para no salirse. */
export function loungeSlot(i, n) {
  const room = LOUNGE_BOTTOM - LOUNGE.y - CHAR.h; // alto disponible entre la primera y la última fila
  const baseRows = Math.floor(room / LOUNGE.dy) + 1;
  if (n <= baseRows * LOUNGE.cols) { // caben con la distribución de siempre
    return { x: LOUNGE.x + (i % LOUNGE.cols) * LOUNGE.dx + CHAR.w / 2, y: LOUNGE.y + Math.floor(i / LOUNGE.cols) * LOUNGE.dy + CHAR.h };
  }
  const span = ROOM_W - 2 * LOUNGE_PAD;
  const rows = Math.ceil(n / (Math.floor(span / LOUNGE_MIN_DX) + 1));
  const cols = Math.ceil(n / rows);
  const stagger = rows > baseRows; // filas muy juntas: al tresbolillo para que se vean las caras
  const dx = Math.min(LOUNGE.dx, span / (cols - 1 + (stagger ? 0.5 : 0)));
  const dy = Math.min(LOUNGE.dy, room / (rows - 1));
  const row = Math.floor(i / cols);
  const shift = stagger && row % 2 ? dx / 2 : 0;
  const x0 = (ROOM_W - (cols - 1) * dx - (stagger ? dx / 2 : 0)) / 2;
  return { x: Math.round(x0 + (i % cols) * dx + shift), y: Math.round(LOUNGE.y + CHAR.h + row * dy) };
}

const PRIORITY = { running: 4, queued: 3, review: 2, failed: 1 };
const STATE_OF = { running: 'working', queued: 'queued', review: 'review', failed: 'failed' };

/** Estado visible por agente a partir de sus tareas (la de mayor prioridad; empate → la más reciente). */
export function agentStates(tasks) {
  const out = new Map();
  for (const t of tasks) {
    const p = PRIORITY[t.status];
    if (!p) continue;
    const cur = out.get(t.agent);
    if (!cur || p > cur.p || (p === cur.p && t.id > cur.task.id)) out.set(t.agent, { p, task: t });
  }
  return out;
}

/**
 * agents: [{name}], tasks: [{id, agent, status}].
 * Devuelve { rooms, chars }: chars con posición absoluta (pies del personaje) y estado.
 */
export function layoutOffice(agents, tasks) {
  const states = agentStates(tasks);
  const rooms = ROOM_ORDER.map((id, i) => ({ id, rect: roomRect(i), desks: [] }));
  const chars = [];
  for (const room of rooms) {
    room.desks = DESK_SLOTS.map(([dx, dy]) => ({ x: room.rect.x + dx, y: room.rect.y + dy, w: DESK.w, h: DESK.h, occupied: false }));
  }
  for (const dept of DEPARTMENTS) {
    const room = rooms.find((r) => r.id === dept.id);
    const members = agents.filter((a) => deptOf(a.name) === dept.id)
      .sort((a, b) => (states.get(b.name)?.p ?? 0) - (states.get(a.name)?.p ?? 0) || a.name.localeCompare(b.name));
    let deskIdx = 0;
    let lounge = 0;
    const loungeCount = members.length - Math.min(room.desks.length, members.filter((a) => states.has(a.name)).length);
    for (const a of members) {
      const st = states.get(a.name);
      let x, y, seat;
      if (st && deskIdx < room.desks.length) {
        const d = room.desks[deskIdx++];
        d.occupied = true;
        x = d.x + SEAT.dx; y = d.y + SEAT.dy; seat = 'desk';
      } else {
        const p = loungeSlot(lounge++, loungeCount);
        x = room.rect.x + p.x; y = room.rect.y + p.y; seat = 'lounge';
      }
      chars.push({ agent: a.name, dept: dept.id, x, y, seat, state: st ? STATE_OF[st.task.status] : 'idle', taskId: st?.task.id ?? null });
    }
  }
  return { rooms, chars };
}

/** Avanza `dist` px hacia el destino. Devuelve la nueva posición, si llegó y cuánto se movió. */
export function stepToward(pos, target, dist) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= dist) return { x: target.x, y: target.y, arrived: true, moved: d, dx };
  return { x: pos.x + (dx / d) * dist, y: pos.y + (dy / d) * dist, arrived: false, moved: dist, dx };
}

/** Destino aleatorio cercano a `home` para que los agentes libres deambulen sin salirse de su zona. */
export function wanderTarget(home, rnd = Math.random) {
  return { x: home.x + Math.round((rnd() * 2 - 1) * 14), y: home.y + Math.round((rnd() * 2 - 1) * 4) };
}
