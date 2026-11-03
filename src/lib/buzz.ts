import "server-only";
import { socialCounts, type SocialCount } from "./activity";
import { getManyFeatures } from "./reco/features";
import { affinity, getTaste } from "./reco/model";
import { getReviews, getSummaries } from "./reviews";
import { getProfile, kvGet, kvSet } from "./store";
import { parseProviders, tmdb, toTitle } from "./tmdb";
import { titleKey, type MediaType, type Provider, type Title } from "./types";

// «Estrenos que están dando que hablar»: lo que acaba de llegar a los cines de España y a las plataformas
// (con streaming en ES), ordenado por «tirón». Solo datos reales:
//  - TMDB: now_playing (región ES), discover de películas con estreno digital reciente en ES, series estrenadas hace
//    poco y series con episodios nuevos que son tendencia; tendencia semanal, popularidad y nº de votos.
//  - Votos recientes: se guarda una foto del nº de votos de cada título y se compara con la anterior (votos/día).
//  - Crítica: resúmenes de src/lib/reviews (y la nota de Rotten Tomatoes / Metacritic si ya se calcularon).
//  - Comunidad: cuántos perfiles de la app le han dado una señal positiva.
// La parte global se cachea 3 h; el orden personal (afinidad del perfil + comunidad) se calcula en cada petición.

const VERSION = 1;
const CACHE_KEY = `buzz:v${VERSION}`;
const CACHE_TTL = 3 * 3600;
const VOTES_KEY = `buzz:votes:v${VERSION}`;
const DAY_MS = 86400000;
/** Géneros de tele que no son «estrenos» con gancho: noticias, realities, telenovelas y programas de entrevistas. */
const TV_NOISE = [10763, 10764, 10766, 10767];
const MAX_ITEMS = 24;

export type BuzzKind = "cinema" | "streaming" | "series" | "episodes";

export interface BuzzItem extends Title {
  kind: BuzzKind;
  /** Fecha de estreno (cines o primera emisión), AAAA-MM-DD. */
  date: string | null;
  /** Puesto en la tendencia semanal de TMDB (1 = la más comentada), si está entre las 60 primeras. */
  trendRank: number | null;
  popularity: number;
  voteCount: number;
  /** Votos nuevos por día en TMDB desde la última foto (null si aún no hay con qué comparar). */
  votesPerDay: number | null;
  /** Nota de la crítica 0..1 (src/lib/reviews), si ya se ha calculado. */
  critic: number | null;
  rt: number | null;
  metacritic: number | null;
  /** Tirón global 0..1 (sin personalizar). */
  buzz: number;
  /** Calidad 0..1 que se usó al calcular `buzz` (para corregirla cuando llegan las críticas). */
  quality: number;
}

export interface BuzzPersonal extends BuzzItem {
  /** Orden final para este perfil. */
  score: number;
  /** Frases cortas de por qué tiene gancho: «Nº 2 en tendencias», «92 % en Rotten Tomatoes», «En cines». */
  hook: string[];
  social: SocialCount | null;
}

interface Cached {
  items: BuzzItem[];
  builtAt: number;
}

interface VoteSnap {
  t: number;
  c: Record<string, number>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = { results: any[]; dates?: { minimum: string; maximum: string } };

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Candidate {
  title: Title;
  kind: BuzzKind;
  date: string | null;
  popularity: number;
  voteCount: number;
  adult: boolean;
  genreIds: number[];
}

function cand(raw: any, type: MediaType, kind: BuzzKind): Candidate {
  return {
    title: toTitle(raw, type),
    kind,
    date: (type === "movie" ? raw.release_date : raw.first_air_date) || null,
    popularity: raw.popularity ?? 0,
    voteCount: raw.vote_count ?? 0,
    adult: !!raw.adult,
    genreIds: raw.genre_ids ?? [],
  };
}

async function fetchCandidates(now: number) {
  const today = iso(now);
  const base = { language: "es-ES", include_adult: "false" };
  const streaming = { watch_region: "ES", with_watch_monetization_types: "flatrate|free|ads" };
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const empty: Raw = { results: [] };
  const [cinema1, cinema2, digital1, digital2, series, airing, trend1, trend2, trend3] = await Promise.all([
    safe(tmdb<Raw>("/movie/now_playing", { ...base, region: "ES", page: 1 }, 3 * 3600), empty),
    safe(tmdb<Raw>("/movie/now_playing", { ...base, region: "ES", page: 2 }, 3 * 3600), empty),
    // Estreno digital (tipo 4) en España en los últimos 60 días y ya en alguna plataforma de suscripción.
    ...[1, 2].map((page) =>
      safe(
        tmdb<Raw>(
          "/discover/movie",
          {
            ...base,
            ...streaming,
            region: "ES",
            with_release_type: 4,
            "release_date.gte": iso(now - 60 * DAY_MS),
            "release_date.lte": today,
            sort_by: "popularity.desc",
            page,
          },
          3 * 3600,
        ),
        empty,
      ),
    ),
    safe(
      tmdb<Raw>(
        "/discover/tv",
        {
          ...base,
          ...streaming,
          "first_air_date.gte": iso(now - 60 * DAY_MS),
          "first_air_date.lte": today,
          without_genres: TV_NOISE.join(","),
          sort_by: "popularity.desc",
        },
        3 * 3600,
      ),
      empty,
    ),
    safe(
      tmdb<Raw>(
        "/discover/tv",
        {
          ...base,
          ...streaming,
          "air_date.gte": iso(now - 10 * DAY_MS),
          "air_date.lte": today,
          without_genres: TV_NOISE.join(","),
          sort_by: "popularity.desc",
        },
        3 * 3600,
      ),
      empty,
    ),
    ...[1, 2, 3].map((page) => safe(tmdb<Raw>("/trending/all/week", { language: "es-ES", page }, 3 * 3600), empty)),
  ]);

  const trendRank = new Map<string, number>();
  [...trend1.results, ...trend2.results, ...trend3.results].forEach((r, i) => {
    if (r.media_type === "movie" || r.media_type === "tv") {
      const k = `${r.media_type}:${r.id}`;
      if (!trendRank.has(k)) trendRank.set(k, i + 1);
    }
  });

  const out = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const k = titleKey(c.title);
    if (c.adult || !c.title.backdrop || out.has(k)) return;
    out.set(k, c);
  };
  const minCinema = iso(now - 50 * DAY_MS);
  for (const r of [...cinema1.results, ...cinema2.results]) {
    const c = cand(r, "movie", "cinema");
    // now_playing incluye preestrenos y reposiciones: solo lo estrenado en las últimas semanas.
    if (c.date && c.date <= today && c.date >= minCinema) add(c);
  }
  for (const r of [...digital1.results, ...digital2.results]) add(cand(r, "movie", "streaming"));
  for (const r of series.results) add(cand(r, "tv", "series"));
  // Series con episodios nuevos: solo las que además son tendencia (si no, salen culebrones de 30 temporadas).
  for (const r of airing.results) {
    const c = cand(r, "tv", "episodes");
    if (trendRank.has(`tv:${r.id}`) && !out.has(`tv:${r.id}`)) add(c);
  }
  return { candidates: [...out.values()], trendRank };
}

/** Votos/día desde la foto anterior. La foto se renueva como mucho una vez cada 20 h, para medir a escala de días. */
async function votesVelocity(counts: Record<string, number>, now: number): Promise<Record<string, number>> {
  const snap = (await kvGet<{ prev: VoteSnap | null; cur: VoteSnap }>(VOTES_KEY).catch(() => null)) ?? null;
  let prev = snap?.prev ?? null;
  let cur = snap?.cur ?? null;
  if (!cur) {
    cur = { t: now, c: counts };
  } else if (now - cur.t > 20 * 3600 * 1000) {
    prev = cur;
    cur = { t: now, c: { ...cur.c, ...counts } };
  } else {
    cur = { t: cur.t, c: { ...counts, ...cur.c } };
  }
  await kvSet(VOTES_KEY, { prev, cur }, 21 * 86400).catch(() => {});
  const out: Record<string, number> = {};
  if (!prev) return out;
  const days = Math.max(0.5, (now - prev.t) / DAY_MS);
  for (const [k, c] of Object.entries(counts)) if (prev.c[k] != null) out[k] = Math.max(0, (c - prev.c[k]) / days);
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

async function build(now: number): Promise<Cached> {
  const { candidates, trendRank } = await fetchCandidates(now);
  const keys = candidates.map((c) => titleKey(c.title));
  const [velocity, summaries] = await Promise.all([
    votesVelocity(Object.fromEntries(candidates.map((c) => [titleKey(c.title), c.voteCount])), now),
    getSummaries(keys),
  ]);

  const maxPop = Math.max(1, ...candidates.map((c) => c.popularity));
  const maxVel = Math.max(1, ...Object.values(velocity));
  const maxVotes = Math.max(1, ...candidates.map((c) => c.voteCount));
  const scored: BuzzItem[] = candidates.map((c) => {
    const k = titleKey(c.title);
    const rank = trendRank.get(k) ?? null;
    const critic = summaries.get(k)?.critic ?? null;
    const vel = velocity[k] ?? null;
    const days = c.date ? Math.max(0, (now - Date.parse(c.date)) / DAY_MS) : 60;
    const trend = rank ? 1 - (rank - 1) / 60 : 0;
    const pop = Math.log10(c.popularity + 1) / Math.log10(maxPop + 1);
    const votes = vel != null ? Math.log10(vel + 1) / Math.log10(maxVel + 1) : (0.5 * Math.log10(c.voteCount + 1)) / Math.log10(maxVotes + 1);
    // Calidad: la crítica si la hay; si no, la nota de TMDB solo con votos suficientes; neutra en otro caso.
    const quality = critic ?? (c.voteCount >= 80 && c.title.rating ? c.title.rating / 10 : 0.55);
    const fresh = Math.max(0, 1 - days / 60);
    const buzz = 0.33 * trend + 0.22 * pop + 0.15 * votes + 0.2 * quality + 0.1 * fresh;
    return {
      ...c.title,
      kind: c.kind,
      date: c.date,
      trendRank: rank,
      popularity: c.popularity,
      voteCount: c.voteCount,
      votesPerDay: vel != null ? Math.round(vel) : null,
      critic,
      rt: null,
      metacritic: null,
      buzz: Math.round(buzz * 1000) / 1000,
      quality,
    };
  });
  // Variedad: como mucho 9 de cada tipo, para que no sean todo series o todo cine.
  scored.sort((a, b) => b.buzz - a.buzz);
  const perKind = new Map<BuzzKind, number>();
  const items = scored
    .filter((it) => {
      const n = perKind.get(it.kind) ?? 0;
      if (n >= 9) return false;
      perKind.set(it.kind, n + 1);
      return true;
    })
    .slice(0, MAX_ITEMS);

  // Plataformas en España (cacheadas un día).
  await Promise.all(
    items.map(async (it) => {
      if (it.kind !== "cinema") {
        const wp = await tmdb(`/${it.type}/${it.id}/watch/providers`, {}, 86400).catch(() => null);
        if (wp) {
          const { providers } = parseProviders(wp);
          it.providers = providers;
        }
      }
    }),
  );
  return { items, builtAt: now };
}

// ---------- Notas de la crítica ----------
// Las críticas se calculan en segundo plano (warmReviews en after()); cuando están, se guarda aquí un mapa pequeño
// con la nota de cada estreno para que el gancho («99 % en Rotten Tomatoes») salga sin esperar al siguiente cálculo.

const SCORES_KEY = `buzz:scores:v${VERSION}`;
type ScoreMap = Record<string, { critic: number | null; rt: number | null; mc: number | null }>;

/** Lee las críticas ya calculadas de estos títulos y actualiza el mapa de notas. Pensado para after(). */
export async function refreshBuzzScores(keys: string[]): Promise<void> {
  const sums = await getSummaries(keys);
  const prev = (await kvGet<ScoreMap>(SCORES_KEY).catch(() => null)) ?? {};
  const next: ScoreMap = {};
  for (const k of keys) {
    if (prev[k]) next[k] = prev[k];
    if (!sums.has(k) || prev[k]) continue;
    const [type, id] = k.split(":");
    // Con resumen, la crítica completa ya está en caché: esto no consulta fuentes.
    const full = await withTimeout(getReviews(type as MediaType, Number(id)), 2000);
    if (full) next[k] = { critic: full.critic, rt: full.scores.rt ?? null, mc: full.scores.metacritic ?? null };
  }
  await kvSet(SCORES_KEY, next, 7 * 86400).catch(() => {});
}

/** Estrenos con tirón (globales, cacheados). `fresh` = se acaba de calcular (para lanzar tareas en segundo plano). */
export async function getBuzz(): Promise<{ items: BuzzItem[]; builtAt: number; fresh: boolean }> {
  const cached = await kvGet<Cached>(CACHE_KEY).catch(() => null);
  if (cached?.items?.length) return { ...cached, fresh: false };
  const built = await build(Date.now());
  if (built.items.length) await kvSet(CACHE_KEY, built, CACHE_TTL).catch(() => {});
  return { ...built, fresh: true };
}

const KIND_LABEL: Record<BuzzKind, string> = { cinema: "En cines", streaming: "Nueva en plataformas", series: "Serie nueva", episodes: "Nuevos episodios" };

function providerLabel(it: BuzzItem): string {
  const all = (it.providers ?? []).map((p: Provider) => p.name);
  // Dos plataformas solo si caben; si no, la primera (la de más prioridad en España).
  const names = all.length > 1 && all[0].length + all[1].length <= 22 ? all.slice(0, 2) : all.slice(0, 1);
  if (it.kind === "cinema") return KIND_LABEL.cinema;
  if (!names.length) return KIND_LABEL[it.kind];
  if (it.kind === "episodes") return `Nuevos episodios en ${names.join(" y ")}`;
  return `${it.kind === "series" ? "Estreno" : "Nueva"} en ${names.join(" y ")}`;
}

function socialLabel(s: SocialCount): string {
  if (s.n === 1) {
    const verb = s.top === "love" ? "le encantó" : s.top === "like" ? "le gustó" : s.top === "seen" ? "la ha visto" : "la quiere ver";
    return s.top === "love" || s.top === "like" ? `A ${s.names[0]} ${verb}` : `${s.names[0]} ${verb}`;
  }
  return `Gusta a ${s.n} perfiles de QuéVer`;
}

/** Frases de gancho, de la más fuerte a la más débil (como mucho 3; dónde verlo va siempre al final). */
function hookOf(it: BuzzItem, social: SocialCount | null): string[] {
  const out: string[] = [];
  if (it.trendRank && it.trendRank <= 20) out.push(`Nº ${it.trendRank} en tendencias`);
  // La nota solo se cuenta como gancho si es buena (un 31 % en Rotten Tomatoes no anima a verla).
  if (it.rt != null && it.rt >= 70) out.push(`${it.rt} % en Rotten Tomatoes`);
  else if (it.rt == null && it.metacritic != null && it.metacritic >= 65) out.push(`${it.metacritic} en Metacritic`);
  else if (it.critic != null && it.critic >= 0.72) out.push("Muy buena crítica");
  else if (it.voteCount >= 150 && (it.rating ?? 0) >= 7.5) out.push(`${(it.rating ?? 0).toFixed(1).replace(".", ",")} en TMDB`);
  if (it.votesPerDay != null && it.votesPerDay >= 30) out.push(`+${it.votesPerDay.toLocaleString("es-ES")} votos al día`);
  if (social) out.unshift(socialLabel(social));
  return [...out.slice(0, 2), providerLabel(it)];
}

/**
 * Estrenos con tirón ordenados para un perfil: tirón global + afinidad con sus gustos + perfiles de la app a los que
 * les gusta. Se quitan los que ha rechazado o ya ha visto; lo que ya ha valorado bien va al final.
 */
export async function buzzFor(profileId: string, limit = 12): Promise<{ items: BuzzPersonal[]; builtAt: number; fresh: boolean; keys: string[] }> {
  const { items, builtAt, fresh } = await getBuzz();
  const keys = items.map((it) => titleKey(it));
  const [taste, data, counts, scores] = await Promise.all([
    getTaste(profileId).catch(() => null),
    getProfile(profileId).catch(() => null),
    socialCounts(profileId).catch(() => ({}) as Record<string, SocialCount>),
    kvGet<ScoreMap>(SCORES_KEY).catch(() => null),
  ]);
  const seen = new Set(data?.seen ?? []);
  const rejected = new Set(taste?.rejected ?? []);
  const fb = data?.feedback ?? {};
  const pool = items.filter((it) => {
    const k = titleKey(it);
    const s = fb[k]?.s;
    return !seen.has(k) && !rejected.has(k) && s !== "dislike" && s !== "not_interested";
  });
  // Afinidad solo si el modelo tiene señales: los rasgos de estos títulos se calculan una vez y se cachean 30 días.
  const feats = taste && taste.signals > 0 ? await withTimeout(getManyFeatures(pool.map((it) => titleKey(it))), 4000) : null;
  const scored = pool.map((raw): BuzzPersonal => {
    const k = titleKey(raw);
    // Críticas llegadas después del cálculo global: se corrige la parte de calidad del tirón.
    const sc = scores?.[k];
    const it: BuzzItem = sc
      ? { ...raw, critic: sc.critic, rt: sc.rt, metacritic: sc.mc, buzz: raw.buzz + (sc.critic != null ? 0.2 * (sc.critic - (raw.quality ?? 0.55)) : 0) }
      : raw;
    const social = counts[k] ?? null;
    const f = feats?.get(k);
    const aff = f && taste ? affinity(taste, f.f) : 0;
    const rated = fb[k]?.s === "love" || fb[k]?.s === "like";
    const score = it.buzz + 0.35 * aff + Math.min(0.3, (social?.n ?? 0) * 0.12) - (rated ? 1 : 0);
    return { ...it, score: Math.round(score * 1000) / 1000, hook: hookOf(it, social), social };
  });
  scored.sort((a, b) => b.score - a.score);
  return { items: scored.slice(0, limit), builtAt, fresh, keys };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
