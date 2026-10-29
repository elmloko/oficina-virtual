// Rutinas programadas. spec: {type:'daily', time:'HH:MM', days?:[0-6]} | {type:'interval', minutes:N}.
// Las rutinas desatendidas siempre corren en modo solo lectura (nunca editan sin que estés presente).
export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'Programación inválida';
  if (spec.type === 'interval') {
    return Number.isInteger(spec.minutes) && spec.minutes >= 5 && spec.minutes <= 60 * 24 * 7 ? null : 'Intervalo: entre 5 min y 7 días';
  }
  if (spec.type === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time ?? '')) return 'Hora inválida (HH:MM)';
    if (spec.days !== undefined && !(Array.isArray(spec.days) && spec.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) return 'Días inválidos (0=domingo..6)';
    return null;
  }
  return 'Tipo de programación desconocido';
}

/** ¿Le toca correr a esta rutina en `now`? Usa la hora local de `now`. */
export function isDue(schedule, now = new Date()) {
  if (!schedule.enabled) return false;
  const last = new Date(schedule.last_run);
  const { spec } = schedule;
  if (spec.type === 'interval') return now - last >= spec.minutes * 60_000;
  const [h, m] = spec.time.split(':').map(Number);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (spec.days?.length && !spec.days.includes(now.getDay())) return false;
  return now >= slot && last < slot;
}

/** Próxima ejecución prevista (Date). Si ya le toca, devuelve `now`. null si está pausada. */
export function nextRun(schedule, now = new Date()) {
  if (!schedule.enabled) return null;
  const last = new Date(schedule.last_run);
  const { spec } = schedule;
  if (spec.type === 'interval') return new Date(Math.max(now.getTime(), last.getTime() + spec.minutes * 60_000));
  if (isDue(schedule, now)) return new Date(now);
  const [h, m] = spec.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const slot = new Date(now);
    slot.setDate(slot.getDate() + i);
    slot.setHours(h, m, 0, 0);
    if (slot > now && (!spec.days?.length || spec.days.includes(slot.getDay()))) return slot;
  }
  return null;
}

export function createScheduler({ db, runner, emit, now = () => new Date(), logger: log = { info() {}, warn() {}, error() {} } }) {
  let timer = null;

  function runSchedule(s) {
    log.info(`Rutina «${s.name}» lanzada`);
    const task = db.createTask({ title: s.title, description: s.description, project: s.project, agent: s.agent, engine: s.engine, mode: 'read', schedule_id: s.id });
    db.audit('schedule.run', task.id, `${s.name}`);
    emit(task.id);
    try { runner.enqueue(task.id); } catch (e) { db.addEvent(task.id, 'error', e.message); log.warn(`Rutina «${s.name}»: no se pudo encolar (${e.message})`); }
    return task;
  }

  function tick() {
    const fired = [];
    for (const s of db.schedules()) {
      if (!isDue(s, now())) continue;
      db.updateSchedule(s.id, { last_run: now().toISOString() }); // antes de ejecutar: evita doble disparo
      fired.push(runSchedule(s));
    }
    return fired;
  }

  return {
    tick, runSchedule,
    start(ms = 30_000) { timer = setInterval(tick, ms); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}
