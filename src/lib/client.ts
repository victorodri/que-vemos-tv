import type { SavedTitle, Title } from "./types";

// ---------- Sesión del perfil en este dispositivo ----------
// Cada tele guarda el token de los perfiles en los que ya ha entrado con su PIN: no se vuelve a pedir.

const TOKENS = "quevemos:tokens";
let current: string | null = null;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function readTokens(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOKENS) ?? "{}");
  } catch {
    return {};
  }
}

export const tokenOf = (id: string): string | null => readTokens()[id] ?? null;

export function rememberToken(id: string, token: string | null) {
  const all = readTokens();
  if (token) all[id] = token;
  else delete all[id];
  try {
    localStorage.setItem(TOKENS, JSON.stringify(all));
  } catch {}
}

/** Perfil activo: sus peticiones llevan su token. */
export function setActiveToken(token: string | null) {
  current = token;
}

export const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => (current ? { ...extra, "x-profile-token": current } : extra);

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error ?? `Error ${res.status}`);
  return data as T;
}

export async function sendJSON<T>(url: string, method: "POST" | "PUT" | "PATCH", body: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error ?? `Error ${res.status}`);
  return data as T;
}

export const toSaved = ({ id, type, title, year, rating, overview, poster }: Title | SavedTitle): SavedTitle => ({
  id,
  type,
  title,
  year,
  rating,
  overview,
  poster,
});

export function formatRuntime(min: number | null) {
  if (!min) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** Hash corto de un valor, para forzar recargas cuando cambian datos que el servidor lee del perfil. */
export function hashOf(value: unknown) {
  const s = JSON.stringify(value) ?? "";
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
