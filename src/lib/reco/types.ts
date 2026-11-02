// Contrato del motor de recomendación. Lo comparten el servidor (src/lib/reco/*, /api/reco, /api/feedback)
// y la interfaz (onboarding, botones de feedback, estanterías de «Para ti»).
//
// Visión general (inspirado en los recomendadores de e-commerce tipo Shopify):
//  1. Cada título se describe con un vector disperso de rasgos (géneros, palabras clave, personas, década, idioma…).
//  2. Cada perfil tiene un vector de gustos que se aprende sumando los rasgos de lo que marca (me encanta,
//     me gusta, no me gusta, no me interesa, lo añade a su lista, lo ve, lo abre, lo salta…), con olvido en el tiempo.
//  3. Los candidatos salen de varias fuentes («vinculaciones»): parecidos a lo que le gustó (grafo título→título
//     de TMDB), descubrimiento por rasgos favoritos, tendencias en España, joyas ocultas y obras de sus personas favoritas.
//  4. Ranking = afinidad con el vector + calidad bayesiana + novedad/descubrimiento, con diversificación (MMR)
//     y una razón legible para cada recomendación.
//  5. El perfil «pareja» mezcla su propio vector con los de Víctor y Alba buscando lo que gusta a ambos.

import type { MediaType, Title } from "../types";

/** Valoración explícita de un título. */
export type Signal = "love" | "like" | "dislike" | "not_interested";

/** Eventos implícitos (más débiles) que también entrenan el modelo. */
export type ImplicitEvent = "open" | "skip" | "want" | "unwant" | "seen" | "unseen";

export interface FeedbackEntry {
  s: Signal;
  /** epoch ms */
  t: number;
}

/** Evento guardado en el historial del perfil (lista en Redis, últimos ~2000). */
export interface RecoEvent {
  /** Clave "movie:123" / "tv:456". */
  k: string;
  e: Signal | ImplicitEvent | "clear";
  t: number;
}

/**
 * Rasgos de un título, cacheados en la base de datos (se refrescan cada ~30 días).
 * Claves de rasgo:
 *   g:<genreId>  k:<keywordId>  p:<personId> (reparto principal)  c:<personId> (dirección/creación)
 *   d:<década p.ej. 2010>  l:<idioma original>  t:<movie|tv>  r:<short|medium|long>
 */
export interface ItemFeatures {
  key: string;
  type: MediaType;
  id: number;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number | null;
  voteCount: number;
  popularity: number;
  genreIds: number[];
  /** Vector disperso de rasgos → peso (0..1). */
  f: Record<string, number>;
  /** Títulos relacionados según TMDB (recommendations + similar), como claves "movie:1". */
  related: string[];
  /** Nombres legibles de algunos rasgos, para explicar recomendaciones ("k:9882" → "espacio"). */
  labels: Record<string, string>;
  fetchedAt: number;
}

/** Vector de gustos aprendido de un perfil. */
export interface TasteModel {
  /** Peso por rasgo (positivo = le gusta, negativo = no). */
  w: Record<string, number>;
  /** Títulos con valoración positiva fuerte, para la fuente «porque te gustó X» (claves, más recientes primero). */
  anchors: string[];
  /** Títulos a no recomendar en «Para ti» (vistos, en la lista, ya valorados, rechazados). */
  blocked: string[];
  /** Solo los rechazados explícitamente (no me gusta / no me interesa). */
  rejected: string[];
  /** En la pareja: de quién es cada ancla que no es de la propia pareja (clave → id de perfil). */
  anchorOwner?: Record<string, string>;
  /** Nº de señales usadas: sirve para decidir cuánto explorar. */
  signals: number;
  updatedAt: number;
  version: number;
}

export type ShelfId = "top" | "because" | "discover" | "trending" | "gems" | "people" | "together";

/** Un título recomendado, con su explicación. */
export interface RecoItem extends Title {
  score: number;
  /** Explicación corta para la tarjeta: «Porque os gustó Interstellar», «Tendencia en España»… */
  reason: string;
}

export interface Shelf {
  id: ShelfId;
  title: string;
  items: RecoItem[];
}

// ---------- API ----------
//
// GET  /api/reco?profile=<id>&type=movie|tv|all
//      → { shelves: Shelf[] }   (estanterías para «Para ti»; ya filtradas por plataformas si el perfil las tiene)
//
// GET  /api/reco/seeds?profile=<id>&type=movie|tv|all
//      → { items: Title[] }     (~24 títulos conocidos y variados para puntuar en el onboarding)
//
// POST /api/feedback  body: { profile, key, signal?: Signal | null, event?: ImplicitEvent, item?: SavedTitle }
//      → { ok: true, feedback: Record<string, FeedbackEntry> }
//      signal null = quitar la valoración. Reentrena el vector del perfil en el momento.
//
// GET  /api/surprise?<filtros>&profile=<id>&skip=...   (igual que antes, pero ahora elige entre los mejores
//      candidatos del ranking personalizado con muestreo ponderado, no al azar)
//
// GET  /api/cron/refresh   (Vercel Cron, diario): recalcula vectores y refresca tendencias.
