export type MediaType = "movie" | "tv";

export interface Filters {
  type: MediaType;
  genre: number | null;
  maxRuntime: number | null;
  minRating: number | null;
  year: string | null;
  onlyMine: boolean;
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
  platforms: number[];
  lastFilters: Filters | null;
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

export const titleKey = (t: { type: MediaType; id: number }) => `${t.type}:${t.id}`;
