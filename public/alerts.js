// Avisos: sonidos al estilo Star Wars generados con Web Audio (sin archivos de audio) y notificaciones del navegador.
import { KIND_LABEL } from './attention.js';

const KEY = 'oficina.alerts';

// cada skin sube o baja el tono de todos los sonidos (Imperio y Lado Oscuro, más graves; Hoth y Jedi, más agudos)
const PITCH = {
  clasico: 1, imperio: 0.78, rebelion: 0.95, tatooine: 0.88, jedi: 1.1, hoth: 1.2, mandaloriano: 0.85, sith: 0.72, rogue: 1,
};

/** Qué suena con cada aviso. */
export const SOUNDS = {
  done: 'sable de luz que se enciende',
  question: 'droide que pregunta',
  plan: 'motor hiperespacial cargando',
  failed: 'dos disparos de blaster y una explosión',
};

const store = {
  get() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } },
  set(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* sin almacenamiento: vale esta sesión */ } },
};

// ---- piezas de síntesis ----
/** Oscilador con barrido de frecuencia (exponencial) y envolvente de volumen. */
function tone(ctx, dest, { type = 'sine', f0, f1 = f0, t, dur, vol = 0.12, attack = 0.01, release = 0.05, detune = 0 }) {
  const osc = ctx.createOscillator(); const g = ctx.createGain();
  osc.type = type; osc.detune.value = detune;
  osc.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.setValueAtTime(vol, Math.max(t + attack, t + dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t); osc.stop(t + dur + 0.02);
  return { osc, gain: g };
}

/** Ruido filtrado (chispas, explosiones, viento del hiperespacio). */
function noise(ctx, dest, { t, dur, vol = 0.1, type = 'bandpass', f0 = 1000, f1 = f0, q = 1 }) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const filter = ctx.createBiquadFilter(); filter.type = type; filter.Q.value = q;
  filter.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.03, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(dest);
  src.start(t); src.stop(t + dur);
}

// ---- los cuatro sonidos ----
const PLAY = {
  /** Sable de luz: encendido con barrido, zumbido con vibrato y un golpe grave al final. */
  done(ctx, out, t, p) {
    noise(ctx, out, { t, dur: 0.12, vol: 0.06, type: 'highpass', f0: 3000, q: 0.7 }); // chispa de ignición
    tone(ctx, out, { type: 'sawtooth', f0: 70 * p, f1: 150 * p, t, dur: 0.32, vol: 0.09, attack: 0.03 }); // sube la hoja
    for (const d of [0, 14]) { // zumbido: dos ondas ligeramente desafinadas
      const hum = tone(ctx, out, { type: 'sawtooth', f0: 150 * p, t: t + 0.22, dur: 0.62, vol: 0.07, attack: 0.05, release: 0.3, detune: d });
      const lfo = ctx.createOscillator(); const depth = ctx.createGain();
      lfo.frequency.value = 11; depth.gain.value = 7 * p;
      lfo.connect(depth).connect(hum.osc.frequency);
      lfo.start(t + 0.22); lfo.stop(t + 0.86);
    }
    tone(ctx, out, { type: 'sine', f0: 190 * p, f1: 95 * p, t: t + 0.5, dur: 0.34, vol: 0.06, attack: 0.02 }); // «swoosh» al mover la hoja
  },
  /** Droide (estilo R2): trinos rápidos con vibrato. */
  question(ctx, out, t, p) {
    const notes = [1400, 2100, 1100, 2500, 1700, 2300, 1300];
    notes.forEach((f, i) => {
      const at = t + i * 0.075;
      const dur = i === notes.length - 1 ? 0.18 : 0.065;
      const { osc } = tone(ctx, out, { type: i % 2 ? 'square' : 'triangle', f0: f * p, f1: (i % 2 ? f * 1.35 : f * 0.75) * p, t: at, dur, vol: 0.06, attack: 0.008, release: 0.02 });
      const lfo = ctx.createOscillator(); const depth = ctx.createGain();
      lfo.frequency.value = 38; depth.gain.value = 60 * p;
      lfo.connect(depth).connect(osc.frequency); lfo.start(at); lfo.stop(at + dur + 0.02);
    });
  },
  /** Motor hiperespacial: se carga con un silbido ascendente y un empuje final. */
  plan(ctx, out, t, p) {
    noise(ctx, out, { t, dur: 0.75, vol: 0.12, type: 'bandpass', f0: 250 * p, f1: 5000 * p, q: 3 });
    tone(ctx, out, { type: 'sawtooth', f0: 80 * p, f1: 880 * p, t, dur: 0.7, vol: 0.05, attack: 0.1, release: 0.15 });
    tone(ctx, out, { type: 'sine', f0: 120 * p, f1: 55 * p, t: t + 0.62, dur: 0.3, vol: 0.12, attack: 0.01 }); // empuje al saltar
  },
  /** Blaster: dos disparos «pew pew» y una explosión sorda. */
  failed(ctx, out, t, p) {
    [0, 0.2].forEach((off, i) => {
      const at = t + off;
      tone(ctx, out, { type: 'square', f0: (2400 - i * 300) * p, f1: 160 * p, t: at, dur: 0.17, vol: 0.09, attack: 0.004, release: 0.12 });
      tone(ctx, out, { type: 'sawtooth', f0: (1200 - i * 150) * p, f1: 90 * p, t: at, dur: 0.17, vol: 0.05, attack: 0.004, release: 0.12 });
      noise(ctx, out, { t: at, dur: 0.05, vol: 0.05, type: 'highpass', f0: 4000 });
    });
    noise(ctx, out, { t: t + 0.46, dur: 0.5, vol: 0.2, type: 'lowpass', f0: 900, f1: 80, q: 0.8 }); // explosión
    tone(ctx, out, { type: 'sine', f0: 90 * p, f1: 35, t: t + 0.46, dur: 0.45, vol: 0.14, attack: 0.01 });
  },
};

export function createAlerts({ skinId, onOpen, notify = (typeof Notification !== 'undefined' ? Notification : null) }) {
  let enabled = store.get();
  let ctx = null;

  function beep(kind) {
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const out = ctx.createGain(); out.gain.value = 2; // los sonidos son suaves: se amplifican y el compresor evita saturar
      const comp = ctx.createDynamicsCompressor(); // evita saturaciones cuando se mezclan varias capas
      out.connect(comp).connect(ctx.destination);
      (PLAY[kind] ?? PLAY.done)(ctx, out, ctx.currentTime + 0.03, PITCH[skinId()] ?? 1);
    } catch { /* sin audio disponible: no pasa nada */ }
  }

  return {
    get enabled() { return enabled; },
    /** Debe llamarse desde un gesto del usuario (desbloquea el audio). */
    setEnabled(v) {
      enabled = !!v; store.set(enabled);
      if (enabled) beep('done');
      return enabled;
    },
    /** Deja el audio listo tras un gesto del usuario (los navegadores bloquean el sonido hasta entonces, p. ej. al recargar la página con los avisos ya activados). */
    unlock() { try { ctx ??= new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* sin audio */ } },
    /** Reproduce un sonido de prueba (también con los avisos desactivados). Debe venir de un gesto del usuario. */
    preview(kind) { beep(kind); },
    /** Pide permiso de notificaciones del navegador (puede tardar: espera la respuesta del usuario). */
    async ensurePermission() {
      if (!notify) return 'unsupported';
      if (notify.permission !== 'default') return notify.permission;
      return notify.requestPermission().catch(() => 'denied');
    },
    /** Avisa de un evento (ver `transition`). Devuelve true si avisó. */
    fire({ kind, task }) {
      if (!enabled) return false;
      beep(kind);
      if (notify && notify.permission === 'granted' && document.hidden) {
        const n = new notify(`${KIND_LABEL[kind] ?? 'Aviso'} · ${task.agent === 'coordinador' ? 'coordinador' : task.agent}`, {
          body: `#${task.id} ${task.title}`, tag: `task-${task.id}`,
        });
        n.onclick = () => { window.focus(); onOpen?.(task); n.close(); };
      }
      return true;
    },
  };
}
