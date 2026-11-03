// Evaluación offline del recomendador con personas sintéticas.
//
//   QUEVEMOS_STORE_FILE=.data/eval-store.json npx tsx --conditions=react-server --env-file=.env.local \
//     scripts/eval-reco.mts [--rounds 4] [--variants current,baseline,...] [--quick]
//
// Usa su propio almacén (.data/eval-store.json) y una caché HTTP en disco de TMDB (.data/eval-http-cache.json)
// para no saturar la API y que las ejecuciones sean repetibles. Ver scripts/README-eval.md.
import { promises as fs, existsSync, readFileSync } from "fs";
import path from "path";
import { COUPLE, coupleUtility, DISLIKE, featureLiked, LIKE, LOVE, PERSONAS, utility, type ItemView, type Persona } from "./personas.mts";

if (!process.env.QUEVEMOS_STORE_FILE) {
  console.error("Falta QUEVEMOS_STORE_FILE (usa .data/eval-store.json para no pisar el store del servidor).");
  process.exit(1);
}
const STORE_FILE = path.resolve(process.env.QUEVEMOS_STORE_FILE);
const HTTP_CACHE = path.resolve(".data/eval-http-cache.json");
const RESULTS = path.resolve(".data/eval-results.json");

// ---------- Argumentos ----------
const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const ROUNDS = Number(arg("rounds", "4"));
const COUPLE_MODE = arg("couple", "current");
/** Para la pareja, «acierto» = los dos contentos: min(uA, uB) ≥ 0.5 (con gustos opuestos, ≥ 1 casi no existe en el catálogo). */
const COUPLE_LIKE = 0.5;
const QUICK = args.includes("--quick");

// ---------- Aleatoriedad reproducible ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.argv.includes("--seed") ? process.argv[process.argv.indexOf("--seed") + 1] : "7");
const hashStr = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, SEED);
let engineRand = mulberry32(1);
Math.random = () => engineRand(); // jitter del motor reproducible

// ---------- Caché HTTP de TMDB en disco ----------
const httpCache: Record<string, string> = existsSync(HTTP_CACHE) ? JSON.parse(readFileSync(HTTP_CACHE, "utf8")) : {};
let httpNew = 0;
let httpCalls = 0;
const realFetch = globalThis.fetch;
const cacheKeyOf = (url: string) => {
  const u = new URL(url);
  u.searchParams.delete("api_key");
  return u.toString();
};
async function saveHttpCache() {
  await fs.mkdir(path.dirname(HTTP_CACHE), { recursive: true });
  await fs.writeFile(HTTP_CACHE, JSON.stringify(httpCache));
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.includes("api.themoviedb.org")) return realFetch(input, init);
  const key = cacheKeyOf(url);
  if (httpCache[key] !== undefined) return new Response(httpCache[key], { status: 200, headers: { "content-type": "application/json" } });
  for (let attempt = 0; attempt < 5; attempt++) {
    httpCalls++;
    const { next: _n, ...rest } = (init ?? {}) as RequestInit & { next?: unknown };
    const res = await realFetch(input, rest);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) return res;
    const text = await res.text();
    httpCache[key] = text;
    if (++httpNew % 200 === 0) await saveHttpCache();
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 429 });
}) as typeof fetch;

// ---------- Motor (después de parchear fetch) ----------
const ENGINE = "src";
// Para comparar con una versión anterior del motor: `git stash` o `git worktree` y ejecutar ahí la misma evaluación.
const engine = await import("../src/lib/reco/engine");
const model = await import("../src/lib/reco/model");
const features = await import("../src/lib/reco/features");
const store = await import("../src/lib/store");
// Registro de perfiles de la simulación: dos individuales y su pareja enlazada (los perfiles ya no son fijos).
await store.kvSet("profiles:index", [
  { id: "victor", name: "Víctor", kind: "single", members: [], emoji: "🎬", color: "#4f8cff", pin: null, createdAt: 0 },
  { id: "alba", name: "Alba", kind: "single", members: [], emoji: "🦊", color: "#ffb547", pin: null, createdAt: 0 },
  { id: "pareja", name: "Víctor y Alba", kind: "couple", members: ["victor", "alba"], emoji: "💑", color: "#ff5c8a", pin: null, createdAt: 0 },
]);
type ItemFeatures = import("../src/lib/reco/types").ItemFeatures;
type Signal = import("../src/lib/reco/types").Signal;
type ProfileData = import("../src/lib/types").ProfileData;
type Ranked = import("../src/lib/reco/engine").Ranked;

const TUNING_DEFAULT = structuredClone(engine.TUNING);
const SIGNAL_DEFAULT = { ...model.SIGNAL_WEIGHT };

// ---------- Utilidades ----------
function viewFromFeat(f: ItemFeatures): ItemView {
  return {
    key: f.key,
    type: f.type,
    title: f.title,
    year: f.year,
    genreIds: f.genreIds,
    fkeys: Object.keys(f.f),
    labels: f.labels,
    rating: f.rating,
    voteCount: f.voteCount,
    popularity: f.popularity,
  };
}

/** Limpia del almacén de evaluación todo menos la caché de rasgos y semillas (entre variantes). */
async function resetStore() {
  if (!existsSync(STORE_FILE)) return;
  const data = JSON.parse(await fs.readFile(STORE_FILE, "utf8"));
  const kv = data._kv ?? {};
  // Se conservan cachés (rasgos, semillas, críticas) y el registro de perfiles; lo aprendido se borra.
  const keep = Object.fromEntries(
    Object.entries(kv).filter(([k]) => ["item:", "seeds:", "pool:", "list:", "rsum:", "reviews:", "rss:", "profiles:"].some((p) => k.startsWith(p))),
  );
  await fs.writeFile(STORE_FILE, JSON.stringify({ _kv: keep }));
}

const emptyProfile = (p: Persona | { prefs: Persona["prefs"] }): ProfileData => ({
  watchlist: [],
  seen: [],
  platforms: [],
  lastFilters: null,
  prefs: p.prefs,
  feedback: {},
});

/** Decisión ruidosa de la persona ante un título. null = no lo valora. */
function decide(u: number, rand: () => number, unratedRate: number): Signal | null {
  if (rand() < unratedRate) return null;
  const noisy = u + (rand() - 0.5) * 0.5;
  if (noisy >= LOVE) return "love";
  if (noisy >= LIKE) return "like";
  if (noisy <= DISLIKE) return rand() < 0.6 ? "dislike" : "not_interested";
  return rand() < 0.3 ? "not_interested" : null;
}

function ndcg(utils: number[], idealPool: number[], k = 10) {
  const gain = (u: number) => Math.max(0, Math.min(3, u));
  const dcg = (xs: number[]) => xs.slice(0, k).reduce((s, u, i) => s + gain(u) / Math.log2(i + 2), 0);
  const ideal = dcg([...idealPool].sort((a, b) => b - a));
  return ideal ? dcg(utils) / ideal : 0;
}

function diversity(feats: (ItemFeatures | null)[]) {
  const vs = feats.filter(Boolean).map((f) => f!.f);
  if (vs.length < 2) return 0;
  let s = 0;
  let n = 0;
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) {
      s += model.dot(vs[i], vs[j]);
      n++;
    }
  return 1 - s / n;
}

interface RoundMetrics {
  p10: number;
  love10: number;
  generic: number;
  ndcg: number;
  div: number;
  avgPop: number;
  gems: number;
  reasonsOk: number;
  latencyMs: number;
  baseQ: number;
  basePop: number;
  scoreOnly: number;
  poolSize: number;
  liked: number;
  keys: string[];
  sources: Record<string, number>;
}

/** ¿La explicación cita algo que de verdad le gusta a la persona? */
function reasonOk(reason: string, feat: ItemFeatures | null, u: number, persona: Persona | null, likedTitles: Set<string>, uFn: (it: ItemView) => number): boolean {
  const m = reason.match(/gustó «(.+)»/);
  if (m) return likedTitles.has(m[1]);
  if (!persona || !feat) return u >= LIKE;
  const cited = reason.match(/(?:gusta|interesa|De|Con|semana ·)[:\s]+(.+)$/);
  if (cited) {
    const label = cited[1].trim();
    const key = Object.entries(feat.labels).find(([, v]) => v === label)?.[0];
    if (key) return featureLiked(persona, key, label) || (key.startsWith("c:") || key.startsWith("p:") ? u >= LIKE : false);
  }
  void uFn;
  return u >= LIKE; // explicaciones genéricas («Muy valorada», «Joya…», «Tendencia…»): ok si el título le gusta
}

async function evalList(
  items: { key: string; reason?: string }[],
  pool: Ranked[],
  genericTop: string[],
  likeThr: number,
  uFn: (it: ItemView) => number,
  persona: Persona | null,
  likedTitles: Set<string>,
  latencyMs: number,
): Promise<RoundMetrics> {
  const top = items.slice(0, 10);
  const feats = await features.getManyFeatures(top.map((i) => i.key));
  const us = top.map((i) => (feats.get(i.key) ? uFn(viewFromFeat(feats.get(i.key)!)) : 0));
  const poolU = pool.filter((r) => r.feat).map((r) => ({ r, u: uFn(viewFromFeat(r.feat!)) }));
  const p = (xs: number[]) => (xs.length ? xs.filter((u) => u >= likeThr).length / Math.min(10, xs.length) : 0);
  const byQ = [...poolU].sort((a, b) => b.r.quality - a.r.quality).slice(0, 10).map((x) => x.u);
  const byPop = [...poolU].sort((a, b) => (b.r.raw.popularity ?? 0) - (a.r.raw.popularity ?? 0)).slice(0, 10).map((x) => x.u);
  const byScore = poolU.slice(0, 10).map((x) => x.u);
  const gFeats = await features.getManyFeatures(genericTop);
  const gU = genericTop.map((k) => (gFeats.get(k) ? uFn(viewFromFeat(gFeats.get(k)!)) : 0));
  const sources: Record<string, number> = {};
  for (const i of top) {
    const r = pool.find((x) => x.key === i.key);
    if (r) sources[r.source] = (sources[r.source] ?? 0) + 1;
  }
  return {
    p10: p(us),
    love10: us.length ? us.filter((u) => u >= LOVE).length / Math.min(10, us.length) : 0,
    generic: p(gU),
    ndcg: ndcg(us, poolU.map((x) => x.u)),
    div: diversity(top.map((i) => feats.get(i.key) ?? null)),
    avgPop: top.reduce((s, i) => s + (feats.get(i.key)?.popularity ?? 0), 0) / Math.max(1, top.length),
    gems: top.filter((i) => (feats.get(i.key)?.voteCount ?? 99999) < 2500).length / Math.max(1, top.length),
    reasonsOk: top.filter((i, k) => reasonOk(i.reason ?? "", feats.get(i.key) ?? null, us[k], persona, likedTitles, uFn)).length / Math.max(1, top.length),
    latencyMs,
    baseQ: p(byQ),
    basePop: p(byPop),
    scoreOnly: p(byScore),
    poolSize: pool.length,
    liked: us.filter((u) => u >= LIKE).length,
    keys: top.map((i) => i.key),
    sources,
  };
}

// ---------- Simulación ----------

/** Línea base sin personalizar: lo que recomendaría el motor a alguien sin cuestionario ni valoraciones. */
const genericCache = new Map<string, string[]>();
async function genericTop(types: Persona["types"]): Promise<string[]> {
  const k = types.join("+");
  if (!genericCache.has(k)) {
    const empty = { w: {}, anchors: [], blocked: [], signals: 0, updatedAt: 0, version: 0 };
    const ranked = await engine.recommend(empty, null, [], types);
    genericCache.set(k, engine.mmr(ranked, 10).map((r) => r.key));
  }
  return genericCache.get(k)!;
}

/** Guarda perfil y valoraciones (el store las guarda en claves separadas si existe saveFeedback). */
async function persist(id: string, data: ProfileData) {
  await store.saveProfile(id, data);
  const s = store as unknown as { saveFeedback?: (id: string, f: ProfileData["feedback"]) => Promise<void> };
  if (s.saveFeedback) await s.saveFeedback(id, data.feedback);
}

const withKey = <T extends { type: string; id: number }>(t: T) => ({ ...t, key: `${t.type}:${t.id}` });

async function rateSeeds(id: string, data: ProfileData, types: Persona["types"], uFn: (it: ItemView) => number, rand: () => number) {
  const seeds = await engine.getSeeds(types);
  const feats = await features.getManyFeatures(seeds.map((s) => `${s.type}:${s.id}`));
  for (const s of seeds) {
    const k = `${s.type}:${s.id}`;
    const f = feats.get(k);
    if (!f || rand() < 0.2) continue; // «no la he visto»
    const sig = decide(uFn(viewFromFeat(f)), rand, 0);
    if (sig && sig !== "not_interested") data.feedback[k] = { s: sig, t: Date.now() };
  }
  void id;
}

async function applyFeedback(data: ProfileData, keys: string[], uFn: (it: ItemView) => number, rand: () => number) {
  const feats = await features.getManyFeatures(keys);
  for (const k of keys) {
    const f = feats.get(k);
    if (!f) continue;
    const sig = decide(uFn(viewFromFeat(f)), rand, 0.15);
    if (sig) data.feedback[k] = { s: sig, t: Date.now() };
  }
}

async function likedTitlesOf(data: ProfileData) {
  const keys = Object.entries(data.feedback).filter(([, v]) => v.s === "love" || v.s === "like").map(([k]) => k);
  const feats = await features.getManyFeatures(keys);
  return new Set([...feats.values()].map((f) => f.title));
}

interface PersonaResult {
  id: string;
  name: string;
  rounds: RoundMetrics[];
}

async function runPersona(p: Persona, data: ProfileData, round: number, rand: () => number): Promise<RoundMetrics> {
  const uFn = (it: ItemView) => utility(p, it);
  await persist(p.id, data);
  const taste = await model.retrain(p.id);
  const typeArg = p.types.length > 1 ? "all" : p.types[0];
  const t0 = performance.now();
  const shelves = await engine.getShelves(p.id, typeArg);
  const latency = performance.now() - t0;
  const top = (shelves.find((s) => s.id === "top")?.items ?? []).map(withKey);
  const pool = await engine.recommend(taste, p.prefs, [], p.types);
  const m = await evalList(top, pool, await genericTop(p.types), LIKE, uFn, p, await likedTitlesOf(data), latency);
  await applyFeedback(data, m.keys, uFn, rand);
  void round;
  return m;
}

async function simulate(label: string): Promise<{ label: string; personas: PersonaResult[]; couple: { top: RoundMetrics[]; together: RoundMetrics[] } }> {
  await resetStore();
  const personas = QUICK ? PERSONAS.slice(0, 3) : PERSONAS;
  const results: PersonaResult[] = [];
  const all = [...personas, COUPLE.a, COUPLE.b];
  const datas = new Map<string, ProfileData>();
  const rands = new Map<string, () => number>();
  for (const p of all) {
    const d = emptyProfile(p);
    const rand = mulberry32(hashStr(p.id));
    await rateSeeds(p.id, d, p.types, (it) => utility(p, it), rand);
    datas.set(p.id, d);
    rands.set(p.id, rand);
    results.push({ id: p.id, name: p.name, rounds: [] });
  }
  const coupleData = emptyProfile(COUPLE);
  const coupleRand = mulberry32(hashStr("pareja"));
  await rateSeeds("pareja", coupleData, ["movie"], coupleUtility, coupleRand);
  const couple = { top: [] as RoundMetrics[], together: [] as RoundMetrics[] };

  for (let r = 0; r < ROUNDS; r++) {
    for (const p of all) {
      engineRand = mulberry32(hashStr(`${p.id}:${r}`));
      const m = await runPersona(p, datas.get(p.id)!, r, rands.get(p.id)!);
      results.find((x) => x.id === p.id)!.rounds.push(m);
      process.stderr.write(`  [${label}] r${r} ${p.id.padEnd(12)} p@10=${m.p10.toFixed(2)} ndcg=${m.ndcg.toFixed(2)} ${Math.round(m.latencyMs)}ms\n`);
    }
    // Pareja: después de los dos miembros, que ya tienen su modelo guardado.
    engineRand = mulberry32(hashStr(`pareja:${r}`));
    await persist("pareja", coupleData);
    const taste = await model.retrain("pareja");
    const t0 = performance.now();
    const shelves = await engine.getShelves("pareja", "movie");
    const latency = performance.now() - t0;
    const pool = await engine.recommend(taste, coupleData.prefs, [], ["movie"]);
    const liked = await likedTitlesOf(coupleData);
    let topShelf = (shelves.find((s) => s.id === "top")?.items ?? []).map(withKey) as { key: string; reason?: string }[];
    let together = (shelves.find((s) => s.id === "together")?.items ?? []).map(withKey) as { key: string; reason?: string }[];
    let evalPool = pool;
    if (COUPLE_MODE === "avgMisery") {
      // Propuesta: recuperación con la media de los dos (más lo positivo propio) y ranking «media sin miseria» por título.
      const [ta, tb] = await Promise.all([model.getTaste("victor"), model.getTaste("alba")]);
      const na = features.normalize(ta.w);
      const nb = features.normalize(tb.w);
      const w: Record<string, number> = {};
      for (const k of new Set([...Object.keys(na), ...Object.keys(nb)])) w[k] = ((na[k] ?? 0) + (nb[k] ?? 0)) / 2;
      const own = features.normalize(taste.w);
      for (const [k, v] of Object.entries(own)) if (v > 0) w[k] = (w[k] ?? 0) + 0.5 * v;
      const alt = { ...taste, w, signals: Math.max(taste.signals, 10), blocked: [...new Set([...taste.blocked, ...ta.blocked.filter((k) => !ta.anchors.includes(k)), ...tb.blocked.filter((k) => !tb.anchors.includes(k))])] };
      evalPool = await engine.recommend(alt, coupleData.prefs, [], ["movie"]);
      const rescored = evalPool.map((r) => {
        const f = r.feat?.f ?? r.shallow;
        const ca = model.cosine(ta.w, f);
        const cb = model.cosine(tb.w, f);
        const co = model.cosine(taste.w, f);
        return { ...r, score: 0.35 * (ca + cb) / 2 + 0.35 * Math.min(ca, cb) + 0.1 * co + 0.2 * r.quality };
      }).sort((a, b) => b.score - a.score);
      const pick = engine.mmr(rescored, 10).map((r) => ({ key: r.key, reason: "Os puede gustar a los dos" }));
      topShelf = pick;
      together = pick;
    }
    const gt = await genericTop(["movie"]);
    const mt = await evalList(topShelf, evalPool, gt, COUPLE_LIKE, coupleUtility, null, liked, latency);
    const mg = await evalList(together, evalPool, gt, COUPLE_LIKE, coupleUtility, null, liked, latency);
    couple.top.push(mt);
    couple.together.push(mg);
    await applyFeedback(coupleData, [...new Set([...mt.keys, ...mg.keys.slice(0, 5)])], coupleUtility, coupleRand);
    process.stderr.write(`  [${label}] r${r} pareja       top p@10=${mt.p10.toFixed(2)} juntos p@10=${mg.p10.toFixed(2)} (n=${together.length})\n`);
  }
  await saveHttpCache();
  return { label, personas: results, couple };
}

// ---------- Variantes ----------

type Variant = { name: string; apply: () => void };
const reset = () => {
  Object.assign(engine.TUNING, structuredClone(TUNING_DEFAULT));
  Object.assign(model.SIGNAL_WEIGHT, SIGNAL_DEFAULT);
};
const VARIANTS: Variant[] = [
  { name: "current", apply: () => {} },
  { name: "affHigh", apply: () => Object.assign(engine.TUNING, { wAffinity: 0.75, wQuality: 0.15 }) },
  { name: "qualHigh", apply: () => Object.assign(engine.TUNING, { wAffinity: 0.5, wQuality: 0.35 }) },
  { name: "mmr85", apply: () => Object.assign(engine.TUNING, { mmrLambda: 0.85 }) },
  { name: "mmr60", apply: () => Object.assign(engine.TUNING, { mmrLambda: 0.6 }) },
  { name: "minAff10", apply: () => Object.assign(engine.TUNING, { minAffinity: 0.1 }) },
  { name: "srcFlat", apply: () => Object.assign(engine.TUNING, { sourcePrior: { because: 0.05, people: 0.05, keyword: 0.05, discover: 0.05, trending: 0.02, gems: 0.03 } }) },
  { name: "stage1_120", apply: () => Object.assign(engine.TUNING, { stage1Keep: 120 }) },
  { name: "combo", apply: () => Object.assign(engine.TUNING, { wAffinity: 0.75, wQuality: 0.15, mmrLambda: 0.6 }) },
  { name: "combo2", apply: () => Object.assign(engine.TUNING, { wAffinity: 0.7, wQuality: 0.2, mmrLambda: 0.65 }) },
  { name: "comboNeg", apply: () => { Object.assign(engine.TUNING, { wAffinity: 0.75, wQuality: 0.15, mmrLambda: 0.6 }); Object.assign(model.SIGNAL_WEIGHT, { dislike: -3.5, not_interested: -1.8 }); } },
  { name: "gcalUnion", apply: () => Object.assign(engine.TUNING, { groupCalibration: "union", sharedRetrieval: false }) },
  { name: "seenPen0", apply: () => Object.assign(engine.TUNING, { groupSeenPenalty: 0 }) },
  { name: "seenPen30", apply: () => Object.assign(engine.TUNING, { groupSeenPenalty: 0.3 }) },
  { name: "noFresh", apply: () => Object.assign(engine.TUNING, { freshShrink: 0 }) },
  { name: "noItemExplain", apply: () => Object.assign(engine.TUNING, { itemExplainMin: 2 }) },
  { name: "noBecauseFloor", apply: () => Object.assign(engine.TUNING, { becauseMinVotes: { movie: 0, tv: 0 } }) },
  { name: "noRomanceKw", apply: () => Object.assign(engine.TUNING, { romanceKwPenalty: 0 }) },
  { name: "noCritic", apply: () => Object.assign(engine.TUNING, { wCritic: 0 }) },
  { name: "gemsAllLangs", apply: () => Object.assign(engine.TUNING, { gemsLangs: 0 }) },
  { name: "noSharedRet", apply: () => Object.assign(engine.TUNING, { sharedRetrieval: false }) },
  { name: "gcalNone", apply: () => Object.assign(engine.TUNING, { groupCalibration: "none" }) },
  { name: "gMin", apply: () => Object.assign(engine.TUNING, { groupCalibration: "shared", group: { avg: 0.25, min: 0.55, own: 0.1 } }) },
  { name: "gMinNone", apply: () => Object.assign(engine.TUNING, { groupCalibration: "none", group: { avg: 0.25, min: 0.55, own: 0.1 } }) },
  { name: "negStrong", apply: () => Object.assign(model.SIGNAL_WEIGHT, { dislike: -3.5, not_interested: -1.8 }) },
];

function summarize(res: Awaited<ReturnType<typeof simulate>>) {
  const rows: string[] = [];
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const fmt = (x: number) => x.toFixed(2);
  rows.push(`\n### ${res.label}`);
  rows.push("| persona | ronda | p@10 | ❤@10 | nDCG | base genérica | base calidad | divers. | joyas | razones ok | ms |");
  rows.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of res.personas)
    p.rounds.forEach((m, r) =>
      rows.push(`| ${p.id} | ${r} | ${fmt(m.p10)} | ${fmt(m.love10)} | ${fmt(m.ndcg)} | ${fmt(m.generic)} | ${fmt(m.baseQ)} | ${fmt(m.div)} | ${fmt(m.gems)} | ${fmt(m.reasonsOk)} | ${Math.round(m.latencyMs)} |`),
    );
  res.couple.top.forEach((m, r) => rows.push(`| pareja·top | ${r} | ${fmt(m.p10)} | ${fmt(m.love10)} | ${fmt(m.ndcg)} | ${fmt(m.generic)} | ${fmt(m.baseQ)} | ${fmt(m.div)} | ${fmt(m.gems)} | ${fmt(m.reasonsOk)} | ${Math.round(m.latencyMs)} |`));
  res.couple.together.forEach((m, r) => rows.push(`| pareja·juntos | ${r} | ${fmt(m.p10)} | ${fmt(m.love10)} | ${fmt(m.ndcg)} | ${fmt(m.generic)} | | ${fmt(m.div)} | ${fmt(m.gems)} | ${fmt(m.reasonsOk)} | |`));
  const allRounds = [...res.personas.flatMap((p) => p.rounds), ...res.couple.top];
  const last = [...res.personas.map((p) => p.rounds.at(-1)!), res.couple.top.at(-1)!];
  const first = [...res.personas.map((p) => p.rounds[0]), res.couple.top[0]];
  const coverage = new Set(last.flatMap((m) => m.keys)).size / Math.max(1, last.reduce((s, m) => s + m.keys.length, 0));
  const summary = {
    p10_r0: avg(first.map((m) => m.p10)),
    p10_last: avg(last.map((m) => m.p10)),
    p10_all: avg(allRounds.map((m) => m.p10)),
    p10_indiv: avg(res.personas.flatMap((p) => p.rounds).map((m) => m.p10)),
    love10_all: avg(allRounds.map((m) => m.love10)),
    generic_all: avg(allRounds.map((m) => m.generic)),
    ndcg_all: avg(allRounds.map((m) => m.ndcg)),
    baseQ_all: avg(allRounds.map((m) => m.baseQ)),
    basePop_all: avg(allRounds.map((m) => m.basePop)),
    div_all: avg(allRounds.map((m) => m.div)),
    gems_all: avg(allRounds.map((m) => m.gems)),
    reasons_all: avg(allRounds.map((m) => m.reasonsOk)),
    together_all: avg(res.couple.together.map((m) => m.p10)),
    coupleTop_all: avg(res.couple.top.map((m) => m.p10)),
    coverage_last: coverage,
    latency_ms: avg(allRounds.map((m) => m.latencyMs)),
    worstPersona: Math.min(...res.personas.map((p) => avg(p.rounds.map((m) => m.p10)))),
  };
  rows.push(`\nResumen ${res.label}: ` + Object.entries(summary).map(([k, v]) => `${k}=${fmt(v)}`).join(" "));
  return { rows: rows.join("\n"), summary };
}

// --reviews N: calcula antes las críticas (src/lib/reviews) de hasta N títulos ya cacheados, para medir su efecto
// (aspectos `a:` y nota de la crítica). Se guardan en el almacén de evaluación y se reutilizan.
const WARM_REVIEWS = Number(arg("reviews", "0"));
if (WARM_REVIEWS > 0 && existsSync(STORE_FILE)) {
  const { warmReviews } = await import("../src/lib/reviews");
  const kv = (JSON.parse(await fs.readFile(STORE_FILE, "utf8"))._kv ?? {}) as Record<string, unknown>;
  const keys = Object.keys(kv)
    .filter((k) => /^item:v\d+:/.test(k))
    .map((k) => k.replace(/^item:v\d+:/, ""));
  process.stderr.write(`Críticas: ${keys.length} títulos en caché, calculando hasta ${WARM_REVIEWS}…\n`);
  const done = await warmReviews(keys, WARM_REVIEWS);
  process.stderr.write(`Críticas nuevas: ${done}\n`);
}

const wanted = arg("variants", "current").split(",");
const selected = wanted.includes("all") ? VARIANTS : VARIANTS.filter((v) => wanted.includes(v.name));
const out: Record<string, unknown> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : {};
for (const v of selected) {
  reset();
  v.apply();
  const t0 = Date.now();
  const res = await simulate([v.name, ENGINE !== "src" ? `engine=${ENGINE}${ENGINE === "quota" ? arg("quota", "0.4") : ""}` : "", COUPLE_MODE !== "current" ? COUPLE_MODE : ""].filter(Boolean).join("+"));
  const { rows, summary } = summarize(res);
  console.log(rows);
  console.log(`(${v.name}: ${Math.round((Date.now() - t0) / 1000)} s, llamadas TMDB nuevas=${httpCalls})`);
  out[v.name] = { summary, personas: res.personas.map((p) => ({ id: p.id, p10: p.rounds.map((m) => m.p10), ndcg: p.rounds.map((m) => m.ndcg), sources: p.rounds.map((m) => m.sources) })), couple: { top: res.couple.top.map((m) => m.p10), together: res.couple.together.map((m) => m.p10) } };
  await fs.writeFile(RESULTS, JSON.stringify(out, null, 2));
}
await saveHttpCache();
