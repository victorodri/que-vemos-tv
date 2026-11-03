"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/client";
import type { TitleReviews } from "@/lib/reviews/types";
import type { MediaType } from "@/lib/types";

// Críticas de un título compartidas entre la línea de notas y «Qué dice la crítica»: una sola petición por título.
const cache = new Map<string, Promise<TitleReviews | null>>();

export function useReviews(type: MediaType, id: number): TitleReviews | null | undefined {
  const key = `${type}:${id}`;
  const [data, setData] = useState<{ key: string; value: TitleReviews | null } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!cache.has(key)) cache.set(key, getJSON<TitleReviews>(`/api/reviews/${type}/${id}`).catch(() => (cache.delete(key), null)));
    cache.get(key)!.then((value) => alive && setData({ key, value }));
    return () => {
      alive = false;
    };
  }, [key, type, id]);
  return data?.key === key ? data.value : undefined; // undefined = cargando
}

/**
 * Nota híbrida sobre 10: media ponderada de TMDB, IMDb, Rotten Tomatoes y Metacritic (las que haya) y del
 * consenso de las críticas. Con solo TMDB, es la de TMDB.
 */
export function hybridScore(tmdb: number | null | undefined, r: TitleReviews | null | undefined): number | null {
  const parts: [number, number][] = [];
  if (tmdb) parts.push([tmdb / 10, 1]);
  if (r?.scores.imdb != null) parts.push([r.scores.imdb / 10, 1]);
  if (r?.scores.rt != null) parts.push([r.scores.rt / 100, 0.8]);
  if (r?.scores.metacritic != null) parts.push([r.scores.metacritic / 100, 0.8]);
  if (r?.critic != null && r.n >= 3) parts.push([r.critic, 0.6]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return w ? Math.round((parts.reduce((s, [v, x]) => s + v * x, 0) / w) * 100) / 10 : null;
}

/** Línea compacta de notas: híbrida destacada y, en pequeño, TMDB · 🍅 RT · IMDb · Metacritic. */
export function ScoreLine({ type, id, tmdb }: { type: MediaType; id: number; tmdb: number | null | undefined }) {
  const r = useReviews(type, id);
  const hybrid = hybridScore(tmdb, r);
  if (!hybrid && !tmdb) return null;
  const s = r?.scores;
  return (
    <span className="scores" aria-label="Notas">
      {hybrid != null && (
        <span className="score-main" title="Nota global: TMDB, IMDb, Rotten Tomatoes, Metacritic y crítica">
          ★ {hybrid.toFixed(1)}
        </span>
      )}
      {tmdb ? <span className="score-mini">TMDB {tmdb.toFixed(1)}</span> : null}
      {s?.imdb != null && <span className="score-mini">IMDb {s.imdb.toFixed(1)}</span>}
      {s?.rt != null && <span className="score-mini">🍅 {s.rt}%</span>}
      {s?.metacritic != null && <span className="score-mini">MC {s.metacritic}</span>}
    </span>
  );
}
