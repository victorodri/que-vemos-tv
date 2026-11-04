"use client";
import { useEffect, useRef, useState } from "react";
import { getJSON, hashOf } from "@/lib/client";
import * as engage from "@/lib/engage";
import type { RecoItem, Shelf } from "@/lib/reco/types";
import { titleKey, type Title } from "@/lib/types";
import { NewReleasesSpotlight } from "./NewReleasesSpotlight";
import { useProfile } from "./profileContext";
import { SocialCountsContext, SocialPulse, socialLabel, useActivity, useSocialCount } from "./SocialPulse";
import { focusEl, lastInputPointer } from "./spatialNav";
import { SurveyCard } from "./SurveyCard";
import { Rating, SIGNAL_BADGE } from "./TitleCard";

type Kind = "movie" | "tv" | "all";

/** Tarjeta compacta de póster para las estanterías horizontales. */
export function PosterCard({ item, onOpen, autofocus }: { item: RecoItem; onOpen: () => void; autofocus?: boolean }) {
  const profile = useProfile();
  const rated = profile.feedbackOf(item);
  const social = useSocialCount(item);
  const socialText = social ? socialLabel(social) : null;
  return (
    <button
      className="poster-card"
      data-key={titleKey(item)}
      onClick={onOpen}
      aria-label={[item.title, item.reason, socialText].filter(Boolean).join(". ")}
      data-autofocus={autofocus || undefined}
    >
      <div className="poster-card-img">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span className="poster-fallback">{item.title}</span>}
        <span className="poster-card-badges">
          {profile.inList(item) && <span className="badge">En mi lista</span>}
          {rated && <span className="badge badge--rated">{SIGNAL_BADGE[rated]}</span>}
          {social && (
            <span className="badge badge--social" title={socialText ?? undefined}>
              👥 {social.n}
            </span>
          )}
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
  // Cada apertura de la app (sesión) trae tiras y portada nuevas; al volver tras un rato, se renuevan solas.
  const [session, setSession] = useState(() => engage.sessionId());
  useEffect(() => {
    const off = engage.onNewSession(() => setSession(engage.sessionId()));
    return () => {
      off();
    };
  }, []);
  const pareja = profile.plural;
  // Actividad de otros perfiles: franja «En QuéVer» y contadores «👥» de las tarjetas.
  const { data: activity } = useActivity(profile.id, 24, String(reload));

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
    getJSON<{ shelves: Shelf[] }>(`/api/reco?profile=${profile.id}&type=${kind}&session=${session}${reload ? `.${reload}` : ""}&v=${stableSig}`, ctrl.signal)
      .then((r) => setShelves(r.shelves ?? []))
      .catch((e) => !ctrl.signal.aborted && setError((e as Error).message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [profile.id, kind, stableSig, reload, session]);

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

  // Al abrir la app el foco empieza en la primera recomendación (como Netflix o YouTube), no en el menú: una
  // pulsación de OK y ya estás en la ficha. Solo la primera vez y si no te has movido mientras cargaba.
  const rootRef = useRef<HTMLDivElement>(null);
  const autoFocused = useRef(false);
  const hasShelves = visible.length > 0;
  useEffect(() => {
    if (!hasShelves || autoFocused.current) return;
    autoFocused.current = true;
    const a = document.activeElement;
    const idle = !a || a === document.body || (a as HTMLElement).matches('.tab[aria-current="page"]');
    if (!idle || lastInputPointer || window.scrollY > 10 || rootRef.current?.closest("[hidden]")) return;
    requestAnimationFrame(() => focusEl(rootRef.current?.querySelector<HTMLElement>(".poster-card[data-autofocus]")));
  }, [hasShelves]);

  const kinds: { id: Kind; label: string }[] = both
    ? [
        { id: "all", label: "Todo" },
        { id: "movie", label: "Películas" },
        { id: "tv", label: "Series" },
      ]
    : [];

  return (
    <SocialCountsContext.Provider value={activity?.counts ?? {}}>
      <div className="view" ref={rootRef}>
        <div className="foryou-header">
          <div>
            <h2>{pareja ? "Para vosotros" : "Para ti"}</h2>
            <p className="hint">Cada ❤️, 👍, 👎 o 🚫 que {pareja ? "pongáis" : "pongas"} afina estas recomendaciones.</p>
          </div>
          <div className="chips">
            {kinds.map((k) => (
              <button key={k.id} className="chip" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} data-autofocus={(kind === k.id && !visible.length) || undefined}>
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

        {shelves !== null && <SurveyCard session={session} onChanged={() => setReload((n) => n + 1)} />}

        {error && <p className="error">No se han podido cargar las recomendaciones: {error}</p>}
        {shelves === null && loading && <p className="loading">Preparando recomendaciones…</p>}
        {shelves !== null && !loading && !error && visible.length === 0 && (
          <p className="empty">Todavía no hay nada que encaje. Prueba a valorar algunos títulos o a cambiar tus gustos.</p>
        )}

        {/* «Lo mejor para ti» va justo debajo de la cabecera: es a lo que se llega con una sola pulsación (y donde
            empieza el foco). La franja social y los estrenos, después. */}
        {visible.slice(0, 1).map((shelf) => (
          <ShelfSection key={shelf.id + shelf.title} shelf={shelf} onOpen={onOpen} main />
        ))}
        <SocialPulse data={activity} onOpen={onOpen} plural={pareja} />
        <NewReleasesSpotlight onOpen={onOpen} />
        {visible.slice(1).map((shelf) => (
          <ShelfSection key={shelf.id + shelf.title} shelf={shelf} onOpen={onOpen} />
        ))}
        {shelves !== null && loading && <p className="hint shelf-updating">Actualizando…</p>}
      </div>
    </SocialCountsContext.Provider>
  );
}

/**
 * Una tira de «Para ti». Cuenta como vista cuando entra en pantalla (y los títulos que se ven en ella, también al
 * desplazarla): así se sabe qué tiras se ignoran y qué títulos han pasado ya demasiadas veces sin abrirse.
 */
function ShelfSection({ shelf, onOpen, main }: { shelf: Shelf; onOpen: (t: Title) => void; main?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const fam = shelf.key ?? shelf.id;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      const keys = [...el.querySelectorAll<HTMLElement>("[data-key]")]
        .filter((c) => {
          const b = c.getBoundingClientRect();
          return b.right > 0 && b.left < innerWidth;
        })
        .map((c) => c.dataset.key!);
      engage.viewShelf(fam, shelf.title, keys);
    };
    let t: ReturnType<typeof setTimeout> | undefined;
    // Solo cuenta si se queda en pantalla un momento (no al pasar de largo con el scroll).
    const io = new IntersectionObserver(
      ([e]) => {
        clearTimeout(t);
        if (e.isIntersecting) t = setTimeout(report, 700);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    const row = el.querySelector(".shelf-row");
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(report, 700);
    };
    row?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      io.disconnect();
      row?.removeEventListener("scroll", onScroll);
    };
  }, [fam, shelf.title, shelf.items]);

  return (
    <section ref={ref} className="shelf" aria-label={shelf.title}>
      <h3 className="shelf-title">{shelf.title}</h3>
      <div className="shelf-row">
        {shelf.items.map((item, i) => (
          <PosterCard
            key={titleKey(item)}
            item={item}
            autofocus={main && i === 0}
            onOpen={() => {
              engage.setOrigin(fam);
              onOpen(item);
            }}
          />
        ))}
      </div>
    </section>
  );
}
