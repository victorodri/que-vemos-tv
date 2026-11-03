import type { Prefs } from "./prefs";
import type { FeedbackEntry } from "./reco/types";

export type MediaType = "movie" | "tv";

export interface Filters {
  type: MediaType;
  genre: number | null;
  maxRuntime: number | null;
  minRating: number | null;
  year: string | null;
  onlyMine: boolean;
  /** Aplicar los gustos del cuestionario cuando un filtro está en «Cualquiera». */
  taste: boolean;
  query: string;
}

export interface Provider {
  id: number;
  name: string;
  logo: string | null;
}

export interface Title {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  rating: number | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  genreIds: number[];
  providers?: Provider[];
  rentOrBuy?: boolean;
}

export interface TitleDetail extends Title {
  runtime: number | null;
  seasons: number | null;
  genres: string[];
  tagline: string;
  link: string | null;
}

/** Versión mínima de un título que se guarda en la lista del perfil. */
export type SavedTitle = Omit<Title, "providers" | "rentOrBuy" | "backdrop" | "genreIds">;

export interface ProfileData {
  watchlist: SavedTitle[];
  /** Claves "movie:123" / "tv:456". */
  seen: string[];
  /** Cuándo se marcó cada vista (epoch ms), clave "movie:123". Los vistos antiguos pueden no tenerla. */
  seenAt?: Record<string, number>;
  platforms: number[];
  lastFilters: Filters | null;
  /** null hasta que el perfil completa el cuestionario inicial. */
  prefs: Prefs | null;
  /** Valoraciones explícitas: clave "movie:123" → me encanta / me gusta / no me gusta / no me interesa. */
  feedback: Record<string, FeedbackEntry>;
}

export interface Genre {
  id: number;
  name: string;
}

export interface Meta {
  genres: Record<MediaType, Genre[]>;
  providers: Provider[];
  storage: "redis" | "local";
}

/** Un título del listado «Vistos» (GET /api/seen). `seenAt` es null si se marcó antes de guardar fechas. */
export type SeenItem = Title & { seenAt: number | null };

export const titleKey = (t: { type: MediaType; id: number }) => `${t.type}:${t.id}`;
