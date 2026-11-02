import "server-only";
import { PROFILES } from "@/config/profiles";
import type { after as afterFn } from "next/server";
import { GENRE_GROUPS, type Prefs } from "../prefs";
import { getProfile, kvGet, kvSet, listPush, listRange } from "../store";
import type { ProfileData } from "../types";
import { getManyFeatures, normalize } from "./features";
import type { ImplicitEvent, RecoEvent, Signal, TasteModel } from "./types";

// Modelo de gustos: un vector de pesos por rasgo que se aprende de todo lo que hace el perfil.
// Cada señal suma (o resta) los rasgos del título con un peso según lo fuerte que es la señal
// y lo reciente que es (olvido exponencial). El cuestionario actúa como «prior» que pierde
// importancia a medida que hay señales reales.

const MODEL_VERSION = 4;
export const MAX_EVENTS = 2000;

/** Peso de cada señal en el aprendizaje. */
export const SIGNAL_WEIGHT: Record<Signal | ImplicitEvent, number> = {
  love: 3,
  like: 2,
  dislike: -2.5,
  not_interested: -1.2,
  want: 1.2,
  seen: 0.6,
  open: 0.15,
  skip: -0.25,
  unwant: 0,
  unseen: 0,
};
const OPEN_CAP = 0.6; // abrir muchas veces la misma ficha no debe pesar como un «me encanta»
const SKIP_CAP = -1;
const HALF_LIFE_DAYS = 180;
const PRIOR_STRENGTH = 1.2;
/** Con ~15 señales el cuestionario ya pesa la mitad que al principio. */
const PRIOR_HALF_SIGNALS = 15;

// ---------- Álgebra de vectores dispersos ----------

export type Vec = Record<string, number>;

export function dot(a: Vec, b: Vec): number {
  const [small, big] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  let s = 0;
  for (const [k, v] of Object.entries(small)) {
    const w = big[k];
    if (w) s += v * w;
  }
  return s;
}

export const norm = (a: Vec) => Math.sqrt(dot(a, a));

export function cosine(a: Vec, b: Vec): number {
  const n = norm(a) * norm(b);
  return n ? dot(a, b) / n : 0;
}

function addScaled(target: Vec, v: Vec, s: number) {
  for (const [k, x] of Object.entries(v)) target[k] = (target[k] ?? 0) + x * s;
}

// ---------- Eventos ----------

const eventsKey = (profile: string) => `events:${profile}`;
const tasteKey = (profile: string) => `taste:${profile}`;

export function logEvent(profile: string, ev: RecoEvent) {
  return listPush(eventsKey(profile), ev, MAX_EVENTS);
}

const decay = (t: number, now: number) => Math.pow(0.5, Math.max(0, now - t) / (HALF_LIFE_DAYS * 86400000));

// ---------- Prior del cuestionario ----------

export function priorVector(p: Prefs | null): Vec {
  const v: Vec = {};
  if (!p) return v;
  for (const g of GENRE_GROUPS) {
    const ids = [...g.movie, ...g.tv];
    const w = p.likes.includes(g.id) ? 1 : p.avoid.includes(g.id) ? -2 : 0;
    if (w) for (const id of ids) v[`g:${id}`] = (v[`g:${id}`] ?? 0) + w;
  }
  if (p.types.length === 1) v[`t:${p.types[0]}`] = 0.8;
  const now = new Date().getFullYear();
  const dec = Math.floor(now / 10) * 10;
  if (p.era === "new") {
    v[`d:${dec}`] = 0.8;
    v[`d:${dec - 10}`] = 0.3;
  } else if (p.era === "modern") {
    for (let d = 2000; d <= dec; d += 10) v[`d:${d}`] = 0.35;
  }
  if (p.runtime === "short") v["r:short"] = 0.6;
  else if (p.runtime === "normal") {
    v["r:short"] = 0.2;
    v["r:medium"] = 0.4;
    v["r:long"] = -0.3;
  }
  return v;
}

// ---------- Entrenamiento ----------

/** Peso acumulado por título a partir de feedback, lista, vistos y eventos implícitos. */
export function itemWeights(profile: ProfileData, events: RecoEvent[], now = Date.now()): Map<string, number> {
  const w = new Map<string, number>();
  const add = (k: string, x: number) => w.set(k, (w.get(k) ?? 0) + x);

  // Implícitos (abrir, saltar), con tope por título.
  const opens = new Map<string, number>();
  const skips = new Map<string, number>();
  for (const e of events) {
    if (e.e === "open") opens.set(e.k, Math.min(OPEN_CAP, (opens.get(e.k) ?? 0) + SIGNAL_WEIGHT.open * decay(e.t, now)));
    if (e.e === "skip") skips.set(e.k, Math.max(SKIP_CAP, (skips.get(e.k) ?? 0) + SIGNAL_WEIGHT.skip * decay(e.t, now)));
  }
  opens.forEach((x, k) => add(k, x));
  skips.forEach((x, k) => add(k, x));

  // Lista y vistos: si hay valoración explícita, manda la valoración.
  const lastEvent = new Map<string, number>();
  for (const e of events) if (!lastEvent.has(e.k)) lastEvent.set(e.k, e.t); // events vienen del más nuevo al más viejo
  for (const t of profile.watchlist) {
    const k = `${t.type}:${t.id}`;
    if (!profile.feedback[k]) add(k, SIGNAL_WEIGHT.want * decay(lastEvent.get(k) ?? now, now));
  }
  for (const k of profile.seen) {
    if (!profile.feedback[k]) add(k, SIGNAL_WEIGHT.seen * decay(lastEvent.get(k) ?? now, now));
  }
  for (const [k, fb] of Object.entries(profile.feedback)) add(k, SIGNAL_WEIGHT[fb.s] * decay(fb.t, now));
  return w;
}

export async function trainTaste(profileId: string, profile?: ProfileData): Promise<TasteModel> {
  const data = profile ?? (await getProfile(profileId));
  const events = await listRange<RecoEvent>(eventsKey(profileId), MAX_EVENTS).catch(() => []);
  const model = await buildTaste(data, events);
  await kvSet(tasteKey(profileId), model).catch(() => {});
  return model;
}

/** Entrena un modelo a partir de los datos de un perfil, sin leer ni guardar nada (útil para la evaluación offline). */
export async function buildTaste(data: ProfileData, events: RecoEvent[] = [], now = Date.now()): Promise<TasteModel> {
  const weights = itemWeights(data, events, now);
  const keys = [...weights.keys()].filter((k) => Math.abs(weights.get(k)!) > 0.01);
  const feats = await getManyFeatures(keys);

  const w: Vec = {};
  for (const k of keys) {
    const f = feats.get(k);
    if (f) addScaled(w, f.f, weights.get(k)!);
  }
  const signals = Object.keys(data.feedback).length + data.watchlist.length + data.seen.length;
  addScaled(w, priorVector(data.prefs), PRIOR_STRENGTH / (1 + signals / PRIOR_HALF_SIGNALS));

  // Poda: nos quedamos con los 400 rasgos más fuertes.
  const pruned = Object.fromEntries(
    Object.entries(w)
      .filter(([, x]) => Math.abs(x) > 0.01)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 400),
  );

  const positive = Object.entries(data.feedback)
    .filter(([, fb]) => fb.s === "love" || fb.s === "like")
    .sort((a, b) => (b[1].s === "love" ? 1 : 0) - (a[1].s === "love" ? 1 : 0) || b[1].t - a[1].t)
    .map(([k]) => k);
  const wanted = data.watchlist.map((t) => `${t.type}:${t.id}`).reverse();
  const anchors = [...new Set([...positive, ...wanted])].filter((k) => feats.has(k)).slice(0, 8);

  const rejected = Object.entries(data.feedback)
    .filter(([, fb]) => fb.s === "dislike" || fb.s === "not_interested")
    .map(([k]) => k);
  const blocked = [
    ...rejected,
    ...data.seen,
    ...data.watchlist.map((t) => `${t.type}:${t.id}`),
    ...Object.keys(data.feedback), // lo ya valorado no se vuelve a recomendar
  ];

  return { w: pruned, anchors, blocked: [...new Set(blocked)], rejected, signals, updatedAt: now, version: MODEL_VERSION };
}

/**
 * Perfil «pareja»: su propio vector + lo que gusta A LOS DOS. Para cada rasgo se toma el mínimo de los
 * vectores (normalizados) de Víctor y Alba: si a uno le encanta y al otro le da igual, no suma; si uno lo
 * detesta, resta. Además se bloquea lo que cualquiera de los dos ha rechazado.
 */
export async function trainCouple(coupleId: string, memberIds: string[]): Promise<TasteModel> {
  const own = await trainTaste(coupleId);
  const members = await Promise.all(memberIds.map((id) => getTaste(id)));
  if (members.length < 2) return own;
  // Media de los dos vectores normalizados + solo la parte positiva del vector propio de la pareja.
  // (El mínimo por rasgo, medido en la evaluación offline, hacía que la pareja se quedara sin recomendaciones.)
  const [a, b] = members.map((m) => normalize(m.w));
  const ownN = normalize(own.w);
  const w: Vec = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(ownN)])) {
    const x = ((a[k] ?? 0) + (b[k] ?? 0)) / 2 + 0.5 * Math.max(0, ownN[k] ?? 0);
    if (Math.abs(x) > 0.005) w[k] = x;
  }
  // Lo que uno de los dos ha visto o quiere ver NO se bloquea (puede ser justo lo que ver juntos):
  // solo lo que alguno ha rechazado explícitamente.
  const rejected = [...new Set([...own.rejected, ...members.flatMap((m) => m.rejected)])];
  const anchorOwner: Record<string, string> = {};
  const memberAnchors = members.flatMap((m, i) =>
    m.anchors
      .filter((k) => !own.anchors.includes(k))
      .slice(0, 2)
      .map((k) => ((anchorOwner[k] = memberIds[i]), k)),
  );
  const model: TasteModel = {
    ...own,
    w,
    anchors: [...new Set([...own.anchors, ...memberAnchors])].slice(0, 8),
    blocked: [...new Set([...own.blocked, ...rejected])],
    rejected,
    anchorOwner,
    signals: own.signals + members.reduce((s, m) => s + m.signals, 0) / 2,
  };
  await kvSet(tasteKey(coupleId), model).catch(() => {});
  return model;
}

/** Si cambia un miembro, la pareja también debe reentrenarse (después de responder). */
export function coupleRetrainAfter(profileId: string, after: typeof afterFn) {
  if (profileId === "pareja") return;
  after(() => retrain("pareja").then(() => undefined, (e) => console.error("retrain pareja", e)));
}

/** Miembros del perfil pareja (los demás perfiles). */
export const coupleMembers = (id: string) => (id === "pareja" ? PROFILES.filter((p) => p.id !== "pareja").map((p) => p.id) : []);

export async function retrain(profileId: string): Promise<TasteModel> {
  const members = coupleMembers(profileId);
  return members.length ? trainCouple(profileId, members) : trainTaste(profileId);
}

const STALE_MS = 6 * 3600 * 1000;

/** Modelo guardado; si no existe, es de otra versión o está viejo, se reentrena. */
export async function getTaste(profileId: string): Promise<TasteModel> {
  const m = await kvGet<TasteModel>(tasteKey(profileId)).catch(() => null);
  if (m && m.version === MODEL_VERSION && Date.now() - m.updatedAt < STALE_MS) return m;
  return retrain(profileId);
}
