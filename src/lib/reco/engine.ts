import "server-only";
import { PROFILES } from "@/config/profiles";
import { hashOf } from "../client";
import { GENRE_GROUPS, type Prefs } from "../prefs";
import { getProfile, kvGet, kvSet } from "../store";
import { getProviders, tmdb, toTitle } from "../tmdb";
import type { MediaType, Title } from "../types";
import { getManyFeatures, normalize, shallowFeatures } from "./features";
import { affinity, coupleMembers, cosine, dot, getTaste, type Vec } from "./model";
import type { ItemFeatures, RecoItem, Shelf, TasteModel } from "./types";

// Recomendador en dos fases, como los de e-commerce:
//   1. Recuperación: cientos de candidatos de varias fuentes («vinculaciones» y descubrimientos).
//   2. Ranking: criba barata con rasgos ligeros → rasgos completos (con caché) para los mejores →
//      puntuación final (afinidad + calidad + fuente + novedad) → diversificación MMR → explicación.

type Source = "because" | "discover" | "keyword" | "trending" | "gems" | "people" | "shared";

interface Candidate {
  key: string;
  type: MediaType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
  source: Source;
  /** Ancla (para «because») o persona (para «people») que originó el candidato. */
  via?: string;
  shallow: Vec;
}

interface Ranked extends Candidate {
  sources: Set<Source>;
  title: Title;
  feat: ItemFeatures | null;
  affinity: number;
  quality: number;
  score: number;
  providers: Title["providers"];
}

/** Ajustes del ranking. Centralizados aquí para poder afinarlos con la evaluación offline (scripts/eval-reco). */
export const TUNING = {
  stage1Keep: 70,
  wAffinity: 0.6,
  wQuality: 0.25,
  wPopFit: 0.05,
  sourcePrior: { because: 0.12, people: 0.08, keyword: 0.06, discover: 0.04, trending: 0.05, gems: 0.03, shared: 0.06 } as Record<Source, number>,
  /** Pareja: recuperar también por cruces de géneros favoritos de cada uno (Acción Y Romance…). */
  sharedRetrieval: true,
  /** Penalización (o premio) por que el mismo título venga de varias fuentes. */
  multiSourceBonus: 0.04,
  mmrLambda: 0.6, // evaluación offline: mejora diversidad y precisión en todas las personas
  /** Peso de la calibración de géneros en la lista principal (0 = desactivada). */
  calibration: 0.06,
  jitter: 0.02,
  minAffinity: -0.05,
  bayesM: 200,
  bayesC: 6.6,
  /** Los estrenos llegan con la nota inflada (votan primero los fans): su prior pesa hasta ×(1+freshShrink). */
  freshShrink: 3,
  /** Mínimo de votos para que un «porque te gustó X» de TMDB entre (el grafo trae series con 30 votos). */
  becauseMinVotes: { movie: 50, tv: 40 } as Record<MediaType, number>, // más alto hunde a los documentales (pocos votos)
  /**
   * Penalización por indicio romántico en series si el perfil evita el romance (las series no tienen ese género):
   * palabra clave o sinopsis romántica = 1, palabra clave o sinopsis de drama juvenil = 0,5; máximo 3.
   */
  romanceKwPenalty: 0.12,
  /** Afinidad mínima con un título que le gustó para explicar «Porque te gustó X» (explicación por ítems). */
  itemExplainMin: 0.5,
  /** Pareja: lo que uno de los dos ya vio no se bloquea (puede apetecer verlo juntos), pero baja en la lista. */
  groupSeenPenalty: 0.15,
  /** Joyas: limitar a los N idiomas originales que más gustan (0 = sin límite). Sin esto, las series «joya»
   *  eran casi todas dramas coreanos y chinos con 200 votos, aunque el perfil no hubiera visto ninguno. */
  gemsLangs: 3,
  /** Pareja: pesos de la afinidad de grupo (media, mínimo de los dos, vector propio de la pareja). */
  group: { avg: 0.35, min: 0.35, own: 0.1 },
  /** Pareja: distribución de géneros con la que se calibra la lista principal. */
  groupCalibration: "shared" as "union" | "shared" | "none", // evaluación offline: pareja·top 0,38 → 0,46 (media de 3 semillas)
};

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));

/**
 * Nota bayesiana (media ponderada con un prior de bayesM votos a bayesC). Con `date`, el prior pesa más en los
 * estrenos: las primeras notas son de fans y bajan con el tiempo (sesgo de autoselección de las primeras
 * valoraciones, Li y Hitt, «Self-Selection and Information Role of Online Product Reviews», 2008).
 * Ejemplo real: «Off Campus» (2026, 8,9 con 900 votos) puntuaba como «Los Soprano».
 */
export function bayesQuality(rating: number | null | undefined, votes: number | null | undefined, date?: string | null): number {
  const v = votes ?? 0;
  const r = rating ?? TUNING.bayesC;
  const m = TUNING.bayesM * (1 + TUNING.freshShrink * freshness(date));
  const b = (v / (v + m)) * r + (m / (v + m)) * TUNING.bayesC;
  return clamp((b - 5.5) / 3);
}

/** 1 = se acaba de estrenar, 0 = tiene dos años o más (o no se sabe). */
export function freshness(date: string | null | undefined, now = Date.now()): number {
  if (!date) return 0;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return 0;
  return clamp(1 - (now - t) / (730 * 86400000));
}

const releaseDate = (raw: { release_date?: string; first_air_date?: string }) => raw.release_date || raw.first_air_date || null;

const ROMANCE_KW = /^(romance|romantic|romantic comedy|love|first love|forbidden love|love triangle|eternal love|love at first sight|interspecies romance|secret relationship|teen romance|lovers|toxic relationship|relationship|dating|sexuality)$/i;
// El grafo de TMDB lleva de un drama de prestigio a dramas juveniles casi siempre románticos (Pequeñas mentirosas, Tell Me Lies…).
const TEEN_KW = /^(teen drama|teenager|high school|college|university|based on young adult novel|young adult|coming of age|teen)$/i;
// TMDB etiqueta mal muchas series: la sinopsis en español delata el romance que no dicen las palabras clave.
const ROMANCE_TEXT = /\b(romance|romances|romántic\w*|enamor\w*|amor(es|os[oa]s?)?|relaci(ó|o)n(es)? (tóxicas?|sentimental(es)?|amoros[oa]s?)|triángulo amoroso|su relación|novi[oa]s?|seducción|matrimonio de conveniencia)(?![\wáéíóúñ])/i;
const TEEN_TEXT = /\b(universidad|universitari\w*|instituto|adolescen\w*|campus)(?![\wáéíóúñ])/i;

/** Indicios de romance en una serie (0..3), para quien lo evita. */
function romanceHints(feat: ItemFeatures): number {
  const kws = Object.entries(feat.labels).filter(([k]) => k.startsWith("k:")).map(([, l]) => l);
  const n = kws.filter((l) => ROMANCE_KW.test(l)).length + 0.5 * kws.filter((l) => TEEN_KW.test(l)).length + (ROMANCE_TEXT.test(feat.overview) ? 1 : 0) + (TEEN_TEXT.test(feat.overview) ? 0.5 : 0);
  return Math.min(3, n);
}

const popNorm = (pop: number | undefined) => clamp(Math.log10((pop ?? 0) + 1) / 3);

function popFit(pop: number | undefined, prefs: Prefs | null) {
  const p = popNorm(pop);
  if (prefs?.discovery === "popular") return p;
  if (prefs?.discovery === "hidden") return 1 - p;
  return 0.5;
}

// ---------- Fase 1: recuperación ----------

const LANG = "es-ES";
const REGION = "ES";
const STREAMING = "flatrate|free|ads";

/** Rasgos favoritos de una familia (p. ej. «g» géneros), del más al menos querido. */
function topFeatures(w: Vec, family: string, n: number, minWeight = 0.05): string[] {
  return Object.entries(w)
    .filter(([k, x]) => k.startsWith(`${family}:`) && x > minWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k.slice(family.length + 1));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function list(path: string, params: Record<string, string | number | null>, revalidate = 3600): Promise<any[]> {
  const r = await tmdb<{ results: any[] }>(path, { language: LANG, ...params }, revalidate).catch(() => ({ results: [] }));
  return r.results ?? [];
}

function genreIdsFor(type: MediaType, w: Vec): string[] {
  const valid = new Set(GENRE_GROUPS.flatMap((g) => (g[type] as readonly number[]).map(String)));
  const fromModel = topFeatures(w, "g", 6).filter((g) => valid.has(g));
  return fromModel.slice(0, 3);
}

async function gatherCandidates(types: MediaType[], taste: TasteModel, prefs: Prefs | null, platforms: number[], members: TasteModel[] = []): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const push = (items: any[], type: MediaType, source: Source, via?: string) => {
    for (const r of items) {
      const t: MediaType = r.media_type === "movie" || r.media_type === "tv" ? r.media_type : type;
      if (!types.includes(t) || r.adult) continue;
      out.push({ key: `${t}:${r.id}`, type: t, raw: r, source, via, shallow: normalize(shallowFeatures(r, t)) });
    }
  };
  const providerParam = platforms.length ? platforms.join("|") : null;
  const avoid = GENRE_GROUPS.filter((g) => prefs?.avoid.includes(g.id));
  const jobs: Promise<void>[] = [];
  // En la pareja no se aplica: su vector mezcla dos perfiles y la evaluación offline sale peor con el límite.
  // Solo idiomas con al menos el 20 % del peso del favorito (a Víctor un único «Parásitos» le daba coreano).
  const langs = TUNING.gemsLangs && taste.signals >= 10 && members.length < 2 ? topFeatures(taste.w, "l", TUNING.gemsLangs, 0.05) : [];
  const gemsLangs = langs.filter((l) => taste.w[`l:${l}`] >= 0.2 * taste.w[`l:${langs[0]}`]);

  // a) «Porque te gustó X»: grafo título→título de TMDB (lo que ven quienes vieron X).
  for (const anchor of taste.anchors.slice(0, 5)) {
    const [t, id] = anchor.split(":");
    jobs.push(
      list(`/${t}/${id}/recommendations`, {}, 86400).then((r) =>
        push(
          r.filter((x) => (x.vote_count ?? 0) >= TUNING.becauseMinVotes[x.media_type === "movie" || x.media_type === "tv" ? (x.media_type as MediaType) : (t as MediaType)]),
          t as MediaType,
          "because",
          anchor,
        ),
      ),
    );
  }

  for (const type of types) {
    const without = avoid.flatMap((g) => g[type] as readonly number[]).join(",") || null;
    const dateField = type === "movie" ? "primary_release_date" : "first_air_date";
    const base = {
      watch_region: REGION,
      with_watch_monetization_types: STREAMING,
      with_watch_providers: providerParam,
      without_genres: without,
      include_adult: "false",
      "vote_count.gte": type === "movie" ? 120 : 40,
    };
    const genres = genreIdsFor(type, taste.w);

    // b) Descubrimiento por géneros favoritos (OR), dos páginas.
    for (const page of [1, 2]) {
      jobs.push(
        list(`/discover/${type}`, { ...base, with_genres: genres.join("|") || null, sort_by: "popularity.desc", page }).then((r) =>
          push(r, type, "discover"),
        ),
      );
    }
    // c) Temas favoritos (palabras clave aprendidas).
    const keywords = topFeatures(taste.w, "k", 4);
    if (keywords.length) {
      jobs.push(
        list(`/discover/${type}`, { ...base, with_keywords: keywords.join("|"), sort_by: "vote_count.desc" }).then((r) =>
          push(r, type, "keyword"),
        ),
      );
    }
    // d) Joyas ocultas: muy bien valoradas y poco conocidas, en sus géneros. Solo con más de 9 meses:
    //    los estrenos recientes tienen notas infladas por pocos votos de fans.
    const matured = new Date(Date.now() - 270 * 86400000).toISOString().slice(0, 10);
    jobs.push(
      list(`/discover/${type}`, {
        ...base,
        [`${dateField}.lte`]: matured,
        with_genres: genres.slice(0, 2).join("|") || null,
        sort_by: "vote_average.desc",
        "vote_count.gte": type === "movie" ? 150 : 60,
        "vote_count.lte": type === "movie" ? 2500 : 700,
        "vote_average.gte": 7.2,
        with_original_language: gemsLangs.length ? gemsLangs.join("|") : null,
      }).then((r) => push(r, type, "gems")),
    );
    // h) Pareja: cruces «favorito de uno Y favorito del otro» (with_genres con coma = Y en TMDB). La media de
    //    los dos vectores recupera sobre todo lo que le gusta a uno solo; el cruce busca lo que gusta a los dos.
    const act = activeMembers(members);
    if (TUNING.sharedRetrieval && act.length >= 2) {
      const [ga, gb] = act.slice(0, 2).map((m) => genreIdsFor(type, m.w).slice(0, 2));
      const pairs = new Set(ga.flatMap((a) => gb.map((b) => (a === b ? a : [a, b].sort().join(",")))));
      for (const g of pairs) {
        jobs.push(list(`/discover/${type}`, { ...base, with_genres: g, sort_by: "vote_count.desc" }).then((r) => push(r, type, "shared")));
      }
    }
    // e) Tendencias de la semana.
    jobs.push(list(`/trending/${type}/week`, {}, 3 * 3600).then((r) => push(r, type, "trending")));
    // f) Novedades recientes en streaming dentro de sus géneros.
    const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    jobs.push(
      list(`/discover/${type}`, { ...base, with_genres: genres.join("|") || null, [`${dateField}.gte`]: since, sort_by: "popularity.desc" }).then(
        (r) => push(r, type, "discover"),
      ),
    );
  }

  // g) Personas favoritas (dirección/creación y reparto).
  const people = [...topFeatures(taste.w, "c", 2, 0.15), ...topFeatures(taste.w, "p", 1, 0.25)];
  for (const pid of people) {
    jobs.push(
      tmdb<{ cast?: any[]; crew?: any[] }>(`/person/${pid}/combined_credits`, { language: LANG }, 86400)
        .then((r) => {
          const all = [...(r.crew ?? []).filter((c) => c.job === "Director" || c.job === "Creator"), ...(r.cast ?? [])];
          // Fuera talk shows (10767), noticias (10763) y apariciones sueltas en series.
          const real = (x: any) =>
            !(x.genre_ids ?? []).some((g: number) => g === 10767 || g === 10763) && (x.media_type !== "tv" || (x.episode_count ?? 0) >= 3);
          const best = all.filter((x) => (x.vote_count ?? 0) > 80 && real(x)).sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
          push(best.slice(0, 20), "movie", "people", pid);
        })
        .catch(() => {}),
    );
  }

  await Promise.all(jobs);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Fase 2: ranking ----------

function dedupe(cands: Candidate[]): Map<string, Candidate & { sources: Set<Source> }> {
  const m = new Map<string, Candidate & { sources: Set<Source> }>();
  // Prioridad de la fuente que se queda como principal (para la explicación).
  const order: Source[] = ["because", "people", "shared", "keyword", "gems", "discover", "trending"];
  for (const c of cands) {
    const prev = m.get(c.key);
    if (!prev) m.set(c.key, { ...c, sources: new Set([c.source]) });
    else {
      prev.sources.add(c.source);
      if (order.indexOf(c.source) < order.indexOf(prev.source)) Object.assign(prev, { source: c.source, via: c.via });
    }
  }
  return m;
}

function avoidedGenres(prefs: Prefs | null): Record<MediaType, Set<number>> {
  const groups = GENRE_GROUPS.filter((g) => prefs?.avoid.includes(g.id));
  // Por tipo: el «Misterio» de series (9648) no debe vetar las películas de misterio si se evita «Suspense».
  return {
    movie: new Set(groups.flatMap((g) => g.movie as readonly number[])),
    tv: new Set(groups.flatMap((g) => g.tv as readonly number[])),
  };
}

/**
 * Afinidad de grupo para la pareja, por título (estrategia «media sin miseria» de los recomendadores
 * de grupo, Masthoff 2011): la media de los dos, pero penalizando que a uno no le guste nada.
 */
function groupAffinity(members: TasteModel[], own: TasteModel, f: Vec): number {
  const { avg: wa, min: wm, own: wo } = TUNING.group;
  const affs = activeMembers(members).map((m) => affinity(m, f));
  if (!affs.length) return affinity(own, f);
  const avg = affs.reduce((a, b) => a + b, 0) / affs.length;
  return (wa * avg + wm * Math.min(...affs) + wo * affinity(own, f)) / (wa + wm + wo);
}

/**
 * Miembros que ya han dado señales. Un miembro sin datos tiene afinidad 0 con todo: si entrara en el
 * «mínimo de los dos» hundiría cualquier título, así que hasta que valore algo se le ignora (arranque en frío).
 */
export function activeMembers(members: TasteModel[]): TasteModel[] {
  return members.filter((m) => m.signals >= 3);
}

/**
 * Géneros objetivo para calibrar la lista de la pareja. La unión de los dos repartos premia una lista con
 * «lo de él» y «lo de ella» por separado; «shared» se queda con lo que comparten (mínimo por género).
 */
function groupGenreTarget(own: TasteModel, members: TasteModel[]): Record<string, number> | undefined {
  const mode = TUNING.groupCalibration;
  const act = activeMembers(members).filter((m) => m.genreDist && Object.keys(m.genreDist).length);
  if (mode === "none") return undefined;
  if (mode === "union" || act.length < 2) return own.genreDist;
  const out: Record<string, number> = {};
  for (const g of Object.keys(act[0].genreDist!)) {
    const x = Math.min(...act.map((m) => m.genreDist![g] ?? 0));
    if (x > 0) out[g] = x;
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  for (const g of Object.keys(out)) out[g] /= total || 1;
  return out;
}

async function rank(cands: Candidate[], taste: TasteModel, prefs: Prefs | null, platforms: number[], members: TasteModel[] = []): Promise<Ranked[]> {
  const group = members.length >= 2;
  const aff_ = (f: Vec) => (group ? groupAffinity(members, taste, f) : affinity(taste, f));
  const blocked = new Set(taste.blocked);
  const avoid = avoidedGenres(prefs);
  const avoidRomance = !!prefs?.avoid.includes("romance");
  const w = taste.w;
  const coldStart = taste.signals < 3;

  const unique = [...dedupe(cands).values()].filter(
    (c) => !blocked.has(c.key) && !(c.raw.genre_ids ?? []).some((g: number) => avoid[c.type].has(g)),
  );

  // Criba barata con rasgos ligeros.
  const stage1 = unique
    .map((c) => {
      const q = bayesQuality(c.raw.vote_average, c.raw.vote_count, releaseDate(c.raw));
      const aff = aff_(c.shallow);
      const s =
        (coldStart ? 0.35 : TUNING.wAffinity) * aff +
        (coldStart ? 0.45 : TUNING.wQuality) * q +
        TUNING.sourcePrior[c.source] +
        (c.sources.size - 1) * TUNING.multiSourceBonus;
      return { c, s };
    })
    .sort((a, b) => b.s - a.s)
    // Con plataformas se descarta mucho después (disponibilidad), así que se deja pasar el doble.
    .slice(0, platforms.length ? TUNING.stage1Keep * 2 : TUNING.stage1Keep)
    .map((x) => x.c);

  // Rasgos completos (temas, personas…) y disponibilidad en España para los supervivientes.
  const feats = await getManyFeatures(stage1.map((c) => c.key));
  const provs = await Promise.all(stage1.map((c) => getProviders(c.type, c.raw.id).catch(() => null)));

  const ranked: Ranked[] = [];
  stage1.forEach((c, i) => {
    const p = provs[i];
    if (!p || !p.providers.length) return; // sin streaming en España
    if (platforms.length && !p.providers.some((x) => platforms.includes(x.id))) return;
    const feat = feats.get(c.key) ?? null;
    const aff = aff_(feat?.f ?? c.shallow);
    // La pareja no aplica el umbral: su vector mezcla dos gustos y descartaría casi todo.
    if (!coldStart && !group && aff < TUNING.minAffinity) return;
    const q = bayesQuality(c.raw.vote_average, c.raw.vote_count, releaseDate(c.raw));
    // Las series no tienen género «Romance»: si se evita, se mira en sus temas.
    const romance = avoidRomance && c.type === "tv" && feat ? romanceHints(feat) : 0;
    const score =
      -romance * TUNING.romanceKwPenalty +
      (coldStart ? 0.35 : TUNING.wAffinity) * aff +
      (coldStart ? 0.45 : TUNING.wQuality) * q +
      TUNING.wPopFit * popFit(c.raw.popularity, prefs) +
      TUNING.sourcePrior[c.source] +
      (c.sources.size - 1) * TUNING.multiSourceBonus +
      Math.random() * TUNING.jitter;
    ranked.push({
      ...c,
      title: toTitle(c.raw, c.type),
      feat,
      affinity: aff,
      quality: q,
      score,
      providers: p.providers,
    });
  });
  return ranked.sort((a, b) => b.score - a.score);
}

/** KL(p || q̃) entre la distribución de géneros objetivo y la de la lista (q suavizada con p, α = 0,01). */
function calibrationKL(target: Record<string, number>, counts: Record<string, number>, total: number): number {
  let kl = 0;
  for (const [g, p] of Object.entries(target)) {
    if (p <= 0) continue;
    const q = total ? (counts[g] ?? 0) / total : 0;
    kl += p * Math.log(p / (0.99 * q + 0.01 * p));
  }
  return kl;
}

/**
 * Maximal Marginal Relevance (Carbonell y Goldstein, 1998): buena puntuación sin repetir lo mismo diez veces
 * seguidas. Con `calibrate`, además acerca el reparto de géneros de la lista al de los gustos del perfil
 * (Steck, «Calibrated Recommendations», RecSys 2018).
 */
export function mmr<T extends { score: number; feat: ItemFeatures | null; shallow: Vec; raw?: { genre_ids?: number[] } }>(
  items: T[],
  k: number,
  lambda = TUNING.mmrLambda,
  calibrate?: Record<string, number>,
): T[] {
  const pool = [...items];
  const picked: T[] = [];
  const vec = (x: T) => x.feat?.f ?? x.shallow;
  const genresOf = (x: T): number[] => x.feat?.genreIds ?? x.raw?.genre_ids ?? [];
  const useCal = !!calibrate && Object.keys(calibrate).length >= 2;
  const counts: Record<string, number> = {};
  let total = 0;
  while (picked.length < k && pool.length) {
    let bestI = 0;
    let best = -Infinity;
    pool.forEach((it, i) => {
      const sim = picked.length ? Math.max(...picked.map((p) => dot(vec(p), vec(it)))) : 0;
      let cal = 0;
      if (useCal) {
        const gs = genresOf(it);
        const c2 = { ...counts };
        for (const g of gs) c2[g] = (c2[g] ?? 0) + 1 / gs.length;
        cal = calibrationKL(calibrate!, c2, total + (gs.length ? 1 : 0));
      }
      const v = lambda * it.score - (1 - lambda) * sim - TUNING.calibration * cal;
      if (v > best) {
        best = v;
        bestI = i;
      }
    });
    const chosen = pool.splice(bestI, 1)[0];
    picked.push(chosen);
    const gs = genresOf(chosen);
    for (const g of gs) counts[g] = (counts[g] ?? 0) + 1 / gs.length;
    if (gs.length) total++;
  }
  return picked;
}

/**
 * Recomendación «pura»: dado un modelo de gustos, devuelve el ranking completo (ya filtrado y diversificable).
 * No lee ni escribe perfiles; la usan getShelves y la evaluación offline (scripts/eval-reco.ts).
 */
export async function recommend(taste: TasteModel, prefs: Prefs | null, platforms: number[], types: MediaType[], members: TasteModel[] = []) {
  const cands = await gatherCandidates(types, taste, prefs, platforms, members);
  return rank(cands, taste, prefs, platforms, members);
}

export type { Ranked, Source };

// ---------- Explicaciones ----------

const LANG_NAMES: Record<string, string> = { es: "español", ko: "coreano", ja: "japonés", fr: "francés", it: "italiano", de: "alemán", da: "danés", sv: "sueco", no: "noruego", en: "inglés" };

function becauseText(anchor: string, taste: TasteModel, plural: boolean, title: string, ownerOverride?: string) {
  const owner = ownerOverride ?? taste.anchorOwner?.[anchor];
  const name = owner ? PROFILES.find((p) => p.id === owner)?.name : null;
  return name ? `Porque a ${name} le gustó «${title}»` : `Porque ${plural ? "os" : "te"} gustó «${title}»`;
}

function explain(
  r: Ranked,
  taste: TasteModel,
  plural: boolean,
  anchorTitles: Map<string, string>,
  personNames: Map<string, string>,
  liked: Map<string, ItemFeatures> = new Map(),
  likedOwner: Map<string, string> = new Map(),
): string {
  const te = plural ? "os" : "te";
  if (r.source === "because" && r.via && anchorTitles.get(r.via)) return becauseText(r.via, taste, plural, anchorTitles.get(r.via)!);
  if (r.source === "people" && r.via && personNames.get(r.via)) return `Más de ${personNames.get(r.via)}`;
  if (r.source === "gems" && r.quality > 0.6 && (r.raw.vote_count ?? 0) >= 150) return `Joya poco conocida · ★ ${r.title.rating?.toFixed(1)}`;

  // Explicación por ítems: el título que le gustó más parecido a este. Se entiende mejor que un rasgo suelto
  // («Porque te gusta: Drama» salía en media lista; Herlocker, Konstan y Riedl, «Explaining Collaborative
  // Filtering Recommendations», 2000).
  const seenBy = likedOwner.get(r.key);
  if (seenBy) return `${PROFILES.find((p) => p.id === seenBy)?.name ?? "Uno de los dos"} ya la vio y le gustó`;
  if (r.feat && r.source !== "trending") {
    let best: ItemFeatures | null = null;
    let bestSim = TUNING.itemExplainMin;
    for (const f of liked.values()) {
      if (f.key === r.key) continue;
      const sim = cosine(f.f, r.feat.f);
      if (sim > bestSim) {
        bestSim = sim;
        best = f;
      }
    }
    if (best) return becauseText(best.key, taste, plural, best.title, likedOwner.get(best.key));
  }

  // Rasgo que más aporta a la afinidad.
  const f = r.feat?.f ?? r.shallow;
  let bestK = "";
  let bestV = 0;
  for (const [k, x] of Object.entries(f)) {
    const v = x * (taste.w[k] ?? 0);
    if (v > bestV && !k.startsWith("t:")) {
      bestV = v;
      bestK = k;
    }
  }
  const label = r.feat?.labels[bestK];
  if (r.source === "trending") return label ? `Tendencia esta semana · ${label}` : "Tendencia esta semana en España";
  if (bestK.startsWith("c:") && label) return `De ${label}`;
  if (bestK.startsWith("p:") && label) return `Con ${label}`;
  if (bestK.startsWith("k:") && label) return `Porque ${te} interesa: ${label}`;
  if (bestK.startsWith("g:") && label) return `Porque ${te} gusta: ${label}`;
  if (bestK.startsWith("l:")) return `Cine en ${LANG_NAMES[bestK.slice(2)] ?? bestK.slice(2)}`;
  if (bestK.startsWith("d:")) return `De los ${bestK.slice(2)}`;
  return r.quality > 0.7 ? "Muy bien valorada" : "Encaja con vuestros gustos";
}

function toItem(r: Ranked, reason: string): RecoItem {
  return { ...r.title, providers: r.providers, score: Math.round(r.score * 1000) / 1000, reason };
}

// ---------- Estanterías ----------

const SHELVES_TTL = 15 * 60;

export async function getShelves(profileId: string, type: MediaType | "all"): Promise<Shelf[]> {
  const profile = await getProfile(profileId);
  const taste = await getTaste(profileId);
  const types: MediaType[] = type === "all" ? (profile.prefs?.types ?? ["movie", "tv"]) : [type];
  // La clave depende del contenido del modelo (no de cuándo se calculó): reentrenar sin cambios no invalida.
  const cacheKey = `shelves:v5:${profileId}:${types.join("+")}:${hashOf([taste.w, taste.blocked, taste.anchors, profile.platforms])}`;
  const cached = await kvGet<Shelf[]>(cacheKey).catch(() => null);
  if (cached) return cached;

  const plural = profileId === "pareja";
  const memberTastes = await Promise.all(coupleMembers(profileId).map((m) => getTaste(m)));
  const ranked0 = await recommend(taste, profile.prefs, profile.platforms, types, memberTastes);

  const anchorFeats = await getManyFeatures(taste.anchors);
  const anchorTitles = new Map([...anchorFeats].map(([k, f]) => [k, f.title]));
  // Lo que de verdad le gustó (no lo que solo quiere ver), para las explicaciones por ítems.
  const likedOwner = new Map<string, string>();
  const positives = (p: typeof profile) =>
    Object.entries(p.feedback)
      .filter(([, fb]) => fb.s === "love" || fb.s === "like")
      .map(([k]) => k);
  const memberIds = coupleMembers(profileId);
  const memberProfiles = await Promise.all(memberIds.map((m) => getProfile(m)));
  const own = new Set(positives(profile));
  memberProfiles.forEach((p, i) => positives(p).forEach((k) => !own.has(k) && !likedOwner.has(k) && likedOwner.set(k, memberIds[i])));
  const liked = await getManyFeatures([...own, ...likedOwner.keys()]);

  // Pareja: con un solo miembro activo, «lo mejor para vosotros» se llenaba de lo que Víctor ya había visto
  // (13 de 20 en su perfil real). Se penaliza en vez de bloquear.
  const memberSeen = new Set(memberProfiles.flatMap((p) => [...p.seen, ...Object.keys(p.feedback)]));
  const seenPenalty = (r: Ranked) => (memberSeen.has(r.key) ? TUNING.groupSeenPenalty : 0);
  const ranked = memberSeen.size
    ? ranked0.map((r) => ({ ...r, score: r.score - seenPenalty(r) })).sort((a, b) => b.score - a.score)
    : ranked0;
  const personNames = new Map<string, string>();
  for (const r of ranked) for (const [k, v] of Object.entries(r.feat?.labels ?? {})) if (k.startsWith("c:") || k.startsWith("p:")) personNames.set(k.slice(2), v);

  const reason = (r: Ranked) => explain(r, taste, plural, anchorTitles, personNames, liked, likedOwner);
  const shelves: Shelf[] = [];
  const used = new Set<string>();
  const take = (items: Ranked[], n: number, exclude = true) => {
    const out = items.filter((r) => !exclude || !used.has(r.key)).slice(0, n);
    return out;
  };

  // «Para ver juntos»: lo que maximiza el mínimo de afinidad entre los dos miembros.
  const mt = activeMembers(memberTastes);
  if (mt.length >= 2) {
    const together = ranked
      .map((r) => {
        const f = r.feat?.f ?? r.shallow;
        const minAff = Math.min(...mt.map((m) => affinity(m, f)));
        return { r, s: 0.7 * minAff + 0.3 * r.quality - seenPenalty(r) };
      })
      .filter((x) => x.s > 0.1)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
    const items = mmr(take(together, 40), 15);
    if (items.length >= 4) {
      shelves.push({ id: "together", title: "Para ver juntos", items: items.map((r) => toItem(r, "Os puede gustar a los dos")) });
      items.slice(0, 6).forEach((r) => used.add(r.key));
    }
  }

  const calTarget = memberTastes.length >= 2 ? groupGenreTarget(taste, memberTastes) : taste.genreDist;
  const top = mmr(take(ranked, 60), 20, TUNING.mmrLambda, calTarget);
  shelves.push({ id: "top", title: plural ? "Lo mejor para vosotros" : "Lo mejor para ti", items: top.map((r) => toItem(r, reason(r))) });
  top.slice(0, 8).forEach((r) => used.add(r.key));
  // Descubrimientos y tendencias no repiten nada de la lista principal (antes compartían 3-4 títulos).
  const inTop = new Set(top.map((r) => r.key));

  for (const anchor of taste.anchors.slice(0, 2)) {
    const items = take(ranked.filter((r) => r.source === "because" && r.via === anchor), 15);
    if (items.length >= 4 && anchorTitles.get(anchor)) {
      shelves.push({ id: "because", title: becauseText(anchor, taste, plural, anchorTitles.get(anchor)!), items: items.map((r) => toItem(r, reason(r))) });
      items.slice(0, 4).forEach((r) => used.add(r.key));
    }
  }

  const discoveries = mmr(
    take(
      ranked.filter((r) => (r.source === "gems" || r.source === "keyword") && r.affinity > 0.05 && !inTop.has(r.key)),
      40,
    ),
    15,
  );
  if (discoveries.length >= 4) {
    shelves.push({ id: "discover", title: "Descubrimientos", items: discoveries.map((r) => toItem(r, reason(r))) });
    discoveries.slice(0, 4).forEach((r) => used.add(r.key));
  }

  const peopleItems = ranked.filter((r) => r.source === "people");
  const byPerson = new Map<string, Ranked[]>();
  for (const r of peopleItems) byPerson.set(r.via!, [...(byPerson.get(r.via!) ?? []), r]);
  for (const [pid, items] of byPerson) {
    const name = personNames.get(pid);
    const list = take(items, 15);
    if (name && list.length >= 4) {
      shelves.push({ id: "people", title: `Más de ${name}`, items: list.map((r) => toItem(r, reason(r))) });
      break;
    }
  }

  const trend = take(
    ranked.filter((r) => r.sources.has("trending") && r.affinity > 0.15 && !inTop.has(r.key)),
    15,
  );
  if (trend.length >= 4) shelves.push({ id: "trending", title: "Tendencias en España para ti", items: trend.map((r) => toItem(r, "Tendencia esta semana")) });

  await kvSet(cacheKey, shelves, SHELVES_TTL).catch(() => {});
  return shelves;
}

// ---------- Semillas para el onboarding ----------

/** ~12 títulos por tipo, muy conocidos y de géneros distintos, disponibles en streaming en España. */
export async function getSeeds(types: MediaType[]): Promise<Title[]> {
  const key = `seeds:v1:${types.join("+")}`;
  const cached = await kvGet<Title[]>(key).catch(() => null);
  if (cached?.length) return cached;
  const out: Title[] = [];
  const seen = new Set<string>();
  const perType = types.length > 1 ? 12 : 24;
  for (const type of types) {
    const groups = GENRE_GROUPS.filter((g) => (g[type] as readonly number[]).length);
    const lists = await Promise.all(
      groups.map((g) =>
        list(`/discover/${type}`, {
          with_genres: (g[type] as readonly number[])[0],
          watch_region: REGION,
          with_watch_monetization_types: STREAMING,
          sort_by: "vote_count.desc",
          "vote_average.gte": 6.5,
          "primary_release_date.gte": type === "movie" ? "1995-01-01" : null,
          "first_air_date.gte": type === "tv" ? "2000-01-01" : null,
        }, 86400),
      ),
    );
    const picks: Title[] = [];
    // Ronda a ronda, uno de cada género, hasta llenar el cupo.
    for (let round = 0; round < 6 && picks.length < perType; round++) {
      for (const l of lists) {
        const r = l[round];
        if (!r || picks.length >= perType) continue;
        const k = `${type}:${r.id}`;
        if (seen.has(k) || !r.poster_path) continue;
        seen.add(k);
        picks.push(toTitle(r, type));
      }
    }
    out.push(...picks);
  }
  if (out.length) await kvSet(key, out, 86400).catch(() => {});
  return out;
}
