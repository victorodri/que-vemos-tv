"use client";
import { useEffect, useRef, useState } from "react";
import { filtersToParams } from "@/lib/filters";
import { getJSON, hashOf } from "@/lib/client";
import { titleKey, type Filters, type Meta, type TitleDetail } from "@/lib/types";
import { FiltersPanel } from "./FiltersPanel";
import { useProfile } from "./profileContext";
import { focusEl } from "./spatialNav";
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
  const filterKey = filtersToParams({ ...filters, query: "" }).toString();
  const tasteKey = hashOf([profile.data.platforms, profile.data.prefs]);

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

  async function next() {
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
      requestAnimationFrame(() => focusEl(againRef.current));
    } else if (!message) {
      setItem(null);
    }
    if (queue.current.length < REFILL_BELOW) void refill();
  }

  return (
    <div className="view">
      <div className="surprise-bar">
        {!item && (
          <button className="btn btn--primary btn--big" data-autofocus onClick={next} disabled={loading}>
            {loading ? "Buscando…" : "🎲 ¡Sorpréndeme!"}
          </button>
        )}
        <button className="btn" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
          {showFilters ? "Ocultar filtros" : "Cambiar filtros"}
        </button>
      </div>
      {showFilters && <FiltersPanel filters={filters} onChange={onFilters} meta={meta} />}
      {message && <p className="empty">{message}</p>}
      {item && (
        <TitleFeature title={item}>
          <button
            className="btn btn--primary"
            ref={againRef}
            onClick={() => {
              profile.track(item, "skip");
              next();
            }}
            disabled={loading}
          >
            {loading ? "Buscando…" : "🎲 Otra"}
          </button>
          <ProfileActions title={item} onSeen={(nowSeen) => nowSeen && next()} />
          {/* «No me gusta» y «No me interesa» descartan la propuesta y pasan a otra. */}
          <FeedbackButtons title={item} onRated={(s) => (s === "dislike" || s === "not_interested") && next()} />
        </TitleFeature>
      )}
    </div>
  );
}
