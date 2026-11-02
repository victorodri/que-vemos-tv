"use client";
import { useEffect, useRef, useState } from "react";
import { filtersToParams } from "@/lib/filters";
import { getJSON } from "@/lib/client";
import { titleKey, type Filters, type Meta, type TitleDetail } from "@/lib/types";
import { FiltersPanel } from "./FiltersPanel";
import { useProfile } from "./profileContext";
import { focusEl } from "./spatialNav";
import { ProfileActions, TitleFeature } from "./TitleFeature";

export function SurpriseView({ filters, onFilters, meta }: { filters: Filters; onFilters: (f: Filters) => void; meta: Meta }) {
  const profile = useProfile();
  const [item, setItem] = useState<TitleDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const skip = useRef<string[]>([]);
  const againRef = useRef<HTMLButtonElement>(null);
  const filterKey = filtersToParams({ ...filters, query: "" }).toString();

  // Con filtros nuevos, las propuestas anteriores vuelven a valer.
  useEffect(() => {
    skip.current = [];
  }, [filterKey]);

  async function next() {
    setLoading(true);
    setMessage(null);
    try {
      const q = new URLSearchParams(filterKey);
      q.set("profile", profile.id);
      // Solo las últimas 40 para no hacer URLs enormes.
      if (skip.current.length) q.set("skip", skip.current.slice(-40).join(","));
      const res = await getJSON<{ item: TitleDetail | null; reason?: string }>(`/api/surprise?${q}`);
      if (res.item) {
        skip.current.push(titleKey(res.item));
        setItem(res.item);
        requestAnimationFrame(() => focusEl(againRef.current));
      } else {
        setItem(null);
        setMessage(res.reason === "exhausted" ? "Ya os he propuesto todo lo que hay con estos filtros. Prueba a cambiarlos." : "No hay nada con estos filtros.");
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setLoading(false);
    }
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
          <button className="btn btn--primary" ref={againRef} onClick={next} disabled={loading}>
            {loading ? "Buscando…" : "🎲 Otra"}
          </button>
          <ProfileActions title={item} onSeen={(nowSeen) => nowSeen && next()} />
        </TitleFeature>
      )}
    </div>
  );
}
