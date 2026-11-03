"use client";
// Sonidos sutiles de interfaz generados con Web Audio API (sin archivos): un «tic» al mover el foco y un «toc»
// algo más grave y redondo al pulsar OK. El AudioContext solo puede arrancar tras un gesto del usuario
// (también en el WebView de Android), así que se crea/reanuda con la primera pulsación de tecla o toque.

const KEY = "quevemos:sound";
const THROTTLE_MS = 40;

let ctx: AudioContext | null = null;
let enabled: boolean | null = null;
let last = 0;
let unlockInstalled = false;

export function soundEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = localStorage.getItem(KEY) !== "off";
    } catch {
      enabled = true;
    }
  }
  return enabled;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
  if (on) {
    unlock();
    playSelect();
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

function unlock() {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

/** Instala (una vez) los oyentes que desbloquean el audio con la primera interacción. */
export function installSoundUnlock() {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  const onGesture = () => {
    if (!soundEnabled()) return;
    unlock();
    if (ctx?.state === "running") {
      window.removeEventListener("keydown", onGesture, true);
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("touchend", onGesture, true);
    }
  };
  window.addEventListener("keydown", onGesture, true);
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("touchend", onGesture, true);
}

function blip(freq: number, endFreq: number, dur: number, gain: number, type: OscillatorType) {
  if (!soundEnabled()) return;
  const now = performance.now();
  if (now - last < THROTTLE_MS) return;
  last = now;
  const c = getCtx();
  if (!c || c.state !== "running") return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  // Ataque muy corto y caída exponencial: suena a «tic», no a pitido.
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Mover el foco (flechas). */
export function playMove() {
  blip(1250, 1050, 0.045, 0.035, "sine");
}

/** Pulsar OK / activar un botón. */
export function playSelect() {
  blip(620, 880, 0.09, 0.06, "triangle");
}
