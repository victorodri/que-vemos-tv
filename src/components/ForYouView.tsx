"use client";
import { useEffect, useRef, useState } from "react";
import { getJSON, hashOf } from "@/lib/client";
import type { RecoItem, Shelf } from "@/lib/reco/types";
import { titleKey, type Title } from "@/lib/types";
import { useProfile } from "./profileContext";
import { Rating, SIGNAL_BADGE } from "./TitleCard";

type Kind = "movie" | "tv" | "all";

/** Tarjeta compacta de póster para las estanterías horizontales. */
function PosterCard({ item, onOpen }: { item: RecoItem; onOpen: () => void }) {
  const profile = useProfile();
  const rated = profile.feedbackOf(item);
  return (
    <button className="poster-card" onClick={onOpen} aria-label={`${item.title}. ${item.reason}`}>
      <div className="poster-card-img">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span className="poster-fallback">{item.title}</span>}
        <span className="poster-card-badges">
          {profile.inList(item) && <span className="badge">En mi lista</span>}
          {rated && <span className="badge badge--rated">{SIGNAL_BADGE[rated]}</span>}
        </span>
      </div>
      <span className="poster-card-title">{item.title}</span>
      <span className="poster-card-meta">
        {item.year ?? "—"} <Rating value={item.rating} />
      </span>
      {item.reason && <span className="poster-card-reason">{item.reason}</span>}
    </button>
  );
}

/** Recomendaciones personalizadas en estanterías («Top para ti», «Porque te gustó…», «Descubrimientos»…). */
export function ForYouView({ onOpen, onRedo }: { onOpen: (t: Title) => void; onRedo: () => void }) {
  const profile = useProfile();
  const prefs = profile.data.prefs!;
  const both = prefs.types.length > 1;
  const [kind, setKind] = useState<Kind>(both ? "all" : prefs.types[0]);
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const pareja = profile.id === "pareja";

  // Lo que el servidor usa para recomendar. Al cambiar (valorar, añadir a la lista…) se recalcula con retardo,
  // para no pedir estanterías nuevas a cada pulsación.
  const signature = hashOf([profile.data.feedback, profile.data.watchlist.map(titleKey), profile.data.seen, prefs, profile.data.platforms]);
  const [stableSig, setStableSig] = useState(signature);
  useEffect(() => {
    const t = setTimeout(() => setStableSig(signature), 1500);
    return () => clearTimeout(t);
  }, [signature]);

  const ctrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    getJSON<{ shelves: Shelf[] }>(`/api/reco?profile=${profile.id}&type=${kind}&v=${stableSig}.${reload}`, ctrl.signal)
      .then((r) => setShelves(r.shelves ?? []))
      .catch((e) => !ctrl.signal.aborted && setError((e as Error).message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [profile.id, kind, stableSig, reload]);

  // Respuesta inmediata: lo que se acaba de descartar o marcar como visto desaparece sin esperar al servidor.
  const visible = (shelves ?? [])
    .map((s) => ({
      ...s,
      items: s.items.filter((t) => {
        const f = profile.feedbackOf(t);
        return f !== "dislike" && f !== "not_interested" && !profile.isSeen(t);
      }),
    }))
    .filter((s) => s.items.length > 0);

  const kinds: { id: Kind; label: string }[] = both
    ? [
        { id: "all", label: "Todo" },
        { id: "movie", label: "Películas" },
        { id: "tv", label: "Series" },
      ]
    : [];

  return (
    <div className="view">
      <div className="foryou-header">
        <div>
          <h2>{pareja ? "Para vosotros" : "Para ti"}</h2>
          <p className="hint">
            Cada ❤️, 👍, 👎 o 🚫 que {pareja ? "pongáis" : "pongas"} afina estas recomendaciones.
          </p>
        </div>
        <div className="chips">
          {kinds.map((k) => (
            <button key={k.id} className="chip" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} data-autofocus={kind === k.id || undefined}>
              {k.label}
            </button>
          ))}
          <button className="chip" onClick={() => setReload((n) => n + 1)}>
            ↻ Actualizar
          </button>
          <button className="chip" onClick={onRedo}>
            ✎ Cambiar gustos
          </button>
        </div>
      </div>

      {error && (
        <p className="error">
          No se han podido cargar las recomendaciones: {error}
        </p>
      )}
      {shelves === null && loading && <p className="loading">Preparando recomendaciones…</p>}
      {shelves !== null && !loading && !error && visible.length === 0 && (
        <p className="empty">
          Todavía no hay nada que encaje. Prueba a valorar algunos títulos o a cambiar tus gustos.
        </p>
      )}

      {visible.map((shelf) => (
        <section key={shelf.id + shelf.title} className="shelf" aria-label={shelf.title}>
          <h3 className="shelf-title">{shelf.title}</h3>
          <div className="shelf-row">
            {shelf.items.map((item) => (
              <PosterCard key={titleKey(item)} item={item} onOpen={() => onOpen(item)} />
            ))}
          </div>
        </section>
      ))}
      {shelves !== null && loading && <p className="hint shelf-updating">Actualizando…</p>}
    </div>
  );
}
