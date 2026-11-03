"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/client";
import { TAG_LABEL, type TitleReviews } from "@/lib/reviews/types";
import type { MediaType } from "@/lib/types";

const SOURCE_NAME: Record<string, string> = { tmdb: "TMDB", wikipedia: "Wikipedia", rss: "blogs y medios", reddit: "Reddit" };

/**
 * «Qué dice la crítica»: notas de agregadores, aspectos que repiten las críticas y opiniones destacadas
 * (fragmentos con su fuente). Cada opinión es un botón para que el mando pueda recorrerlas y la ficha se desplace.
 */
export function ReviewsPanel({ type, id }: { type: MediaType; id: number }) {
  const [data, setData] = useState<TitleReviews | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    getJSON<TitleReviews>(`/api/reviews/${type}/${id}`, ctrl.signal).then(setData, () => !ctrl.signal.aborted && setFailed(true));
    return () => ctrl.abort();
  }, [type, id]);

  if (failed) return null;
  if (!data) return <p className="hint reviews-loading">Buscando críticas en blogs, Wikipedia, Reddit y TMDB…</p>;
  if (!data.n && !data.scores.rt && !data.scores.metacritic) return <p className="hint reviews-loading">Aún no hemos encontrado críticas de este título.</p>;

  const tags = Object.entries(data.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <section className="reviews" aria-label="Qué dice la crítica">
      <div className="reviews-head">
        <h3>Qué dice la crítica</h3>
        <div className="reviews-scores">
          {data.scores.rt != null && <span className="score-pill">🍅 {data.scores.rt} %</span>}
          {data.scores.metacritic != null && <span className="score-pill">Metacritic {data.scores.metacritic}</span>}
          {data.scores.imdb != null && <span className="score-pill">IMDb {data.scores.imdb.toFixed(1)}</span>}
          {data.critic != null && <span className="score-pill score-pill--main">Consenso {Math.round(data.critic * 100)}/100</span>}
        </div>
      </div>
      {tags.length > 0 && (
        <p className="reviews-tags">
          {tags.map(([t]) => (
            <span key={t} className={`tag${t === "aburrida" || t === "sobrevalorada" ? " tag--neg" : ""}`}>
              {TAG_LABEL[t] ?? t}
            </span>
          ))}
        </p>
      )}
      <div className="reviews-list">
        {data.highlights.map((r, i) => (
          <button key={i} className={`review${r.sentiment < -0.15 ? " review--neg" : ""}`} onClick={() => {}} aria-label={`${r.outlet}: ${r.excerpt}`}>
            <span className="review-text">«{r.excerpt}»</span>
            <span className="review-src">
              {r.outlet}
              {r.author ? ` · ${r.author}` : ""}
              {r.score != null ? ` · ${Math.round(r.score * 10)}/10` : ""}
              {r.votes && r.source === "reddit" ? ` · ▲ ${r.votes}` : ""}
              {r.lang === "en" ? " · en inglés" : ""}
            </span>
          </button>
        ))}
      </div>
      <p className="hint reviews-foot">
        Fragmentos de {data.sources.map((s) => SOURCE_NAME[s] ?? s).join(", ")} ({data.n} opiniones). El consenso también afina tus recomendaciones.
      </p>
    </section>
  );
}
