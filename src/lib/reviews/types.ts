// Críticas y opiniones de cada título, de varias fuentes, para mostrarlas en la ficha y nutrir el recomendador.
//
// Fuentes (cada una se activa sola si tiene lo que necesita):
//  - tmdb: reseñas de usuarios de TMDB (siempre).
//  - wikipedia: sección «Recepción» / «Reception» de Wikipedia en español e inglés, vía Wikidata (siempre).
//  - rss: blogs y medios de crítica (Espinof, El Mundo, El País, RogerEbert, Variety…), indexados a diario (siempre).
//  - reddit: hilos de r/movies, r/television, r/documentaries… (necesita REDDIT_CLIENT_ID y REDDIT_CLIENT_SECRET).
//  - omdb: notas de Rotten Tomatoes, Metacritic e IMDb (necesita OMDB_API_KEY).
// Solo se guardan y muestran fragmentos cortos con su enlace al original.

export type ReviewSource = "tmdb" | "wikipedia" | "rss" | "reddit";

export interface Review {
  source: ReviewSource;
  /** Medio, blog o subreddit: «Espinof», «r/movies», «Wikipedia», «TMDB». */
  outlet: string;
  author: string | null;
  /** Fragmento destacado (≤ 300 caracteres). */
  excerpt: string;
  url: string | null;
  /** Nota normalizada 0..1 si la fuente la da (estrellas, /10…). */
  score: number | null;
  /** Tono del texto, -1 (muy negativo) .. 1 (muy positivo). */
  sentiment: number;
  lang: "es" | "en";
  date: string | null;
  /** Votos o puntos (Reddit), para ordenar. */
  votes?: number;
  /** Aspectos detectados en el texto completo (no solo en el fragmento). */
  aspects?: string[];
}

export interface CriticScores {
  /** Rotten Tomatoes, % de críticas positivas. */
  rt?: number;
  /** Metacritic, 0..100. */
  metacritic?: number;
  /** IMDb, 0..10. */
  imdb?: number;
}

/** Resumen pequeño que usa el recomendador (se lee en lote para cientos de candidatos). */
export interface ReviewSummary {
  /** Aspectos que destacan las críticas («tensa», «giros», «lenta»…) → peso 0..1. */
  tags: Record<string, number>;
  /** Valoración de la crítica 0..1 (media ponderada de notas y tono), o null sin datos. */
  critic: number | null;
  /** Nº de opiniones en las que se basa. */
  n: number;
}

export interface TitleReviews extends ReviewSummary {
  key: string;
  scores: CriticScores;
  /** Lo más destacado, variado por fuente y por tono. */
  highlights: Review[];
  /** Fuentes consultadas con éxito. */
  sources: ReviewSource[];
  fetchedAt: number;
}

/** Nombre legible de cada aspecto. */
export const TAG_LABEL: Record<string, string> = {
  tensa: "Tensa",
  giros: "Con giros",
  oscura: "Oscura",
  lenta: "Ritmo pausado",
  divertida: "Divertida",
  emotiva: "Emotiva",
  visual: "Visualmente brillante",
  actuaciones: "Grandes interpretaciones",
  guion: "Gran guion",
  cerebral: "Te hace pensar",
  reconfortante: "Reconfortante",
  violenta: "Violenta",
  epica: "Épica",
  adictiva: "Adictiva",
  atmosferica: "Atmosférica",
  realista: "Realista",
  sobrevalorada: "Sobrevalorada",
  aburrida: "Se hace pesada",
};
