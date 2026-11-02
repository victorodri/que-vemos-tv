import type { MediaType } from "./types";

// Gustos que se preguntan en el cuestionario inicial. Los géneros de TMDB son distintos
// en pelis y series, así que cada grupo indica sus IDs para cada tipo ([] = no existe).
export const GENRE_GROUPS = [
  { id: "comedy", label: "Comedia", emoji: "😂", movie: [35], tv: [35] },
  { id: "drama", label: "Drama", emoji: "🎭", movie: [18], tv: [18] },
  { id: "action", label: "Acción y aventura", emoji: "💥", movie: [28, 12], tv: [10759] },
  { id: "thriller", label: "Suspense y thriller", emoji: "🔪", movie: [53], tv: [9648] },
  { id: "crime", label: "Crimen", emoji: "🕵️", movie: [80], tv: [80] },
  { id: "scifi", label: "Ciencia ficción y fantasía", emoji: "🚀", movie: [878, 14], tv: [10765] },
  { id: "horror", label: "Terror", emoji: "👻", movie: [27], tv: [] },
  { id: "romance", label: "Romance", emoji: "❤️", movie: [10749], tv: [] },
  { id: "animation", label: "Animación", emoji: "🧸", movie: [16], tv: [16] },
  { id: "family", label: "Familiar", emoji: "👨‍👩‍👧", movie: [10751], tv: [10751, 10762] },
  { id: "documentary", label: "Documentales", emoji: "🌍", movie: [99], tv: [99] },
  { id: "history", label: "Historia y bélico", emoji: "⚔️", movie: [36, 10752], tv: [10768] },
  { id: "reality", label: "Realities", emoji: "📺", movie: [], tv: [10764] },
] as const;

export type GenreGroupId = (typeof GENRE_GROUPS)[number]["id"];

export interface Prefs {
  types: MediaType[];
  likes: GenreGroupId[];
  avoid: GenreGroupId[];
  runtime: "short" | "normal" | "any";
  era: "new" | "modern" | "any";
  quality: "top" | "good" | "any";
  discovery: "popular" | "hidden" | "mix";
}

export const DEFAULT_PREFS: Prefs = {
  types: ["movie", "tv"],
  likes: [],
  avoid: [],
  runtime: "any",
  era: "any",
  quality: "good",
  discovery: "mix",
};

const groupIds = (ids: readonly string[], type: MediaType) =>
  GENRE_GROUPS.filter((g) => ids.includes(g.id)).flatMap((g) => g[type] as readonly number[]);

/** Parámetros de discover que salen de los gustos. Los filtros explícitos del usuario mandan sobre estos. */
export function prefsToDiscover(p: Prefs, type: MediaType) {
  const now = new Date().getFullYear();
  return {
    withGenres: groupIds(p.likes, type),
    withoutGenres: groupIds(p.avoid, type),
    maxRuntime: p.runtime === "short" ? (type === "movie" ? 100 : 30) : p.runtime === "normal" ? (type === "movie" ? 130 : 50) : null,
    fromYear: p.era === "new" ? now - 4 : p.era === "modern" ? 2000 : null,
    minRating: p.quality === "top" ? 7.5 : p.quality === "good" ? 6.5 : null,
    discovery: p.discovery,
  };
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

export function sanitizePrefs(raw: unknown): Prefs | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ids = GENRE_GROUPS.map((g) => g.id) as GenreGroupId[];
  const list = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => ids.includes(x)) as GenreGroupId[]) : []);
  const types = Array.isArray(r.types) ? (r.types.filter((t) => t === "movie" || t === "tv") as MediaType[]) : [];
  return {
    types: types.length ? types : DEFAULT_PREFS.types,
    likes: list(r.likes),
    avoid: list(r.avoid),
    runtime: pick(r.runtime, ["short", "normal", "any"], "any"),
    era: pick(r.era, ["new", "modern", "any"], "any"),
    quality: pick(r.quality, ["top", "good", "any"], "good"),
    discovery: pick(r.discovery, ["popular", "hidden", "mix"], "mix"),
  };
}
