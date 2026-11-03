import "server-only";
import { yearRange } from "../filters";
import { GENRE_GROUPS, type Prefs } from "../prefs";
import { getProfile, kvGet, kvSet } from "../store";
import { discover, getDetail, tmdb, toTitle, type DiscoverSort } from "../tmdb";
import { titleKey, type Filters, type Title, type TitleDetail } from "../types";
import { bayesQuality } from "./engine";
import { getManyFeatures, normalize, shallowFeatures } from "./features";
import { affinity, getTaste } from "./model";
import type { ImplicitEvent, Signal, TasteModel } from "./types";

// «Sorpréndeme» infinito.
//
// Antes elegía casi siempre entre los mismos 15 títulos de la página 1. Ahora:
//  - Varias FUENTES («brazos»): tus gustos, «porque te gustó X», joyas, novedades, tendencias y
//    «salir de la rutina» (lo conocido fuera de tus géneros), cada una con páginas profundas al azar
//    y distintos órdenes (popularidad, nota, nº de votos, fecha).
//  - Un BANDIDO con muestreo de Thompson (Chapelle y Li, «An Empirical Evaluation of Thompson Sampling»,
//    2011) elige la fuente de cada propuesta y aprende de tus reacciones cuál te funciona: equilibra
//    explotar lo que acierta y explorar lo nuevo.
//  - MEMORIA persistente de lo ya propuesto (3 semanas), en cualquier dispositivo.
//  - TEMPERATURA adaptativa: si saltas muchas seguidas, se arriesga más.

export type Arm = "taste" | "related" | "explore" | "gems" | "fresh" | "trending";
const ARMS: Arm[] = ["taste", "related", "explore", "gems", "fresh", "trending"];

/** Creencia inicial (α, β) de cada fuente: más confianza en «tus gustos», menos en salir de la rutina. */
const PRIOR: Record<Arm, [number, number]> = {
  taste: [3, 1],
  related: [2.5, 1],
  gems: [1.6, 1],
  fresh: [1.4, 1],
  trending: [1.3, 1],
  explore: [1, 1.4],
};
/** Recompensa de cada reacción a una propuesta. */
const REWARD: Partial<Record<Signal | ImplicitEvent, number>> = {
  love: 1,
  like: 1,
  want: 1,
  seen: 0.7,
  open: 0.4,
  skip: 0,
  dislike: 0,
  not_interested: 0,
};
const BANDIT_DECAY = 0.97; // olvida poco a poco: los gustos y el humor cambian
const SHOWN_DAYS = 21;
const SHOWN_MAX = 2000;

type Bandit = Record<Arm, [number, number]>;

const banditKey = (p: string) => `bandit:${p}`;
const shownKey = (p: string) => `shown:${p}`;
const streakKey = (p: string) => `streak:${p}`;
const proposalKey = (p: string, k: string) => `sp:${p}:${k}`;

// ---------- Muestreo ----------

function gaussian() {
  let u = 0;
  while (!u) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** Muestra de una Gamma(k, 1) (Marsaglia y Tsang, 2000). */
function gamma(k: number): number {
  if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const beta = (a: number, b: number) => {
  const x = gamma(a);
  return x / (x + gamma(b));
};

function softmaxPick<T>(items: T[], score: (x: T) => number, temperature: number): T | null {
  if (!items.length) return null;
  const s = items.map(score);
  const max = Math.max(...s);
  const w = s.map((x) => Math.exp((x - max) / temperature));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= w[i]) <= 0) return items[i];
  return items[items.length - 1];
}

const randInt = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const pickOne = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

// ---------- Fuentes ----------

interface Cand {
  t: Title;
  arm: Arm;
  /** Ancla de la que viene (fuente «related»). */
  via?: string;
}

/** ¿Cumple los filtros del usuario? (para fuentes que no pasan por discover). */
function matches(t: Title, f: Filters, avoid: Set<number>): boolean {
  if (t.type !== f.type || !t.poster) return false;
  if (f.genre != null && !t.genreIds.includes(f.genre)) return false;
  if (f.minRating != null && (t.rating ?? 0) < f.minRating) return false;
  const [from, to] = yearRange(f.year);
  if (from != null && (t.year ?? 0) < from) return false;
  if (to != null && (t.year == null || t.year > to)) return false;
  return !t.genreIds.some((g) => avoid.has(g));
}

interface ArmCtx {
  platforms: number[];
  prefs: Prefs | null;
  avoid: Set<number>;
}

async function discoverArm(f: Filters, ctx: ArmCtx, sorts: DiscoverSort[], maxPages: number, taste: boolean): Promise<Title[]> {
  const sort = pickOne(sorts);
  const ff = { ...f, taste: taste && f.taste };
  const o = { platforms: ctx.platforms, prefs: ctx.prefs, sort };
  const first = await discover(ff, 1, o).catch(() => null);
  if (!first || !first.totalResults) return [];
  const pages = Math.min(first.totalPages, maxPages);
  // Dos páginas al azar (no la 1 casi nunca: es la que siempre salía).
  const picks = [...new Set([randInt(1, pages), randInt(Math.min(2, pages), pages)])];
  const lists = await Promise.all(picks.map((p) => (p === 1 ? first : discover(ff, p, o).catch(() => null))));
  return lists.flatMap((l) => l?.items ?? []);
}

async function loadArm(arm: Arm, f: Filters, taste: TasteModel, ctx: ArmCtx): Promise<Cand[]> {
  const o = ctx;
  const wrap = (ts: Title[], via?: string) => ts.map((t) => ({ t, arm, via }));
  switch (arm) {
    case "taste":
      return wrap(await discoverArm(f, o, ["popularity", "votes", "rating"], 40, true));
    case "explore":
      // Lo conocido y bien valorado, ignorando tus géneros: para salir de la burbuja.
      return wrap(await discoverArm(f, o, ["votes", "rating", "popularity"], 80, false));
    case "gems":
      return wrap(await discoverArm(f, o, ["gems"], 12, true));
    case "fresh":
      return wrap(await discoverArm(f, o, ["recent"], 6, true));
    case "related": {
      if (!taste.anchors.length) return [];
      const anchors = [...taste.anchors].sort(() => Math.random() - 0.5).slice(0, 2);
      const lists = await Promise.all(
        anchors.map(async (a) => {
          const [type, id] = a.split(":");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await tmdb<{ results: any[] }>(`/${type}/${id}/recommendations`, { language: "es-ES", page: randInt(1, 2) }, 86400).catch(() => ({ results: [] }));
          return r.results
            .filter((x) => !x.adult)
            .map((x) => toTitle(x, x.media_type === "tv" || x.media_type === "movie" ? x.media_type : (type as Title["type"])))
            .filter((t) => matches(t, f, ctx.avoid))
            .map((t) => ({ t, arm, via: a }));
        }),
      );
      return lists.flat();
    }
    case "trending": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await tmdb<{ results: any[] }>(`/trending/${f.type}/week`, { language: "es-ES", page: randInt(1, 3) }, 3 * 3600).catch(() => ({ results: [] }));
      return wrap(r.results.filter((x) => !x.adult).map((x) => toTitle(x, f.type)).filter((t) => matches(t, f, ctx.avoid)));
    }
  }
}

// ---------- Estado por perfil ----------

async function getBandit(profile: string): Promise<Bandit> {
  const b = (await kvGet<Bandit>(banditKey(profile)).catch(() => null)) ?? ({} as Bandit);
  return Object.fromEntries(ARMS.map((a) => [a, b[a] ?? PRIOR[a]])) as Bandit;
}

/**
 * Aprende de la reacción a una propuesta de Sorpréndeme: actualiza la fuente que la generó (bandido)
 * y la racha de saltos (temperatura). Se llama desde /api/feedback para cualquier señal.
 */
export async function learnFromReaction(profile: string, key: string, signal: Signal | ImplicitEvent | "clear") {
  const reward = REWARD[signal as Signal | ImplicitEvent];
  if (reward === undefined) return;
  const arm = await kvGet<Arm>(proposalKey(profile, key)).catch(() => null);
  if (arm && ARMS.includes(arm)) {
    const b = await getBandit(profile);
    const [a, c] = b[arm];
    // Olvido hacia la creencia inicial y actualización bayesiana con recompensa fraccionaria.
    b[arm] = [Math.max(PRIOR[arm][0] * 0.5, a * BANDIT_DECAY) + reward, Math.max(PRIOR[arm][1] * 0.5, c * BANDIT_DECAY) + (1 - reward)];
    await kvSet(banditKey(profile), b).catch(() => {});
  }
  if (arm || signal === "skip") {
    const streak = (await kvGet<number>(streakKey(profile)).catch(() => 0)) ?? 0;
    await kvSet(streakKey(profile), reward >= 0.4 ? 0 : Math.min(20, streak + 1)).catch(() => {});
  }
}

// ---------- Lote de propuestas ----------

export interface SurpriseItem extends TitleDetail {
  arm: Arm;
  reason: string;
}

function arReason(c: Cand, plural: boolean, anchorTitles: Map<string, string>): string {
  const te = plural ? "os" : "te";
  switch (c.arm) {
    case "related":
      return c.via && anchorTitles.get(c.via) ? `Porque ${te} gustó «${anchorTitles.get(c.via)}»` : `Parecida a lo que ${te} gusta`;
    case "gems":
      return "Joya poco conocida";
    case "fresh":
      return "Novedad en streaming";
    case "trending":
      return "Tendencia esta semana";
    case "explore":
      return "Para salir de la rutina";
    default:
      return plural ? "Encaja con vuestros gustos" : "Encaja con tus gustos";
  }
}

export async function surpriseBatch(profileId: string, f: Filters, n: number, clientSkip: string[]): Promise<{ items: SurpriseItem[]; reason?: "empty" }> {
  const [profile, taste, bandit, shown, streak] = await Promise.all([
    getProfile(profileId),
    getTaste(profileId),
    getBandit(profileId),
    kvGet<Record<string, number>>(shownKey(profileId)).catch(() => null),
    kvGet<number>(streakKey(profileId)).catch(() => 0),
  ]);
  const now = Date.now();
  const recentShown = Object.entries(shown ?? {})
    .filter(([, t]) => now - t < SHOWN_DAYS * 86400000)
    .map(([k]) => k);
  const hardExcluded = new Set([...profile.seen, ...taste.rejected, ...clientSkip]);
  let excluded = new Set([...hardExcluded, ...recentShown]);

  const avoid = new Set(
    f.taste ? GENRE_GROUPS.filter((g) => profile.prefs?.avoid.includes(g.id)).flatMap((g) => g[f.type] as readonly number[]) : [],
  );
  const ctx: ArmCtx = { platforms: f.onlyMine ? profile.platforms : [], prefs: profile.prefs, avoid };
  // Cuantos más saltos seguidos, más se arriesga (más temperatura = más variedad).
  const temperature = 0.12 + 0.05 * Math.min(streak ?? 0, 8);

  const pools = new Map<Arm, Promise<Cand[]>>();
  const pool = (arm: Arm) => {
    if (!pools.has(arm)) pools.set(arm, loadArm(arm, f, taste, ctx).catch(() => []));
    return pools.get(arm)!;
  };
  const dead = new Set<Arm>(taste.anchors.length ? [] : ["related"]);
  if (f.genre != null || f.year) dead.add("trending"); // con filtros concretos casi nunca aporta

  const scoreOf = (c: Cand) => {
    const raw = { genre_ids: c.t.genreIds, [c.t.type === "movie" ? "release_date" : "first_air_date"]: c.t.year ? `${c.t.year}-01-01` : undefined };
    const aff = affinity(taste, normalize(shallowFeatures(raw, c.t.type)));
    return (taste.signals < 3 ? 0.3 : 0.6) * aff + 0.3 * bayesQuality(c.t.rating, 400);
  };

  const picked: Cand[] = [];
  const out: SurpriseItem[] = [];
  for (let relaxed = 0; relaxed < 2 && out.length < n; relaxed++) {
    if (relaxed) excluded = hardExcluded; // si la memoria lo ha agotado todo, se permite repetir lo de hace días
    for (let attempt = 0; attempt < n * 4 && out.length + picked.length < n; attempt++) {
      const live = ARMS.filter((a) => !dead.has(a));
      if (!live.length) break;
      // Thompson: una muestra de cada Beta y gana la mayor.
      const arm = live.reduce((best, a) => {
        const s = beta(...bandit[a]);
        return s > best.s ? { a, s } : best;
      }, { a: live[0], s: -1 }).a;
      const cands = (await pool(arm)).filter((c) => !excluded.has(titleKey(c.t)) && !picked.some((p) => titleKey(p.t) === titleKey(c.t)));
      if (!cands.length) {
        dead.add(arm);
        continue;
      }
      const c = softmaxPick(cands, scoreOf, arm === "explore" ? temperature * 2 : temperature)!;
      picked.push(c);
      excluded.add(titleKey(c.t));
    }
    // Detalle (duración, plataformas) y validación de lo que discover no puede filtrar.
    const details = await Promise.all(picked.splice(0).map(async (c) => ({ c, d: await getDetail(c.t.type, c.t.id).catch(() => null) })));
    const anchorTitles = new Map([...(await getManyFeatures(details.filter((x) => x.c.via).map((x) => x.c.via!)))].map(([k, v]) => [k, v.title]));
    for (const { c, d } of details) {
      if (!d || out.length >= n) continue;
      if (!d.providers?.length) continue;
      if (f.onlyMine && profile.platforms.length && !d.providers.some((p) => profile.platforms.includes(p.id))) continue;
      if (f.maxRuntime && d.runtime && d.runtime > f.maxRuntime) continue;
      out.push({ ...d, arm: c.arm, reason: arReason(c, profileId === "pareja", anchorTitles) });
    }
  }

  // Memoria: lo propuesto no se repite en 3 semanas, y se apunta de qué fuente salió (para el bandido).
  if (out.length) {
    const next = { ...(shown ?? {}) };
    for (const it of out) next[titleKey(it)] = now;
    const trimmed = Object.fromEntries(Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, SHOWN_MAX));
    await Promise.all([
      kvSet(shownKey(profileId), trimmed).catch(() => {}),
      ...out.map((it) => kvSet(proposalKey(profileId, titleKey(it)), it.arm, 14 * 86400).catch(() => {})),
    ]);
  }
  return out.length ? { items: out } : { items: [], reason: "empty" };
}
