// Distribución de la oficina: lógica pura (sin canvas) para poder probarla en Node.
export const CANVAS = { w: 1200, h: 620 };
const MARGIN = 8;
const COLS = 4;
const ROOM_W = (CANVAS.w - MARGIN * (COLS + 1)) / COLS; // 290
const ROOM_H = (CANVAS.h - MARGIN * 3) / 2; // 298
export const ROOM = { w: ROOM_W, h: ROOM_H };

export const DEPARTMENTS = [
  { id: 'mando', label: 'Puente de Mando', color: '#ffd84a', agents: ['architect', 'spec-writer', 'api-designer', 'reviewer', 'claude'] },
  { id: 'hangar', label: 'Hangar de Ingeniería', color: '#ff9a3c', agents: ['backend', 'frontend', 'fullstack', 'dba', 'integrator', 'mobile', 'refactor', 'migrator', 'debugger', 'performance', 'figma-to-code'] },
  { id: 'inteligencia', label: 'Inteligencia Rebelde', color: '#ff5a5a', agents: ['tester', 'e2e', 'security', 'a11y', 'responsive', 'deps-auditor', 'netsec'] },
  { id: 'flota', label: 'Flota y Operaciones', color: '#4aa3ff', agents: ['devops', 'cicd', 'sre', 'cloud', 'iac', 'k8s', 'backup-dr', 'cost-optimizer', 'windows-admin'] },
  { id: 'diplomacia', label: 'Diplomacia y Negocio', color: '#d9c7a0', agents: ['proposal', 'reporter', 'copywriter', 'analyst', 'brand', 'legal-docs', 'presentation', 'landing', 'docs', 'pr-writer', 'translator'] },
  { id: 'taller', label: 'Taller de Droides', color: '#b18cff', agents: ['designer', 'ui-designer', 'design-system', 'illustrator', 'motion', 'dataviz', 'ux-researcher'] },
  { id: 'reconocimiento', label: 'Reconocimiento', color: '#4ade80', agents: ['researcher', 'scraper', 'summarizer'] },
];
export const OPS_ROOM = { id: 'ops', label: 'Sala de Operaciones', color: '#7dd3fc' };

const DEPT_BY_AGENT = new Map(DEPARTMENTS.flatMap((d) => d.agents.map((a) => [a, d.id])));
const KEYWORDS = [
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
const DESK_SLOTS = [[18, 44], [160, 44], [18, 128], [160, 128]];
export const DESK = { w: 112, h: 52 };
const LOUNGE = { x: 16, y: 226, dx: 30, dy: 26, cols: 9 };

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
    for (const a of members) {
      const st = states.get(a.name);
      let x, y, seat;
      if (st && deskIdx < room.desks.length) {
        const d = room.desks[deskIdx++];
        d.occupied = true;
        x = d.x + d.w / 2; y = d.y + d.h + 22; seat = 'desk';
      } else {
        const col = lounge % LOUNGE.cols;
        const row = Math.floor(lounge++ / LOUNGE.cols);
        x = room.rect.x + LOUNGE.x + col * LOUNGE.dx + 10; y = room.rect.y + LOUNGE.y + row * LOUNGE.dy + 28; seat = 'lounge';
      }
      chars.push({ agent: a.name, dept: dept.id, x, y, seat, state: st ? STATE_OF[st.task.status] : 'idle', taskId: st?.task.id ?? null });
    }
  }
  return { rooms, chars };
}
