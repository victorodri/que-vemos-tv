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

// «Forma de ser» frente a la pantalla: cada respuesta empuja aspectos que detectan las críticas (src/lib/reviews).
export const PERSONA_QUESTIONS = [
  {
    id: "mind",
    q: "Cuando te pones algo, ¿qué buscas?",
    options: [
      { v: 1, label: "Que me haga pensar", emoji: "🧠", tags: { cerebral: 1, giros: 0.4 } },
      { v: -1, label: "Desconectar", emoji: "🛋️", tags: { reconfortante: 0.8, divertida: 0.6, cerebral: -0.4 } },
      { v: 0, label: "Depende del día", emoji: "🤷", tags: {} },
    ],
  },
  {
    id: "dark",
    q: "¿Historias oscuras y duras?",
    options: [
      { v: 1, label: "Cuanto más crudas, mejor", emoji: "🌑", tags: { oscura: 1, violenta: 0.5, realista: 0.4 } },
      { v: -1, label: "Prefiero algo luminoso", emoji: "☀️", tags: { oscura: -0.8, violenta: -0.8, reconfortante: 0.5 } },
      { v: 0, label: "Me da igual", emoji: "🤷", tags: {} },
    ],
  },
  {
    id: "pace",
    q: "¿Paciencia con los ritmos pausados?",
    options: [
      { v: 1, label: "Me encantan las historias a fuego lento", emoji: "🐢", tags: { lenta: 0.8, atmosferica: 0.6 } },
      { v: -1, label: "Que no pare", emoji: "⚡", tags: { lenta: -1, tensa: 0.7, adictiva: 0.5 } },
      { v: 0, label: "Según cómo esté contada", emoji: "🤷", tags: {} },
    ],
  },
  {
    id: "feel",
    q: "¿Te gusta que una historia te emocione?",
    options: [
      { v: 1, label: "Sí, aunque acabe llorando", emoji: "😭", tags: { emotiva: 1 } },
      { v: -1, label: "Prefiero no sufrir", emoji: "🙅", tags: { emotiva: -0.6, divertida: 0.4 } },
      { v: 0, label: "Con moderación", emoji: "🤷", tags: {} },
    ],
  },
  {
    id: "craft",
    q: "¿Qué te importa más?",
    options: [
      { v: 1, label: "El guion y los diálogos", emoji: "✍️", tags: { guion: 1, actuaciones: 0.5 } },
      { v: 2, label: "Que entre por los ojos", emoji: "🎨", tags: { visual: 1, epica: 0.6 } },
      { v: 3, label: "Los giros y sorpresas", emoji: "🌀", tags: { giros: 1, tensa: 0.4 } },
      { v: 0, label: "Un poco de todo", emoji: "🤷", tags: {} },
    ],
  },
] as const;

export type PersonaId = (typeof PERSONA_QUESTIONS)[number]["id"];

/** Respuestas → pesos de aspecto (`tensa` → 0.7). */
export function personaTags(persona: Prefs["persona"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of PERSONA_QUESTIONS) {
    const opt = (q.options as readonly { v: number; tags: Record<string, number> }[]).find((o) => o.v === persona?.[q.id]);
    for (const [t, w] of Object.entries(opt?.tags ?? {})) out[t] = (out[t] ?? 0) + w;
  }
  return out;
}

export interface Prefs {
  types: MediaType[];
  likes: GenreGroupId[];
  avoid: GenreGroupId[];
  runtime: "short" | "normal" | "any";
  era: "new" | "modern" | "any";
  quality: "top" | "good" | "any";
  discovery: "popular" | "hidden" | "mix";
  /** Forma de ser (PERSONA_QUESTIONS): id de pregunta → valor de la opción elegida. */
  persona?: Partial<Record<PersonaId, number>>;
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
    persona: sanitizePersona(r.persona),
  };
}

function sanitizePersona(raw: unknown): Prefs["persona"] {
  if (!raw || typeof raw !== "object") return {};
  const out: Prefs["persona"] = {};
  for (const q of PERSONA_QUESTIONS) {
    const v = (raw as Record<string, unknown>)[q.id];
    if (q.options.some((o) => o.v === v)) out[q.id] = v as number;
  }
  return out;
}
