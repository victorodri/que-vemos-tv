"use client";
import { useEffect, useState } from "react";
import { formatRuntime, getJSON } from "@/lib/client";
import type { Signal } from "@/lib/reco/types";
import type { MediaType, SavedTitle, Title, TitleDetail } from "@/lib/types";
import { focusFirst } from "./spatialNav";
import { useProfile } from "./profileContext";
import { ProviderList } from "./Providers";
import { ReviewsPanel } from "./ReviewsPanel";
import { Rating } from "./TitleCard";

/** Ficha grande de un título: fondo, póster, datos, plataformas y botones. */
export function TitleFeature({ title, children }: { title: TitleDetail | Title | SavedTitle; children?: React.ReactNode }) {
  const t = title as Partial<TitleDetail> & SavedTitle;
  const runtime = formatRuntime(t.runtime ?? null);
  return (
    <article className="feature" style={t.backdrop ? { backgroundImage: `url(${t.backdrop})` } : undefined}>
      <div className="feature-shade">
        <div className="feature-poster">{t.poster ? <img src={t.poster} alt="" /> : <span className="poster-fallback">{t.title}</span>}</div>
        <div className="feature-info">
          <p className="feature-kind">
            {t.type === "movie" ? "Película" : "Serie"}
            {(title as { reason?: string }).reason && <span className="feature-reason"> · {(title as { reason?: string }).reason}</span>}
          </p>
          <h2 className="feature-title">{t.title}</h2>
          <p className="feature-meta">
            <span>{t.year ?? "—"}</span>
            <Rating value={t.rating} />
            {runtime && <span>{t.type === "tv" ? `${runtime}/cap.` : runtime}</span>}
            {t.seasons ? <span>{t.seasons} temporada{t.seasons > 1 ? "s" : ""}</span> : null}
            {t.genres?.length ? <span>{t.genres.slice(0, 3).join(" · ")}</span> : null}
          </p>
          {t.tagline && <p className="feature-tagline">{t.tagline}</p>}
          <p className="feature-overview">{t.overview || "Sin sinopsis."}</p>
          <div className="feature-providers">
            <ProviderList providers={t.providers} rentOrBuy={t.rentOrBuy} withNames max={8} />
          </div>
          <div className="actions feature-actions">{children}</div>
        </div>
      </div>
    </article>
  );
}

export const SIGNALS: { s: Signal; icon: string; label: string }[] = [
  { s: "love", icon: "❤️", label: "Me encanta" },
  { s: "like", icon: "👍", label: "Me gusta" },
  { s: "dislike", icon: "👎", label: "No me gusta" },
  { s: "not_interested", icon: "🚫", label: "No me interesa" },
];

/** Fila «Me encanta / Me gusta / No me gusta / No me interesa». Entrena el modelo de gustos del perfil. */
export function FeedbackButtons({ title, onRated }: { title: Title | SavedTitle; onRated?: (signal: Signal | null) => void }) {
  const profile = useProfile();
  const current = profile.feedbackOf(title);
  return (
    <div className="feedback" role="group" aria-label="Tu valoración">
      {SIGNALS.map((o) => (
        <button
          key={o.s}
          className="btn btn--feedback"
          aria-pressed={current === o.s}
          onClick={() => {
            const next = current === o.s ? null : o.s;
            profile.rate(title, o.s);
            onRated?.(next);
          }}
        >
          <span aria-hidden="true">{o.icon}</span> {o.label}
        </button>
      ))}
    </div>
  );
}

/** Botones "Quiero verla" y "Ya vista" del perfil activo. */
export function ProfileActions({ title, onSeen }: { title: Title | SavedTitle; onSeen?: (nowSeen: boolean) => void }) {
  const profile = useProfile();
  const inList = profile.inList(title);
  const seen = profile.isSeen(title);
  const pareja = profile.plural;
  return (
    <>
      <button className="btn" onClick={() => profile.toggleList(title)}>
        {inList ? "✓ En mi lista (quitar)" : "＋ Quiero verla"}
      </button>
      <button
        className="btn"
        onClick={() => {
          profile.toggleSeen(title);
          onSeen?.(!seen);
        }}
      >
        {seen ? "↺ Desmarcar vista" : pareja ? "👁 Ya la hemos visto" : "👁 Ya la he visto"}
      </button>
    </>
  );
}

export function DetailModal({ target, onClose }: { target: { type: MediaType; id: number; preview?: Title | SavedTitle }; onClose: () => void }) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getJSON<TitleDetail>(`/api/title/${target.type}/${target.id}`, ctrl.signal)
      .then(setDetail)
      .catch((e) => !ctrl.signal.aborted && setError(e.message));
    return () => ctrl.abort();
  }, [target.type, target.id]);

  useEffect(() => {
    requestAnimationFrame(focusFirst);
  }, []);

  const shown = detail ?? target.preview;
  return (
    <div className="modal" data-nav-modal role="dialog" aria-modal="true">
      {shown ? (
        <div className="modal-body">
          <TitleFeature title={shown}>
            <button className="btn btn--primary" data-autofocus onClick={onClose}>
              ← Volver
            </button>
            <ProfileActions title={shown} />
            <FeedbackButtons title={shown} />
            {error && <p className="error">{error}</p>}
          </TitleFeature>
          <ReviewsPanel type={target.type} id={target.id} />
        </div>
      ) : (
        <div className="modal-loading">
          {error ? <p className="error">{error}</p> : <p className="loading">Cargando…</p>}
          <button className="btn" data-autofocus onClick={onClose}>
            ← Volver
          </button>
        </div>
      )}
    </div>
  );
}
