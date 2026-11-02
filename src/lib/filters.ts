import type { Filters, MediaType } from "./types";

export const DEFAULT_FILTERS: Filters = {
  type: "movie",
  genre: null,
  maxRuntime: null,
  minRating: null,
  year: null,
  onlyMine: false,
  query: "",
};

type Option<T> = { value: T; label: string };

export const RUNTIME_OPTIONS: Record<MediaType, Option<number | null>[]> = {
  movie: [
    { value: null, label: "Cualquiera" },
    { value: 90, label: "≤ 90 min" },
    { value: 120, label: "≤ 2 h" },
    { value: 150, label: "≤ 2 h 30" },
  ],
  tv: [
    { value: null, label: "Cualquiera" },
    { value: 30, label: "≤ 30 min/cap." },
    { value: 45, label: "≤ 45 min/cap." },
    { value: 60, label: "≤ 1 h/cap." },
  ],
};

export const RATING_OPTIONS: Option<number | null>[] = [
  { value: null, label: "Cualquiera" },
  { value: 6, label: "★ 6+" },
  { value: 7, label: "★ 7+" },
  { value: 8, label: "★ 8+" },
];

export const YEAR_OPTIONS: Option<string | null>[] = [
  { value: null, label: "Cualquiera" },
  { value: "recent", label: "Últimos 2 años" },
  { value: "2020s", label: "2020s" },
  { value: "2010s", label: "2010s" },
  { value: "2000s", label: "2000s" },
  { value: "1990s", label: "Años 90" },
  { value: "classic", label: "Antes de 1990" },
];

/** Devuelve [desde, hasta] (años inclusivos) para un valor de YEAR_OPTIONS. */
export function yearRange(value: string | null): [number | null, number | null] {
  const now = new Date().getFullYear();
  switch (value) {
    case "recent":
      return [now - 1, now];
    case "2020s":
      return [2020, 2029];
    case "2010s":
      return [2010, 2019];
    case "2000s":
      return [2000, 2009];
    case "1990s":
      return [1990, 1999];
    case "classic":
      return [null, 1989];
    default:
      return [null, null];
  }
}

export function filtersToParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams({ type: f.type });
  if (f.genre != null) p.set("genre", String(f.genre));
  if (f.maxRuntime != null) p.set("runtime", String(f.maxRuntime));
  if (f.minRating != null) p.set("rating", String(f.minRating));
  if (f.year) p.set("year", f.year);
  if (f.onlyMine) p.set("mine", "1");
  if (f.query.trim()) p.set("q", f.query.trim());
  return p;
}

export function paramsToFilters(p: URLSearchParams): Filters {
  const num = (k: string) => {
    const v = p.get(k);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    type: p.get("type") === "tv" ? "tv" : "movie",
    genre: num("genre"),
    maxRuntime: num("runtime"),
    minRating: num("rating"),
    year: p.get("year"),
    onlyMine: p.get("mine") === "1",
    query: (p.get("q") ?? "").slice(0, 100),
  };
}
