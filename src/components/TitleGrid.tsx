"use client";
import type { Title } from "@/lib/types";
import { TitleCard } from "./TitleCard";

export function TitleGrid({
  items,
  loading,
  error,
  hasMore,
  loadMore,
  onOpen,
  empty = "No hay resultados con estos filtros.",
}: {
  items: Title[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  onOpen: (t: Title) => void;
  empty?: string;
}) {
  return (
    <>
      {error && <p className="error">{error}</p>}
      {!loading && !error && items.length === 0 && <p className="empty">{empty}</p>}
      <div className="grid">
        {items.map((t) => (
          <TitleCard key={`${t.type}:${t.id}`} title={t} onOpen={() => onOpen(t)} />
        ))}
      </div>
      {loading && <p className="loading">Cargando…</p>}
      {!loading && hasMore && items.length > 0 && (
        <div className="more">
          <button className="btn" onClick={loadMore}>
            Cargar más
          </button>
        </div>
      )}
    </>
  );
}
