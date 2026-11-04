"use client";
import { useEffect, useRef, useState } from "react";
import { filtersToParams } from "@/lib/filters";
import { getJSON, hashOf } from "@/lib/client";
import { titleKey, type Filters, type Meta, type TitleDetail } from "@/lib/types";
import { FiltersPanel } from "./FiltersPanel";
import { useProfile } from "./profileContext";
import { focusEl, focusFirst, lastInputPointer, useBackHandler } from "./spatialNav";
import { FeedbackButtons, ProfileActions, TitleFeature } from "./TitleFeature";

type SurpriseItem = TitleDetail & { reason?: string; arm?: string };

/** Propuestas que se tienen precargadas: «Otra» es instantáneo y nunca se acaba. */
const BATCH = 5;
const REFILL_BELOW = 3;

export function SurpriseView({ filters, onFilters, meta }: { filters: Filters; onFilters: (f: Filters) => void; meta: Meta }) {
  const profile = useProfile();
  const [item, setItem] = useState<SurpriseItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const queue = useRef<SurpriseItem[]>([]);
  /** Todo lo propuesto en esta sesión (también lo que está en cola), para no repetir. */
  const seenHere = useRef<string[]>([]);
  const inflight = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const againRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const filterKey = filtersToParams({ ...filters, query: "" }).toString();
  const tasteKey = hashOf([profile.data.platforms, profile.data.prefs]);
  const filtersBtn = useRef<HTMLButtonElement>(null);

  // Los filtros se abren en un panel por encima; Atrás o «Listo» lo cierran y devuelven el foco al botón.
  const closeFilters = () => {
    setShowFilters(false);
    requestAnimationFrame(() => (filtersBtn.current ? focusEl(filtersBtn.current) : focusFirst()));
  };
  useBackHandler(showFilters, closeFilters);
  useEffect(() => {
    if (showFilters) requestAnimationFrame(focusFirst);
  }, [showFilters]);

  // Con filtros o gustos nuevos se vacía la cola: lo precargado ya no vale.
  useEffect(() => {
    generation.current++;
    queue.current = [];
    seenHere.current = [];
    inflight.current = null;
  }, [filterKey, tasteKey]);

  function refill(): Promise<void> {
    if (inflight.current) return inflight.current;
    const gen = generation.current;
    const q = new URLSearchParams(filterKey);
    q.set("profile", profile.id);
    q.set("n", String(BATCH));
    if (seenHere.current.length) q.set("skip", seenHere.current.slice(-120).join(","));
    const p = getJSON<{ items: SurpriseItem[]; reason?: string }>(`/api/surprise?${q}`)
      .then((res) => {
        if (gen !== generation.current) return;
        for (const it of res.items) {
          const k = titleKey(it);
          if (seenHere.current.includes(k)) continue;
          seenHere.current.push(k);
          queue.current.push(it);
        }
        if (!res.items.length && !queue.current.length) setMessage("No hay nada con estos filtros. Prueba a cambiarlos.");
      })
      .catch((e) => {
        if (gen === generation.current && !queue.current.length) setMessage((e as Error).message);
      })
      .finally(() => {
        if (gen === generation.current) inflight.current = null;
      });
    inflight.current = p;
    return p;
  }

  /** `auto`: la primera propuesta al entrar; solo se lleva el foco si sigues en esta pestaña. */
  async function next(auto = false) {
    setMessage(null);
    if (!queue.current.length) {
      setLoading(true);
      await refill();
      // Si el lote llegó vacío por mala suerte con las fuentes, un segundo intento.
      if (!queue.current.length) await refill();
      setLoading(false);
    }
    const it = queue.current.shift();
    if (it) {
      setItem(it);
      requestAnimationFrame(() => {
        const a = document.activeElement;
        const here = !a || a === document.body || !!viewRef.current?.contains(a) || (a as HTMLElement).matches('.tab[aria-current="page"]');
        if (!auto || (here && !lastInputPointer && !viewRef.current?.closest("[hidden]"))) focusEl(againRef.current);
      });
    } else if (!message) {
      setItem(null);
    }
    if (queue.current.length < REFILL_BELOW) void refill();
  }

  // Al entrar en la pestaña ya hay una propuesta en pantalla: «Sorpréndeme» no necesita una pulsación más.
  useEffect(() => {
    const t = setTimeout(() => void next(true), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtersButton = (
    <button className="btn" ref={filtersBtn} onClick={() => setShowFilters(true)} aria-expanded={showFilters}>
      ⚙ Filtros
    </button>
  );

  return (
    <div className="view view--surprise" ref={viewRef}>
      {!item && (
        <div className="surprise-bar">
          <button className="btn btn--primary btn--big" data-autofocus onClick={() => !loading && next()} aria-disabled={loading || undefined}>
            {loading ? "Buscando…" : "🎲 ¡Sorpréndeme!"}
          </button>
          {filtersButton}
        </div>
      )}
      {message && <p className="empty">{message}</p>}
      {item && (
        <TitleFeature title={item} fit>
          <button
            className="btn btn--primary"
            ref={againRef}
            data-autofocus
            onClick={() => {
              if (loading) return;
              profile.track(item, "skip");
              next();
            }}
            // aria-disabled y no disabled: un botón deshabilitado pierde el foco y el mando se quedaba sin nada enfocado.
            aria-disabled={loading || undefined}
          >
            {loading ? "Buscando…" : "🎲 Otra"}
          </button>
          <ProfileActions title={item} onSeen={(nowSeen) => nowSeen && next()} />
          {filtersButton}
          {/* «No me gusta» y «No me interesa» descartan la propuesta y pasan a otra. */}
          <FeedbackButtons title={item} onRated={(s) => (s === "dislike" || s === "not_interested") && next()} />
        </TitleFeature>
      )}
      {showFilters && (
        <div className="sheet" data-nav-modal role="dialog" aria-modal="true" aria-label="Filtros de Sorpréndeme">
          <div className="sheet-body">
            <div className="sheet-head">
              <h2>Filtros</h2>
              <button className="btn btn--primary" data-autofocus onClick={closeFilters}>
                ✓ Listo
              </button>
            </div>
            <FiltersPanel filters={filters} onChange={onFilters} meta={meta} />
          </div>
        </div>
      )}
    </div>
  );
}
