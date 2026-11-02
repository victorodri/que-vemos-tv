"use client";
import { useState } from "react";
import { hashOf } from "@/lib/client";
import { filtersToParams } from "@/lib/filters";
import type { Filters, Meta, Title } from "@/lib/types";
import { FiltersPanel } from "./FiltersPanel";
import { useProfile } from "./profileContext";
import { TitleGrid } from "./TitleGrid";
import { useTitles } from "./useTitles";

export function SearchView({
  filters,
  onFilters,
  meta,
  onOpen,
}: {
  filters: Filters;
  onFilters: (f: Filters) => void;
  meta: Meta;
  onOpen: (t: Title) => void;
}) {
  const profile = useProfile();
  const [draft, setDraft] = useState(filters.query);

  const params = filtersToParams(filters);
  params.set("profile", profile.id);
  // Si cambian las plataformas o los gustos del perfil, hay que recargar.
  if (filters.onlyMine || filters.taste) params.set("v", hashOf([profile.data.platforms, profile.data.prefs]));
  const titles = useTitles(params.toString());

  return (
    <div className="view">
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          onFilters({ ...filters, query: draft });
          (document.activeElement as HTMLElement | null)?.blur?.();
        }}
      >
        <input
          type="search"
          className="search-input"
          placeholder={filters.type === "movie" ? "Buscar película…" : "Buscar serie…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
        <button className="btn btn--primary" type="submit">
          Buscar
        </button>
        {filters.query && (
          <button
            className="btn"
            type="button"
            onClick={() => {
              setDraft("");
              onFilters({ ...filters, query: "" });
            }}
          >
            ✕ Quitar búsqueda
          </button>
        )}
      </form>

      <FiltersPanel filters={filters} onChange={onFilters} meta={meta} />
      {filters.query && <p className="hint">Al buscar por texto no se aplican la duración ni tus gustos.</p>}
      {filters.onlyMine && !profile.data.platforms.length && <p className="hint">Elige tus plataformas en la pestaña «Ajustes».</p>}

      <TitleGrid {...titles} onOpen={onOpen} />
    </div>
  );
}
