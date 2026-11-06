import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEPARTMENTS, CANVAS, CHAR, ROOM_ORDER, deptOf, layoutOffice, agentStates, roomRect, stepToward, wanderTarget } from './office-layout.js';

const names = (list) => list.map((name) => ({ name }));

test('deptOf: agentes conocidos, palabras clave y valor por defecto', () => {
  assert.equal(deptOf('backend'), 'hangar');
  assert.equal(deptOf('security'), 'inteligencia');
  assert.equal(deptOf('devops'), 'flota');
  assert.equal(deptOf('researcher'), 'reconocimiento');
  assert.equal(deptOf('seo-writer'), 'diplomacia'); // por palabra clave
  assert.equal(deptOf('algo-raro'), 'hangar');
});

test('deptOf: agentes en español van a la sala de su equivalente en inglés', () => {
  assert.equal(deptOf('arquitecto'), deptOf('architect'));
  assert.equal(deptOf('revisor'), deptOf('reviewer'));
  assert.equal(deptOf('seguridad'), deptOf('security'));
  assert.equal(deptOf('documentador'), deptOf('docs'));
  assert.equal(deptOf('depurador'), deptOf('debugger'));
  assert.equal(deptOf('rendimiento'), deptOf('performance'));
  assert.equal(deptOf('base-datos'), deptOf('dba'));
  // agentes futuros por palabra clave en español
  assert.equal(deptOf('arquitecto-cloud'), 'mando');
  assert.equal(deptOf('pruebas-carga'), 'inteligencia');
  assert.equal(deptOf('diseñador-web'), 'taller');
  assert.equal(deptOf('investigador'), 'reconocimiento');
  assert.equal(deptOf('redactor'), 'diplomacia');
});

test('ningún agente aparece en dos departamentos', () => {
  const seen = new Set();
  for (const d of DEPARTMENTS) for (const a of d.agents) { assert.ok(!seen.has(a), `duplicado: ${a}`); seen.add(a); }
});

test('todos los agentes reales de ~/.claude/agents tienen sala', () => {
  let files = [];
  try { files = readdirSync(join(homedir(), '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch { return; }
  const { chars } = layoutOffice(names(files), []);
  assert.equal(chars.length, files.length);
  for (const c of chars) assert.ok(ROOM_ORDER.includes(c.dept));
});

test('layout: una posición por agente, dentro de su sala y sin solaparse', () => {
  const agents = names(DEPARTMENTS.flatMap((d) => d.agents));
  const { rooms, chars } = layoutOffice(agents, []);
  assert.equal(chars.length, agents.length);
  const seen = new Set();
  for (const c of chars) {
    const room = rooms.find((r) => r.id === c.dept).rect;
    assert.ok(c.x - CHAR.w / 2 >= room.x && c.x + CHAR.w / 2 <= room.x + room.w, `${c.agent} fuera de la sala (x)`);
    assert.ok(c.y - CHAR.h >= room.y && c.y <= room.y + room.h, `${c.agent} fuera de la sala (y)`);
    const k = `${c.x},${c.y}`;
    assert.ok(!seen.has(k), `${c.agent} solapado`);
    seen.add(k);
    assert.equal(c.state, 'idle');
  }
});

test('salas abarrotadas: todos dentro (incluido el margen de deambular) y sin posiciones repetidas', () => {
  for (const n of [16, 17, 18, 25, 40, 60]) {
    const agents = names(Array.from({ length: n }, (_, i) => `zz-agente-${i}`)); // nombres desconocidos → todos al hangar
    const tasks = [{ id: 1, agent: 'zz-agente-0', status: 'running' }];
    const { rooms, chars } = layoutOffice(agents, tasks);
    const room = rooms.find((r) => r.id === 'hangar').rect;
    const seen = new Set();
    for (const c of chars) {
      const slack = c.seat === 'lounge' ? { x: 14, y: 4 } : { x: 0, y: 0 }; // wanderTarget
      assert.ok(c.x - CHAR.w / 2 - slack.x >= room.x && c.x + CHAR.w / 2 + slack.x <= room.x + room.w, `n=${n}: ${c.agent} fuera de la sala (x=${c.x - room.x})`);
      assert.ok(c.y - CHAR.h >= room.y && c.y + slack.y <= room.y + room.h, `n=${n}: ${c.agent} fuera de la sala (y=${c.y - room.y})`);
      assert.ok(!seen.has(`${c.x},${c.y}`), `n=${n}: ${c.agent} solapado`);
      seen.add(`${c.x},${c.y}`);
    }
  }
});

test('las salas caben en el lienzo y no se solapan', () => {
  const rects = ROOM_ORDER.map((_, i) => roomRect(i));
  for (const r of rects) { assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= CANVAS.w && r.y + r.h <= CANVAS.h); }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `salas ${i} y ${j} se solapan`);
  }
});

test('estados: prioridad running > queued > review > failed; done/backlog = idle', () => {
  const tasks = [
    { id: 1, agent: 'backend', status: 'failed' },
    { id: 2, agent: 'backend', status: 'review' },
    { id: 3, agent: 'backend', status: 'running' },
    { id: 4, agent: 'tester', status: 'done' },
    { id: 5, agent: 'tester', status: 'backlog' },
    { id: 6, agent: 'devops', status: 'review' },
    { id: 7, agent: 'devops', status: 'review' },
  ];
  const st = agentStates(tasks);
  assert.equal(st.get('backend').task.id, 3);
  assert.ok(!st.has('tester'));
  assert.equal(st.get('devops').task.id, 7); // empate → la más reciente
});

test('agentes activos ocupan escritorio y los inactivos van a la zona de descanso', () => {
  const agents = names(['backend', 'frontend', 'dba', 'fullstack', 'mobile', 'refactor']);
  const tasks = [
    { id: 1, agent: 'mobile', status: 'running' },
    { id: 2, agent: 'refactor', status: 'queued' },
    { id: 3, agent: 'dba', status: 'review' },
  ];
  const { rooms, chars } = layoutOffice(agents, tasks);
  const by = Object.fromEntries(chars.map((c) => [c.agent, c]));
  assert.equal(by.mobile.seat, 'desk');
  assert.equal(by.mobile.state, 'working');
  assert.equal(by.mobile.taskId, 1);
  assert.equal(by.refactor.state, 'queued');
  assert.equal(by.dba.state, 'review');
  assert.equal(by.backend.seat, 'lounge');
  assert.equal(by.backend.taskId, null);
  const hangar = rooms.find((r) => r.id === 'hangar');
  assert.equal(hangar.desks.filter((d) => d.occupied).length, 3);
});

test('más de 4 agentes activos en una sala: los extra pasan a la zona de descanso con su estado', () => {
  const list = ['backend', 'frontend', 'fullstack', 'dba', 'mobile'];
  const tasks = list.map((agent, i) => ({ id: i + 1, agent, status: 'running' }));
  const { chars } = layoutOffice(names(list), tasks);
  assert.equal(chars.filter((c) => c.seat === 'desk').length, 4);
  const extra = chars.find((c) => c.seat === 'lounge');
  assert.equal(extra.state, 'working');
  assert.ok(extra.taskId);
});

test('los sprites de la zona de descanso no se tapan entre sí', () => {
  const agents = names(DEPARTMENTS.find((d) => d.id === 'hangar').agents);
  const { chars } = layoutOffice(agents, []);
  for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) {
    const a = chars[i], b = chars[j];
    const overlap = Math.abs(a.x - b.x) < CHAR.w && Math.abs(a.y - b.y) < CHAR.h;
    assert.ok(!overlap, `${a.agent} y ${b.agent} se tapan`);
  }
});

test('los escritorios no se solapan entre sí y el personaje queda a la izquierda del monitor', () => {
  const { rooms } = layoutOffice([], []);
  const d = rooms[0].desks;
  for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) {
    assert.ok(d[i].x + d[i].w <= d[j].x || d[j].x + d[j].w <= d[i].x || d[i].y + d[i].h <= d[j].y || d[j].y + d[j].h <= d[i].y);
  }
  const { chars } = layoutOffice(names(['backend']), [{ id: 1, agent: 'backend', status: 'running' }]);
  const desk = layoutOffice(names(['backend']), [{ id: 1, agent: 'backend', status: 'running' }]).rooms.find((r) => r.id === 'hangar').desks[0];
  assert.ok(chars[0].x < desk.x + desk.w / 2);
});

test('stepToward: avanza, no se pasa del destino y reporta llegada', () => {
  const a = stepToward({ x: 0, y: 0 }, { x: 30, y: 40 }, 10);
  assert.equal(a.arrived, false);
  assert.ok(Math.abs(Math.hypot(a.x, a.y) - 10) < 1e-9);
  const b = stepToward({ x: 28, y: 39 }, { x: 30, y: 40 }, 10);
  assert.deepEqual([b.x, b.y, b.arrived], [30, 40, true]);
  assert.equal(stepToward({ x: 5, y: 5 }, { x: 5, y: 5 }, 3).arrived, true);
});

test('wanderTarget: siempre cerca del punto de origen', () => {
  const home = { x: 100, y: 200 };
  for (let i = 0; i < 200; i++) {
    const t = wanderTarget(home);
    assert.ok(Math.abs(t.x - home.x) <= 14 && Math.abs(t.y - home.y) <= 4);
  }
  assert.deepEqual(wanderTarget(home, () => 0.5), home);
});
