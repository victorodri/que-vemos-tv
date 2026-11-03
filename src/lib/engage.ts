import { authHeaders } from "./client";

// Medición de uso en el cliente (ver src/lib/reco/engagement.ts): sesiones, tiras vistas y acciones con su origen.
// Una sesión = una apertura de la app; tras 30 min sin actividad (la tele en segundo plano) empieza otra.
// Los datos van en lotes cada pocos segundos y al salir.

type Action = "open" | "want" | "love" | "like" | "dislike" | "not_interested" | "seen";

const IDLE = 30 * 60_000;
const STORE = "quevemos:session";

let profile: string | null = null;
let session: { id: string; last: number } | null = null;
let views: { shelf: string; title: string; keys: string[] }[] = [];
let actions: { key: string; a: Action; from?: string; t: number }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const reported = new Set<string>();
/** De qué tira o pestaña salió cada título abierto en esta sesión (para atribuir lo que se guarda después). */
const origins = new Map<string, string>();
let pendingOrigin: string | null = null;
const listeners = new Set<() => void>();

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function load(): { id: string; last: number; profile: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "null");
  } catch {
    return null;
  }
}

function persist() {
  try {
    if (session && profile) sessionStorage.setItem(STORE, JSON.stringify({ ...session, profile }));
  } catch {}
}

function reset() {
  session = { id: newId(), last: Date.now() };
  reported.clear();
  origins.clear();
  persist();
  listeners.forEach((l) => l());
}

/** Al entrar en un perfil: retoma la sesión si es reciente; si no, empieza otra. */
export function beginSession(id: string) {
  if (profile && profile !== id) flush();
  profile = id;
  const saved = load();
  if (saved && saved.profile === id && Date.now() - saved.last < IDLE) session = { id: saved.id, last: saved.last };
  else reset();
}

/** Id de la sesión actual (empieza otra si lleva mucho rato inactiva). */
export function sessionId(): string {
  if (!session || Date.now() - session.last > IDLE) reset();
  return session!.id;
}

/** Avisa cuando empieza una sesión nueva (para refrescar las tiras al volver a la app). */
export function onNewSession(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function touch() {
  sessionId();
  session!.last = Date.now();
  persist();
  if (!timer) timer = setTimeout(flush, 5000);
}

export function viewShelf(shelf: string, title: string, keys: string[]) {
  const fresh = keys.filter((k) => !reported.has(`${shelf}|${k}`));
  if (reported.has(shelf) && !fresh.length) return;
  reported.add(shelf);
  fresh.forEach((k) => reported.add(`${shelf}|${k}`));
  views.push({ shelf, title, keys: fresh });
  touch();
}

/** La próxima ficha que se abra viene de esta tira. */
export function setOrigin(shelf: string) {
  pendingOrigin = shelf;
}

export function track(key: string, a: Action, fallbackFrom?: string) {
  let from = origins.get(key);
  if (a === "open") {
    from = pendingOrigin ?? fallbackFrom;
    pendingOrigin = null;
    if (from) origins.set(key, from);
  }
  actions.push({ key, a, from: from ?? fallbackFrom, t: Date.now() });
  touch();
}

export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!profile || !session || (!views.length && !actions.length)) return;
  const body = JSON.stringify({ profile, session: session.id, views, actions });
  views = [];
  actions = [];
  fetch("/api/engage", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body, keepalive: true }).catch(() => {});
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    // Al volver a la app tras un rato: sesión nueva (y las tiras se renuevan).
    else if (session && Date.now() - session.last > IDLE) reset();
  });
  window.addEventListener("pagehide", flush);
}
