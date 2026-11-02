import type { SavedTitle, Title } from "./types";

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
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
