// Avisos: sonido (Web Audio, con timbre por skin) y notificaciones del navegador.
import { KIND_LABEL } from './attention.js';

const KEY = 'oficina.alerts';

// timbre por skin: forma de onda y nota base (Hz)
const SFX = {
  clasico: ['sine', 523], imperio: ['sawtooth', 196], rebelion: ['square', 440], tatooine: ['triangle', 330],
  jedi: ['sine', 587], hoth: ['triangle', 659], mandaloriano: ['square', 247], sith: ['sawtooth', 147], rogue: ['square', 392],
};
// notas relativas (semitonos) y duración por tipo de aviso
const MELODY = {
  done: [0, 7], question: [0, 4, 7], plan: [0, 5, 9], failed: [7, 0, -5],
};
const semis = (n) => 2 ** (n / 12);

const store = {
  get() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } },
  set(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* sin almacenamiento: vale esta sesión */ } },
};

export function createAlerts({ skinId, onOpen, notify = (typeof Notification !== 'undefined' ? Notification : null) }) {
  let enabled = store.get();
  let ctx = null;

  function beep(kind) {
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const [wave, base] = SFX[skinId()] ?? SFX.clasico;
      let t = ctx.currentTime + 0.02;
      for (const n of MELODY[kind] ?? MELODY.done) {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = wave; osc.frequency.value = base * semis(n);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.18);
        t += 0.14;
      }
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
