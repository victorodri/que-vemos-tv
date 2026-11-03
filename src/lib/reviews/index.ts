import "server-only";
import { kvMGet, kvSet } from "../store";
import type { MediaType } from "../types";
import { rssReviews } from "./rss";
import { omdbScores, redditReviews, titleRef, tmdbReviews, wikipediaReviews } from "./sources";
import type { CriticScores, Review, ReviewSource, ReviewSummary, TitleReviews } from "./types";

// Críticas de un título: se reúnen de todas las fuentes, se resumen (nota de la crítica + aspectos) y se guardan
// 14 días (las de blogs crecen con el cron). El resumen va aparte, más pequeño, para leerlo en lote al recomendar.

const VERSION = 1;
const TTL = 14 * 86400;
const fullKey = (k: string) => `reviews:v${VERSION}:${k}`;
const sumKey = (k: string) => `rsum:v${VERSION}:${k}`;
const MAX_HIGHLIGHTS = 8;

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Nota de la crítica 0..1: media ponderada de los agregadores (Rotten Tomatoes y Metacritic pesan más), las notas
 * de cada reseña y el tono de los textos. Con poca información devuelve null para no inventar.
 */
export function criticScore(scores: CriticScores, reviews: Review[]): number | null {
  const parts: [number, number][] = [];
  if (scores.rt != null) parts.push([scores.rt / 100, 1.5]);
  if (scores.metacritic != null) parts.push([clamp((scores.metacritic - 20) / 70), 1.5]);
  if (scores.imdb != null) parts.push([clamp((scores.imdb - 4) / 5), 1]);
  const rated = reviews.filter((r) => r.score != null);
  if (rated.length) parts.push([rated.reduce((s, r) => s + r.score!, 0) / rated.length, Math.min(rated.length, 5) * 0.3]);
  const toned = reviews.filter((r) => r.sentiment !== 0);
  if (toned.length) parts.push([toned.reduce((s, r) => s + (r.sentiment + 1) / 2, 0) / toned.length, Math.min(toned.length, 8) * 0.12]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return w >= 0.5 ? parts.reduce((s, [v, x]) => s + v * x, 0) / w : null;
}

/** Aspectos que repiten las críticas: peso = menciones / (opiniones + 2), solo los que salen al menos dos veces. */
export function tagWeights(reviews: Review[]): Record<string, number> {
  const count: Record<string, number> = {};
  for (const r of reviews) for (const a of new Set(r.aspects ?? [])) count[a] = (count[a] ?? 0) + 1;
  const n = reviews.length;
  return Object.fromEntries(
    Object.entries(count)
      .filter(([, c]) => c >= 2 || (n <= 3 && c >= 1))
      .map(([a, c]) => [a, Math.round((c / (n + 2)) * 100) / 100]),
  );
}

const SOURCE_ORDER: ReviewSource[] = ["rss", "wikipedia", "reddit", "tmdb"];

/** Lo más destacado: variado por fuente (crítica profesional primero), con al menos una pega si la hay. */
function pickHighlights(reviews: Review[]): Review[] {
  const bySource = SOURCE_ORDER.map((s) =>
    reviews
      .filter((r) => r.source === s && r.excerpt.length >= 40)
      .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0) || Math.abs(b.sentiment) - Math.abs(a.sentiment)),
  );
  const out: Review[] = [];
  for (let round = 0; out.length < MAX_HIGHLIGHTS && bySource.some((l) => l.length > round); round++)
    for (const l of bySource) if (l[round] && out.length < MAX_HIGHLIGHTS) out.push(l[round]);
  const negative = reviews.filter((r) => r.sentiment < -0.15 && r.excerpt.length >= 40).sort((a, b) => a.sentiment - b.sentiment)[0];
  if (negative && !out.includes(negative)) out[Math.min(out.length, MAX_HIGHLIGHTS - 1)] = negative;
  return out;
}

async function collect(type: MediaType, id: number): Promise<TitleReviews> {
  const key = `${type}:${id}`;
  const ref = await titleRef(type, id);
  const settled = await Promise.allSettled([tmdbReviews(ref), wikipediaReviews(ref), rssReviews([ref.title, ref.originalTitle]), redditReviews(ref), omdbScores(ref)]);
  const val = <T,>(i: number, fallback: T): T => (settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<T>).value : fallback);
  const tmdbR = val<Review[]>(0, []);
  const wiki = val<{ reviews: Review[]; scores: CriticScores }>(1, { reviews: [], scores: {} });
  const rss = val<Review[]>(2, []);
  const reddit = val<Review[]>(3, []);
  const omdb = val<CriticScores>(4, {});
  const reviews = [...rss, ...wiki.reviews, ...reddit, ...tmdbR];
  const scores: CriticScores = { ...wiki.scores, ...omdb };
  const sources = ([["tmdb", tmdbR], ["wikipedia", wiki.reviews], ["rss", rss], ["reddit", reddit]] as const).filter(([, l]) => l.length).map(([s]) => s);
  return {
    key,
    scores,
    critic: criticScore(scores, reviews),
    tags: tagWeights(reviews),
    n: reviews.length,
    highlights: pickHighlights(reviews),
    sources,
    fetchedAt: Date.now(),
  };
}

export async function getReviews(type: MediaType, id: number): Promise<TitleReviews> {
  const key = `${type}:${id}`;
  const [cached] = await kvMGet<TitleReviews>([fullKey(key)]);
  if (cached) return cached;
  const r = await collect(type, id);
  const summary: ReviewSummary = { tags: r.tags, critic: r.critic, n: r.n };
  await Promise.all([kvSet(fullKey(key), r, TTL), kvSet(sumKey(key), summary, 30 * 86400)]);
  return r;
}

/** Resúmenes ya calculados (no consulta fuentes): para el recomendador, en lote. */
export async function getSummaries(keys: string[]): Promise<Map<string, ReviewSummary>> {
  const out = new Map<string, ReviewSummary>();
  if (!keys.length) return out;
  const found = await kvMGet<ReviewSummary>(keys.map(sumKey)).catch(() => []);
  keys.forEach((k, i) => found[i] && out.set(k, found[i]!));
  return out;
}

/** Calcula las críticas de los títulos que aún no las tienen (en segundo plano, de pocas en pocas). */
export async function warmReviews(keys: string[], limit = 10): Promise<number> {
  const have = await getSummaries(keys);
  const missing = [...new Set(keys)].filter((k) => !have.has(k)).slice(0, limit);
  let done = 0;
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(
      missing.slice(i, i + 3).map((k) => {
        const [type, id] = k.split(":");
        return getReviews(type as MediaType, Number(id)).then(() => done++, () => undefined);
      }),
    );
  }
  return done;
}
