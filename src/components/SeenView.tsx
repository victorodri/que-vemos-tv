"use client";
import { useEffect, useMemo, useState } from "react";
import { getJSON } from "@/lib/client";
import { titleKey, type MediaType, type Meta, type SeenItem } from "@/lib/types";
import { useProfile } from "./profileContext";
import { TitleCard } from "./TitleCard";

type Kind = MediaType | "all";

const monthFmt = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const dayYearFmt = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" });
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function seenLabel(t: number | null) {
  if (!t) return null;
  const d = new Date(t);
  return `Vista el ${(d.getFullYear() === new Date().getFullYear() ? dayFmt : dayYearFmt).format(d)}`;
}

/** Listado de lo marcado como visto: del más reciente al más antiguo, por meses, con filtros de tipo y género. */
export function SeenView({ meta, onOpen }: { meta: Meta; onOpen: (t: SeenItem) => void }) {
  const profile = useProfile();
  const pareja = profile.id === "pareja";
  const [items, setItems] = useState<SeenItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [kind, setKind] = useState<Kind>("all");
  const [genre, setGenre] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    getJSON<{ items: SeenItem[] }>(`/api/seen?profile=${profile.id}`, ctrl.signal)
      .then((r) => setItems(r.items))
      .catch((e) => !ctrl.signal.aborted && setError((e as Error).message));
    return () => ctrl.abort();
  }, [profile.id, reload]);

  // Nombre de género por tipo (pelis y series tienen IDs distintos; se agrupan por nombre).
  const genreName = useMemo(() => {
    const m = { movie: new Map<number, string>(), tv: new Map<number, string>() };
    for (const type of ["movie", "tv"] as const) for (const g of meta.genres[type]) m[type].set(g.id, g.name);
    return (t: SeenItem) => t.genreIds.map((id) => m[t.type].get(id)).filter((n): n is string => Boolean(n));
  }, [meta]);

  // Lo desmarcado desaparece al momento; la fecha más fresca es la del perfil en memoria.
  const seenAt = profile.data.seenAt ?? {};
  const all = (items ?? []).filter((t) => profile.isSeen(t)).map((t) => ({ ...t, seenAt: seenAt[titleKey(t)] ?? t.seenAt }));
  all.sort((a, b) => (b.seenAt ?? -1) - (a.seenAt ?? -1));

  const ofKind = kind === "all" ? all : all.filter((t) => t.type === kind);
  const genreCounts = new Map<string, number>();
  for (const t of ofKind) for (const g of new Set(genreName(t))) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  const genres = [...genreCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
  const activeGenre = genre && genreCounts.has(genre) ? genre : null;
  const shown = activeGenre ? ofKind.filter((t) => genreName(t).includes(activeGenre)) : ofKind;

  // Grupos por mes («Noviembre de 2026»); lo que no tiene fecha, al final.
  const groups: { label: string; items: SeenItem[] }[] = [];
  for (const t of shown) {
    const label = t.seenAt ? capitalize(monthFmt.format(new Date(t.seenAt))) : "Sin fecha";
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(t);
    else groups.push({ label, items: [t] });
  }

  const counts = { all: all.length, movie: all.filter((t) => t.type === "movie").length, tv: all.filter((t) => t.type === "tv").length };
  const kinds: { id: Kind; label: string }[] = [
    { id: "all", label: "Todo" },
    { id: "movie", label: "Películas" },
    { id: "tv", label: "Series" },
  ];

  return (
    <div className="view">
      <div className="list-header">
        <div>
          <h2>{pareja ? "Lo que hemos visto" : "Lo que he visto"}</h2>
          <p className="hint">Lo más reciente primero. Abre un título para valorarlo o desmarcarlo.</p>
        </div>
      </div>

      {error && (
        <div className="error-box">
          <p className="error">No se ha podido cargar el listado: {error}</p>
          <button className="btn" data-autofocus onClick={() => setReload((n) => n + 1)}>
            ↻ Reintentar
          </button>
        </div>
      )}
      {!error && items === null && <p className="loading">Cargando vistos…</p>}

      {items !== null && all.length === 0 && (
        <p className="empty">
          {pareja ? "Aún no habéis marcado nada como visto." : "Aún no has marcado nada como visto."} En la ficha de un título, pulsa «👁{" "}
          {pareja ? "Ya la hemos visto" : "Ya la he visto"}».
        </p>
      )}

      {all.length > 0 && (
        <div className="seen-filters">
          <div className="chips" role="group" aria-label="Tipo">
            {kinds.map((k) => (
              <button
                key={k.id}
                className="chip"
                aria-pressed={kind === k.id}
                data-autofocus={kind === k.id || undefined}
                disabled={k.id !== "all" && counts[k.id] === 0}
                onClick={() => setKind(k.id)}
              >
                {k.label} <span className="chip-count">{counts[k.id]}</span>
              </button>
            ))}
          </div>
          {genres.length > 1 && (
            <div className="chips" role="group" aria-label="Género">
              <button className="chip" aria-pressed={!activeGenre} onClick={() => setGenre(null)}>
                Todos los géneros
              </button>
              {genres.map(([name, n]) => (
                <button key={name} className="chip" aria-pressed={activeGenre === name} onClick={() => setGenre(activeGenre === name ? null : name)}>
                  {name} <span className="chip-count">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {all.length > 0 && shown.length === 0 && <p className="empty">No hay vistos con este filtro.</p>}

      {groups.map((g) => (
        <section key={g.label} className="seen-group" aria-label={g.label}>
          <h3 className="shelf-title">
            {g.label} <span className="chip-count">{g.items.length}</span>
          </h3>
          <div className="grid">
            {g.items.map((t) => (
              <TitleCard key={titleKey(t)} title={t} note={seenLabel(t.seenAt)} hideSeen onOpen={() => onOpen(t)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
