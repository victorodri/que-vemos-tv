"use client";
import { useEffect, useRef, useState } from "react";
import { filtersToParams } from "@/lib/filters";
import { getJSON } from "@/lib/client";
import type { Filters, Meta, Title } from "@/lib/types";
import { FiltersPanel } from "./FiltersPanel";
import { useProfile } from "./profileContext";
import { TitleCard } from "./TitleCard";

interface PageResult {
  items: Title[];
  page: number;
  totalPages: number;
  totalResults: number;
}

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
  const [items, setItems] = useState<Title[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const params = filtersToParams(filters);
  params.set("profile", profile.id);
  // Si filtra por "mis plataformas", cambiar las plataformas debe recargar.
  if (filters.onlyMine) params.set("p", profile.data.platforms.join("."));
  const key = params.toString();

  async function load(nextPage: number) {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams(key);
      q.delete("p");
      q.set("page", String(nextPage));
      const res = await getJSON<PageResult>(`/api/titles?${q}`, ctrl.signal);
      setItems((prev) => (nextPage === 1 ? res.items : [...prev, ...res.items]));
      setPage(res.page);
      setTotalPages(res.totalPages);
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => load(1), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

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
      {filters.query && filters.maxRuntime && <p className="hint">Al buscar por texto no se puede filtrar por duración.</p>}
      {filters.onlyMine && !profile.data.platforms.length && <p className="hint">Elige tus plataformas en la pestaña «Plataformas».</p>}

      {error && <p className="error">{error}</p>}
      {!loading && !error && items.length === 0 && <p className="empty">No hay resultados con estos filtros.</p>}

      <div className="grid">
        {items.map((t) => (
          <TitleCard key={`${t.type}:${t.id}`} title={t} onOpen={() => onOpen(t)} />
        ))}
      </div>

      {loading && <p className="loading">Cargando…</p>}
      {!loading && page < totalPages && items.length > 0 && (
        <div className="more">
          <button className="btn" onClick={() => load(page + 1)}>
            Cargar más
          </button>
        </div>
      )}
    </div>
  );
}
