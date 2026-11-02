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
