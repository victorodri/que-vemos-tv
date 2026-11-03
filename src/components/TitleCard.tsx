"use client";
import type { RecoItem, Signal } from "@/lib/reco/types";
import type { SavedTitle, Title } from "@/lib/types";
import { useProfile } from "./profileContext";
import { ProviderList } from "./Providers";

export function Rating({ value }: { value: number | null }) {
  if (!value) return null;
  return <span className="rating">★ {value.toFixed(1)}</span>;
}

export const SIGNAL_BADGE: Record<Signal, string> = { love: "❤️", like: "👍", dislike: "👎", not_interested: "🚫" };

export function TitleCard({
  title,
  onOpen,
  note,
  hideSeen,
}: {
  title: Title | SavedTitle;
  onOpen: () => void;
  /** Línea destacada bajo los datos (p. ej. «Vista el 3 nov.»). */
  note?: string | null;
  /** No pintar la etiqueta «Vista» (en el listado de vistos sobra). */
  hideSeen?: boolean;
}) {
  const profile = useProfile();
  const t = title as Title & Partial<RecoItem>;
  const rated = profile.feedbackOf(t);
  return (
    <button className="card" onClick={onOpen}>
      <div className="card-poster">
        {t.poster ? <img src={t.poster} alt="" loading="lazy" /> : <span className="poster-fallback">{t.title}</span>}
      </div>
      <div className="card-body">
        <h3 className="card-title">{t.title}</h3>
        <p className="card-meta">
          {t.year ?? "—"} <Rating value={t.rating} />
          {profile.inList(t) && <span className="badge">En mi lista</span>}
          {!hideSeen && profile.isSeen(t) && <span className="badge badge--seen">Vista</span>}
          {rated && <span className="badge badge--rated">{SIGNAL_BADGE[rated]}</span>}
        </p>
        {note && <p className="card-note">{note}</p>}
        {t.reason && <p className="card-reason">{t.reason}</p>}
        <p className="card-overview">{t.overview || "Sin sinopsis."}</p>
        <ProviderList providers={t.providers} rentOrBuy={t.rentOrBuy} max={5} />
      </div>
    </button>
  );
}
