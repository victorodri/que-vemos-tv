import "server-only";
import { kvMGet, kvSet } from "../store";
import { getSummaries } from "../reviews";
import { TAG_LABEL } from "../reviews/types";
import { IMG, tmdb } from "../tmdb";
import type { MediaType } from "../types";
import type { ItemFeatures } from "./types";

// «ADN» de cada título: vector disperso de rasgos, títulos relacionados y etiquetas legibles.
// Se guarda en la base de datos 30 días, así el modelo se nutre de una caché que crece con el uso
// y casi nunca tiene que volver a preguntar a TMDB.

const TTL = 30 * 24 * 3600;
const VERSION = 2; // súbelo si cambia cómo se construyen los rasgos: invalida la caché
const cacheKey = (key: string) => `item:v${VERSION}:${key}`;

/** Peso de cada familia de rasgos dentro del vector de un título. */
export const FAMILY_WEIGHT = {
  g: 1.0, // género
  k: 0.55, // palabra clave (temas: «espacio», «viajes en el tiempo», «basado en hechos reales»…)
  c: 0.9, // dirección / creación
  p: 0.45, // reparto principal
  d: 0.35, // década
  l: 0.45, // idioma original
  t: 0.3, // película o serie
  r: 0.3, // duración
  a: 0.5, // aspecto que destacan las críticas («tensa», «giros», «lenta»…), ver src/lib/reviews
} as const;

export const parseKey = (key: string): { type: MediaType; id: number } => {
  const [type, id] = key.split(":");
  return { type: type as MediaType, id: Number(id) };
};

export function runtimeBucket(type: MediaType, minutes: number | null | undefined): "short" | "medium" | "long" | null {
  if (!minutes) return null;
  if (type === "movie") return minutes < 100 ? "short" : minutes <= 130 ? "medium" : "long";
  return minutes < 35 ? "short" : minutes <= 55 ? "medium" : "long";
}

export const decadeOf = (year: number | null | undefined) => (year ? Math.floor(year / 10) * 10 : null);

/** Normaliza un vector a norma 1 (para que títulos con muchos rasgos no pesen más). */
export function normalize(f: Record<string, number>): Record<string, number> {
  let n = 0;
  for (const v of Object.values(f)) n += v * v;
  n = Math.sqrt(n);
  if (!n) return f;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) out[k] = v / n;
  return out;
}

/**
 * Rasgos «ligeros» que se pueden sacar de un resultado de listado (discover, trending…) sin pedir
 * el detalle: sirven para la primera criba de cientos de candidatos.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function shallowFeatures(raw: any, type: MediaType): Record<string, number> {
  const f: Record<string, number> = {};
  for (const g of raw.genre_ids ?? raw.genres?.map((x: { id: number }) => x.id) ?? []) f[`g:${g}`] = FAMILY_WEIGHT.g;
  const date: string | undefined = type === "movie" ? raw.release_date : raw.first_air_date;
  const dec = decadeOf(date ? Number(date.slice(0, 4)) : null);
  if (dec) f[`d:${dec}`] = FAMILY_WEIGHT.d;
  if (raw.original_language) f[`l:${raw.original_language}`] = FAMILY_WEIGHT.l;
  f[`t:${type}`] = FAMILY_WEIGHT.t;
  return f;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchFeatures(key: string): Promise<ItemFeatures | null> {
  const { type, id } = parseKey(key);
  const raw = await tmdb<any>(
    `/${type}/${id}`,
    { language: "es-ES", append_to_response: "keywords,credits,recommendations,similar" },
    7 * 24 * 3600,
  ).catch(() => null);
  if (!raw || !raw.id) return null;

  const f = shallowFeatures(raw, type);
  const labels: Record<string, string> = {};
  for (const g of raw.genres ?? []) labels[`g:${g.id}`] = g.name;

  const keywords: { id: number; name: string }[] = (type === "movie" ? raw.keywords?.keywords : raw.keywords?.results) ?? [];
  for (const k of keywords.slice(0, 12)) {
    f[`k:${k.id}`] = FAMILY_WEIGHT.k;
    labels[`k:${k.id}`] = k.name;
  }

  const creators: { id: number; name: string }[] =
    type === "movie" ? (raw.credits?.crew ?? []).filter((c: any) => c.job === "Director") : (raw.created_by ?? []);
  for (const c of creators.slice(0, 3)) {
    f[`c:${c.id}`] = FAMILY_WEIGHT.c;
    labels[`c:${c.id}`] = c.name;
  }
  for (const p of (raw.credits?.cast ?? []).slice(0, 4)) {
    f[`p:${p.id}`] = FAMILY_WEIGHT.p;
    labels[`p:${p.id}`] = p.name;
  }

  const runtime = type === "movie" ? raw.runtime : (raw.episode_run_time?.[0] ?? raw.last_episode_to_air?.runtime);
  const rb = runtimeBucket(type, runtime);
  if (rb) f[`r:${rb}`] = FAMILY_WEIGHT.r;

  const related = [
    ...(raw.recommendations?.results ?? []).slice(0, 12),
    ...(raw.similar?.results ?? []).slice(0, 6),
  ]
    .filter((r: any) => !r.adult)
    .map((r: any) => `${r.media_type === "movie" || r.media_type === "tv" ? r.media_type : type}:${r.id}`);

  const date: string | undefined = type === "movie" ? raw.release_date : raw.first_air_date;
  return {
    key,
    type,
    id,
    title: (type === "movie" ? raw.title : raw.name) ?? "Sin título",
    year: date ? Number(date.slice(0, 4)) || null : null,
    poster: raw.poster_path ? `${IMG}w342${raw.poster_path}` : null,
    backdrop: raw.backdrop_path ? `${IMG}w1280${raw.backdrop_path}` : null,
    overview: raw.overview ?? "",
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    voteCount: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
    genreIds: (raw.genres ?? []).map((g: any) => g.id),
    f: normalize(f),
    related: [...new Set(related)],
    labels,
    fetchedAt: Date.now(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Rasgos de varios títulos: primero la base de datos, luego TMDB (con concurrencia limitada) para lo que falte. */
export async function getManyFeatures(keys: string[], concurrency = 8): Promise<Map<string, ItemFeatures>> {
  const unique = [...new Set(keys)];
  const out = new Map<string, ItemFeatures>();
  const cached = await kvMGet<ItemFeatures>(unique.map(cacheKey)).catch(() => unique.map(() => null));
  const missing: string[] = [];
  unique.forEach((k, i) => (cached[i] ? out.set(k, cached[i]!) : missing.push(k)));

  let next = 0;
  async function worker() {
    while (next < missing.length) {
      const key = missing[next++];
      const feat = await fetchFeatures(key);
      if (feat) {
        out.set(key, feat);
        await kvSet(cacheKey(key), feat, TTL).catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  return withReviewAspects(out);
}

/**
 * Añade a cada título los aspectos que destacan sus críticas (`a:tensa`…), si ya se han calculado. No se guardan en
 * la caché del título: las críticas se actualizan aparte y así el vector siempre lleva las últimas.
 */
async function withReviewAspects(items: Map<string, ItemFeatures>): Promise<Map<string, ItemFeatures>> {
  const sums = await getSummaries([...items.keys()]).catch(() => new Map());
  for (const [k, sum] of sums) {
    const it = items.get(k);
    if (!it || !Object.keys(sum.tags).length) continue;
    const f = { ...it.f };
    const labels = { ...it.labels };
    for (const [tag, w] of Object.entries(sum.tags as Record<string, number>)) {
      f[`a:${tag}`] = FAMILY_WEIGHT.a * Math.min(1, w * 2);
      labels[`a:${tag}`] = TAG_LABEL[tag] ?? tag;
    }
    items.set(k, { ...it, f: normalize(f), labels, critic: sum.critic });
  }
  return items;
}

export async function getFeatures(key: string): Promise<ItemFeatures | null> {
  return (await getManyFeatures([key])).get(key) ?? null;
}
