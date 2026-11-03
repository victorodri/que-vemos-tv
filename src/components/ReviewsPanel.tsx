"use client";
import { TAG_LABEL } from "@/lib/reviews/types";
import type { MediaType } from "@/lib/types";
import { useReviews } from "./Scores";

const SOURCE_NAME: Record<string, string> = { tmdb: "TMDB", wikipedia: "Wikipedia", rss: "blogs y medios", reddit: "Reddit" };

/**
 * «Qué dice la crítica»: aspectos que repiten las críticas y opiniones destacadas
 * (fragmentos con su fuente). Cada opinión es un botón para que el mando pueda recorrerlas y la ficha se desplace.
 */
export function ReviewsPanel({ type, id }: { type: MediaType; id: number }) {
  // Las notas (TMDB, IMDb, Rotten Tomatoes, Metacritic) van en pequeño en la línea de datos de la ficha (Scores.tsx).
  const data = useReviews(type, id);
  if (data === null) return null;
  if (!data) return <p className="hint reviews-loading">Buscando críticas en blogs, Wikipedia, Reddit y TMDB…</p>;
  if (!data.highlights.length && !Object.keys(data.tags).length) return <p className="hint reviews-loading">Aún no hay críticas en castellano de este título.</p>;

  const tags = Object.entries(data.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <section className="reviews" aria-label="Qué dice la crítica">
      <div className="reviews-head">
        <h3>Qué dice la crítica</h3>
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
            </span>
          </button>
        ))}
      </div>
      <p className="hint reviews-foot">
        Opiniones en castellano de {[...new Set(data.highlights.map((h) => SOURCE_NAME[h.source] ?? h.source))].join(", ")}. La nota global tiene en cuenta {data.n} opiniones y también afina tus recomendaciones.
      </p>
    </section>
  );
}
