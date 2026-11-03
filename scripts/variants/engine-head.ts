// COPIA de src/lib/reco/engine.ts en el commit 41121eb (antes de las mejoras de pareja/estrenos/explicaciones). Solo para comparar en la evaluación (--engine head).

import { PROFILES } from "@/config/profiles";
import { hashOf } from "@/lib/client";
import { GENRE_GROUPS, type Prefs } from "@/lib/prefs";
import { getProfile, kvGet, kvSet } from "@/lib/store";
import { getProviders, tmdb, toTitle } from "@/lib/tmdb";
import type { MediaType, Title } from "@/lib/types";
import { getManyFeatures, normalize, shallowFeatures } from "@/lib/reco/features";
import { affinity, coupleMembers, dot, getTaste, type Vec } from "@/lib/reco/model";
import type { ItemFeatures, RecoItem, Shelf, TasteModel } from "@/lib/reco/types";

// Recomendador en dos fases, como los de e-commerce:
//   1. Recuperación: cientos de candidatos de varias fuentes («vinculaciones» y descubrimientos).
//   2. Ranking: criba barata con rasgos ligeros → rasgos completos (con caché) para los mejores →
//      puntuación final (afinidad + calidad + fuente + novedad) → diversificación MMR → explicación.

type Source = "because" | "discover" | "keyword" | "trending" | "gems" | "people";

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
  sourcePrior: { because: 0.12, people: 0.08, keyword: 0.06, discover: 0.04, trending: 0.05, gems: 0.03 } as Record<Source, number>,
  /** Penalización (o premio) por que el mismo título venga de varias fuentes. */
  multiSourceBonus: 0.04,
  mmrLambda: 0.6, // evaluación offline: mejora diversidad y precisión en todas las personas
  /** Peso de la calibración de géneros en la lista principal (0 = desactivada). */
  calibration: 0.06,
  jitter: 0.02,
  minAffinity: -0.05,
  bayesM: 200,
  bayesC: 6.6,
};

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function bayesQuality(rating: number | null | undefined, votes: number | null | undefined): number {
  const v = votes ?? 0;
  const r = rating ?? TUNING.bayesC;
  const b = (v / (v + TUNING.bayesM)) * r + (TUNING.bayesM / (v + TUNING.bayesM)) * TUNING.bayesC;
  return clamp((b - 5.5) / 3);
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

async function gatherCandidates(types: MediaType[], taste: TasteModel, prefs: Prefs | null, platforms: number[]): Promise<Candidate[]> {
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

  // a) «Porque te gustó X»: grafo título→título de TMDB (lo que ven quienes vieron X).
  for (const anchor of taste.anchors.slice(0, 5)) {
    const [t, id] = anchor.split(":");
    jobs.push(list(`/${t}/${id}/recommendations`, {}, 86400).then((r) => push(r, t as MediaType, "because", anchor)));
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
      }).then((r) => push(r, type, "gems")),
    );
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
  const order: Source[] = ["because", "people", "keyword", "gems", "discover", "trending"];
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
  const affs = members.map((m) => affinity(m, f));
  const avg = affs.reduce((a, b) => a + b, 0) / affs.length;
  return (0.35 * avg + 0.35 * Math.min(...affs) + 0.1 * affinity(own, f)) / 0.8;
}

async function rank(cands: Candidate[], taste: TasteModel, prefs: Prefs | null, platforms: number[], members: TasteModel[] = []): Promise<Ranked[]> {
  const group = members.length >= 2;
  const aff_ = (f: Vec) => (group ? groupAffinity(members, taste, f) : affinity(taste, f));
  const blocked = new Set(taste.blocked);
  const avoid = avoidedGenres(prefs);
  const w = taste.w;
  const coldStart = taste.signals < 3;

  const unique = [...dedupe(cands).values()].filter(
    (c) => !blocked.has(c.key) && !(c.raw.genre_ids ?? []).some((g: number) => avoid[c.type].has(g)),
  );

  // Criba barata con rasgos ligeros.
  const stage1 = unique
    .map((c) => {
      const q = bayesQuality(c.raw.vote_average, c.raw.vote_count);
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
    const q = bayesQuality(c.raw.vote_average, c.raw.vote_count);
    const score =
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
  const cands = await gatherCandidates(types, taste, prefs, platforms);
  return rank(cands, taste, prefs, platforms, members);
}

export type { Ranked, Source };

// ---------- Explicaciones ----------

const LANG_NAMES: Record<string, string> = { es: "español", ko: "coreano", ja: "japonés", fr: "francés", it: "italiano", de: "alemán", da: "danés", sv: "sueco", no: "noruego", en: "inglés" };

function becauseText(anchor: string, taste: TasteModel, plural: boolean, title: string) {
  const owner = taste.anchorOwner?.[anchor];
  const name = owner ? PROFILES.find((p) => p.id === owner)?.name : null;
  return name ? `Porque a ${name} le gustó «${title}»` : `Porque ${plural ? "os" : "te"} gustó «${title}»`;
}

function explain(r: Ranked, taste: TasteModel, plural: boolean, anchorTitles: Map<string, string>, personNames: Map<string, string>): string {
  const te = plural ? "os" : "te";
  if (r.source === "because" && r.via && anchorTitles.get(r.via)) return becauseText(r.via, taste, plural, anchorTitles.get(r.via)!);
  if (r.source === "people" && r.via && personNames.get(r.via)) return `Más de ${personNames.get(r.via)}`;
  if (r.source === "gems" && r.quality > 0.6 && (r.raw.vote_count ?? 0) >= 150) return `Joya poco conocida · ★ ${r.title.rating?.toFixed(1)}`;

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
  const cacheKey = `shelves:v2:${profileId}:${types.join("+")}:${hashOf([taste.w, taste.blocked, taste.anchors, profile.platforms])}`;
  const cached = await kvGet<Shelf[]>(cacheKey).catch(() => null);
  if (cached) return cached;

  const plural = profileId === "pareja";
  const memberTastes = await Promise.all(coupleMembers(profileId).map((m) => getTaste(m)));
  const ranked = await recommend(taste, profile.prefs, profile.platforms, types, memberTastes);

  const anchorFeats = await getManyFeatures(taste.anchors);
  const anchorTitles = new Map([...anchorFeats].map(([k, f]) => [k, f.title]));
  const personNames = new Map<string, string>();
  for (const r of ranked) for (const [k, v] of Object.entries(r.feat?.labels ?? {})) if (k.startsWith("c:") || k.startsWith("p:")) personNames.set(k.slice(2), v);

  const reason = (r: Ranked) => explain(r, taste, plural, anchorTitles, personNames);
  const shelves: Shelf[] = [];
  const used = new Set<string>();
  const take = (items: Ranked[], n: number, exclude = true) => {
    const out = items.filter((r) => !exclude || !used.has(r.key)).slice(0, n);
    return out;
  };

  // «Para ver juntos»: lo que maximiza el mínimo de afinidad entre los dos miembros.
  const members = coupleMembers(profileId);
  if (members.length >= 2) {
    const mt = await Promise.all(members.map((m) => getTaste(m)));
    const together = ranked
      .map((r) => {
        const f = r.feat?.f ?? r.shallow;
        const minAff = Math.min(...mt.map((m) => affinity(m, f)));
        return { r, s: 0.7 * minAff + 0.3 * r.quality };
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

  const top = mmr(take(ranked, 60), 20, TUNING.mmrLambda, taste.genreDist);
  shelves.push({ id: "top", title: plural ? "Lo mejor para vosotros" : "Lo mejor para ti", items: top.map((r) => toItem(r, reason(r))) });
  top.slice(0, 8).forEach((r) => used.add(r.key));

  for (const anchor of taste.anchors.slice(0, 2)) {
    const items = take(ranked.filter((r) => r.source === "because" && r.via === anchor), 15);
    if (items.length >= 4 && anchorTitles.get(anchor)) {
      shelves.push({ id: "because", title: becauseText(anchor, taste, plural, anchorTitles.get(anchor)!), items: items.map((r) => toItem(r, reason(r))) });
      items.slice(0, 4).forEach((r) => used.add(r.key));
    }
  }

  const discoveries = mmr(
    take(
      ranked.filter((r) => (r.source === "gems" || r.source === "keyword") && r.affinity > 0.05),
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
    ranked.filter((r) => r.sources.has("trending") && r.affinity > 0.15),
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
