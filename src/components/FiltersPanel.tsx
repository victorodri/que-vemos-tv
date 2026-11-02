"use client";
import { RATING_OPTIONS, RUNTIME_OPTIONS, YEAR_OPTIONS } from "@/lib/filters";
import type { Filters, Meta } from "@/lib/types";
import { useProfile } from "./profileContext";

function Row<T>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      <div className="chips">
        {options.map((o) => (
          <button key={String(o.value)} className="chip" aria-pressed={o.value === value} onClick={() => onPick(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function FiltersPanel({ filters, onChange, meta }: { filters: Filters; onChange: (f: Filters) => void; meta: Meta }) {
  const { data } = useProfile();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const genres = [{ value: null as number | null, label: "Todos" }, ...meta.genres[filters.type].map((g) => ({ value: g.id as number | null, label: g.name }))];

  return (
    <section className="filters" aria-label="Filtros">
      <Row
        label="Tipo"
        value={filters.type}
        options={[
          { value: "movie" as const, label: "Películas" },
          { value: "tv" as const, label: "Series" },
        ]}
        // Géneros y duraciones son distintos en pelis y series: se reinician al cambiar.
        onPick={(type) => type !== filters.type && set({ type, genre: null, maxRuntime: null })}
      />
      <Row label="Género" value={filters.genre} options={genres} onPick={(genre) => set({ genre })} />
      <Row label="Duración" value={filters.maxRuntime} options={RUNTIME_OPTIONS[filters.type]} onPick={(maxRuntime) => set({ maxRuntime })} />
      <Row label="Nota" value={filters.minRating} options={RATING_OPTIONS} onPick={(minRating) => set({ minRating })} />
      <Row label="Año" value={filters.year} options={YEAR_OPTIONS} onPick={(year) => set({ year })} />
      {data.prefs && (
        <Row
          label="Gustos"
          value={filters.taste}
          options={[
            { value: true, label: "Según mis gustos" },
            { value: false, label: "Ver de todo" },
          ]}
          onPick={(taste) => set({ taste })}
        />
      )}
      <Row
        label="Dónde"
        value={filters.onlyMine}
        options={[
          { value: false, label: "Todas las plataformas" },
          { value: true, label: data.platforms.length ? `Solo las mías (${data.platforms.length})` : "Solo las mías (configúralas)" },
        ]}
        onPick={(onlyMine) => set({ onlyMine })}
      />
    </section>
  );
}
