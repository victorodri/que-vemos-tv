import "server-only";
import { yearRange } from "./filters";
import { prefsToDiscover, type Prefs } from "./prefs";
import type { Filters, Genre, MediaType, Provider, Title, TitleDetail } from "./types";

const BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";
const REGION = "ES";
const LANG = "es-ES";
const HOUR = 3600;
const DAY = 24 * HOUR;

export class TmdbError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | null | undefined>;

async function tmdb<T>(path: string, params: Params = {}, revalidate = HOUR): Promise<T> {
  const key = process.env.TMDB_API_KEY?.trim();
  if (!key) throw new TmdbError(500, "Falta la variable de entorno TMDB_API_KEY");

  const url = new URL(BASE + path);
  const headers: Record<string, string> = { accept: "application/json" };
  // Acepta tanto la API Key v3 como el Read Access Token v4 (un JWT que empieza por "eyJ").
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers, next: { revalidate } });
  if (!res.ok) {
    const msg = res.status === 401 ? "La API key de TMDB no es válida" : `TMDB respondió ${res.status}`;
    throw new TmdbError(res.status === 401 ? 500 : 502, msg);
  }
  return res.json() as Promise<T>;
}

// ---------- Normalización ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
function toTitle(raw: any, type: MediaType): Title {
  const date: string | undefined = type === "movie" ? raw.release_date : raw.first_air_date;
  return {
    id: raw.id,
    type,
    title: (type === "movie" ? raw.title : raw.name) ?? "Sin título",
    year: date ? Number(date.slice(0, 4)) || null : null,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    overview: raw.overview ?? "",
    poster: raw.poster_path ? `${IMG}w342${raw.poster_path}` : null,
    backdrop: raw.backdrop_path ? `${IMG}w1280${raw.backdrop_path}` : null,
    genreIds: raw.genre_ids ?? raw.genres?.map((g: Genre) => g.id) ?? [],
  };
}

// "Netflix Standard with Ads" → "Netflix", "HBO Max Amazon Channel" → "HBO Max": así se agrupan duplicados.
const cleanProviderName = (n: string) =>
  n
    .replace(/\s+(Standard\s+)?with Ads$/i, "")
    .replace(/\s+(Amazon|Apple TV|Prime Video)\s+Channel$/i, "")
    .trim();

function parseProviders(wp: any): { providers: Provider[]; rentOrBuy: boolean; link: string | null } {
  const es = wp?.results?.[REGION];
  if (!es) return { providers: [], rentOrBuy: false, link: null };
  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const p of [...(es.flatrate ?? []), ...(es.free ?? []), ...(es.ads ?? [])]) {
    const name = cleanProviderName(p.provider_name);
    if (seen.has(name)) continue;
    seen.add(name);
    providers.push({ id: p.provider_id, name, logo: p.logo_path ? `${IMG}w92${p.logo_path}` : null });
  }
  return { providers, rentOrBuy: Boolean(es.rent?.length || es.buy?.length), link: es.link ?? null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Listados ----------

export interface Page {
  items: Title[];
  page: number;
  totalPages: number;
  totalResults: number;
}

interface RawPage {
  results: unknown[];
  page: number;
  total_pages: number;
  total_results: number;
}

const toPage = (raw: RawPage, type: MediaType): Page => ({
  items: raw.results.map((r) => toTitle(r, type)),
  page: raw.page,
  totalPages: Math.min(raw.total_pages, 500), // TMDB no sirve más allá de la página 500
  totalResults: raw.total_results,
});

/**
 * Discover con todos los filtros. Solo devuelve títulos disponibles en streaming en España.
 * Con `f.taste` y gustos guardados, cada filtro en «Cualquiera» se rellena con los gustos del perfil.
 */
export async function discover(f: Filters, page: number, opts: { platforms?: number[]; prefs?: Prefs | null } = {}): Promise<Page> {
  const platforms = opts.platforms ?? [];
  const taste = f.taste && opts.prefs ? prefsToDiscover(opts.prefs, f.type) : null;
  const [yearFrom, to] = yearRange(f.year);
  const from = f.year ? yearFrom : (taste?.fromYear ?? null);
  const maxRuntime = f.maxRuntime ?? taste?.maxRuntime ?? null;
  const hidden = taste?.discovery === "hidden";
  const isMovie = f.type === "movie";
  const dateField = isMovie ? "primary_release_date" : "first_air_date";
  const raw = await tmdb<RawPage>(`/discover/${f.type}`, {
    language: LANG,
    region: REGION,
    watch_region: REGION,
    with_watch_monetization_types: "flatrate|free|ads",
    with_watch_providers: platforms.length ? platforms.join("|") : null,
    with_genres: f.genre ?? (taste?.withGenres.length ? taste.withGenres.join("|") : null),
    without_genres: taste?.withoutGenres.filter((g) => g !== f.genre).join(",") || null,
    "with_runtime.lte": maxRuntime,
    "with_runtime.gte": maxRuntime ? 1 : null, // descarta títulos sin duración conocida
    "vote_average.gte": f.minRating ?? taste?.minRating ?? null,
    "vote_count.gte": isMovie ? 150 : 50,
    // «Joyas ocultas»: bien valoradas pero con pocos votos.
    "vote_count.lte": hidden ? (isMovie ? 2500 : 600) : null,
    [`${dateField}.gte`]: from ? `${from}-01-01` : null,
    [`${dateField}.lte`]: to ? `${to}-12-31` : null,
    sort_by: hidden ? "vote_average.desc" : "popularity.desc",
    include_adult: "false",
    page,
  });
  return toPage(raw, f.type);
}

/**
 * Búsqueda por texto. TMDB no admite filtros en /search, así que género, nota y año
 * se aplican después; la duración no se puede aplicar sin pedir el detalle de cada título.
 */
export async function search(f: Filters, page: number): Promise<Page> {
  const raw = await tmdb<RawPage>(`/search/${f.type}`, {
    query: f.query,
    language: LANG,
    region: REGION,
    include_adult: "false",
    page,
  });
  const result = toPage(raw, f.type);
  const [from, to] = yearRange(f.year);
  result.items = result.items.filter(
    (t) =>
      (f.genre == null || t.genreIds.includes(f.genre)) &&
      (f.minRating == null || (t.rating ?? 0) >= f.minRating) &&
      (from == null || (t.year ?? 0) >= from) &&
      (to == null || (t.year != null && t.year <= to)),
  );
  return result;
}

// ---------- Plataformas y detalle ----------

export async function getProviders(type: MediaType, id: number) {
  return parseProviders(await tmdb(`/${type}/${id}/watch/providers`, {}, DAY));
}

/** Añade las plataformas de España a cada título (las peticiones se cachean un día). */
export async function withProviders(items: Title[]): Promise<Title[]> {
  return Promise.all(
    items.map(async (t) => {
      try {
        const { providers, rentOrBuy } = await getProviders(t.type, t.id);
        return { ...t, providers, rentOrBuy };
      } catch {
        return { ...t, providers: [] };
      }
    }),
  );
}

export async function getDetail(type: MediaType, id: number): Promise<TitleDetail> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await tmdb<any>(`/${type}/${id}`, { language: LANG, append_to_response: "watch/providers" }, DAY);
  const base = toTitle(raw, type);
  if (!base.overview) {
    // Muchas fichas no tienen sinopsis en español: usamos la inglesa.
    const en = await tmdb<{ overview?: string }>(`/${type}/${id}`, { language: "en-US" }, DAY).catch(() => null);
    base.overview = en?.overview ?? "";
  }
  const { providers, rentOrBuy, link } = parseProviders(raw["watch/providers"]);
  return {
    ...base,
    providers,
    rentOrBuy,
    link,
    runtime: type === "movie" ? raw.runtime || null : raw.episode_run_time?.[0] || raw.last_episode_to_air?.runtime || null,
    seasons: type === "tv" ? raw.number_of_seasons ?? null : null,
    genres: (raw.genres ?? []).map((g: Genre) => g.name),
    tagline: raw.tagline ?? "",
  };
}

// ---------- Metadatos ----------

export async function getGenres(type: MediaType): Promise<Genre[]> {
  const raw = await tmdb<{ genres: Genre[] }>(`/genre/${type}/list`, { language: LANG }, DAY);
  return raw.genres;
}

/** Plataformas de suscripción más relevantes en España, ordenadas por prioridad de TMDB. */
export async function getRegionProviders(): Promise<Provider[]> {
  type Raw = {
    results: { provider_id: number; provider_name: string; logo_path: string; display_priorities?: Record<string, number> }[];
  };
  const [movie, tv] = await Promise.all(
    (["movie", "tv"] as const).map((t) => tmdb<Raw>(`/watch/providers/${t}`, { watch_region: REGION, language: LANG }, DAY)),
  );
  const byId = new Map<number, { p: Provider; prio: number }>();
  for (const r of [...movie.results, ...tv.results]) {
    // Fuera variantes con anuncios, canales de Amazon/Apple, tiendas de alquiler/compra y servicios de JustWatch.
    if (/with ads|channel|store|justwatch|google play|youtube|microsoft/i.test(r.provider_name)) continue;
    const prio = r.display_priorities?.[REGION] ?? 999;
    const prev = byId.get(r.provider_id);
    if (!prev || prio < prev.prio) {
      byId.set(r.provider_id, {
        p: { id: r.provider_id, name: r.provider_name, logo: r.logo_path ? `${IMG}w92${r.logo_path}` : null },
        prio,
      });
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.prio - b.prio)
    .slice(0, 18)
    .map((x) => x.p);
}
