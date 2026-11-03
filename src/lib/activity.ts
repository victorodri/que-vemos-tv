import "server-only";
import { listProfiles, toPublic, type PublicProfile } from "./profiles";
import { getManyFeatures } from "./reco/features";
import type { RecoEvent } from "./reco/types";
import { getProfile, kvGet, kvSet, listRange } from "./store";
import { titleKey, type Title } from "./types";

// Actividad de la comunidad de Qué Vemos: lo que otros perfiles han valorado bien, quieren ver o han visto.
// Solo señales positivas y con su estado ACTUAL (si alguien quita un ❤️ o saca algo de su lista, desaparece).
// De cada perfil solo se comparte nombre, emoji y color, como en /api/community. Nunca se inventa actividad.

export type SocialSignal = "love" | "like" | "want" | "seen";

/** Qué pesa más cuando un perfil tiene varias señales sobre el mismo título. */
const RANK: Record<SocialSignal, number> = { love: 4, like: 3, seen: 2, want: 1 };
const EVENTS_READ = 400;
const MAX_ENTRIES_PER_PROFILE = 120;
const CACHE_KEY = "activity:v1";
const CACHE_TTL = 90; // segundos: la franja se siente «en directo» sin leer todos los perfiles a cada visita

/** Lo que guarda la caché: solo ids y claves, sin títulos (se resuelven al responder). */
interface RawEntry {
  p: string;
  k: string;
  s: SocialSignal;
  t: number;
}

export type ActivityProfile = Pick<PublicProfile, "id" | "name" | "emoji" | "color">;

export interface ActivityItem {
  profile: ActivityProfile;
  title: Title;
  signal: SocialSignal;
  t: number;
}

export interface SocialCount {
  /** Nº de perfiles (distintos del que mira) con una señal positiva. */
  n: number;
  /** Nombres, en orden de señal más fuerte. */
  names: string[];
  /** Señal más fuerte que tiene alguien. */
  top: SocialSignal;
}

export interface ActivityResult {
  items: ActivityItem[];
  counts: Record<string, SocialCount>;
  /** Otros perfiles que existen (tengan o no actividad), para la invitación. */
  others: number;
  /** Otros perfiles con alguna actividad positiva. */
  active: number;
}

/** Señales positivas actuales de un perfil, una por título (la más fuerte). */
async function entriesOf(id: string): Promise<RawEntry[]> {
  const [data, events] = await Promise.all([getProfile(id), listRange<RecoEvent>(`events:${id}`, EVENTS_READ).catch(() => [] as RecoEvent[])]);
  // Fecha del último evento de cada tipo (los eventos vienen del más nuevo al más viejo).
  const lastAt = new Map<string, number>();
  for (const ev of events) if (!lastAt.has(`${ev.e}:${ev.k}`)) lastAt.set(`${ev.e}:${ev.k}`, ev.t);

  const best = new Map<string, RawEntry>();
  const put = (k: string, s: SocialSignal, t: number | undefined) => {
    if (!t) return; // sin fecha no se puede contar «cuándo»: mejor no mostrarlo en el feed
    const prev = best.get(k);
    if (!prev || RANK[s] > RANK[prev.s] || (RANK[s] === RANK[prev.s] && t > prev.t)) best.set(k, { p: id, k, s, t });
  };
  for (const [k, f] of Object.entries(data.feedback ?? {})) if (f.s === "love" || f.s === "like") put(k, f.s, f.t);
  for (const k of data.seen ?? []) put(k, "seen", data.seenAt?.[k] ?? lastAt.get(`seen:${k}`));
  for (const w of data.watchlist ?? []) {
    const k = titleKey(w);
    put(k, "want", lastAt.get(`want:${k}`));
  }
  return [...best.values()].sort((a, b) => b.t - a.t).slice(0, MAX_ENTRIES_PER_PROFILE);
}

/** Toda la actividad positiva de todos los perfiles individuales (las parejas repetirían lo de sus miembros). */
async function allEntries(): Promise<RawEntry[]> {
  const cached = await kvGet<RawEntry[]>(CACHE_KEY).catch(() => null);
  if (cached) return cached;
  const profiles = await listProfiles();
  const lists = await Promise.all(profiles.map((p) => entriesOf(p.id).catch(() => [] as RawEntry[])));
  const all = lists.flat().sort((a, b) => b.t - a.t);
  await kvSet(CACHE_KEY, all, CACHE_TTL).catch(() => {});
  return all;
}

/** Perfiles cuya actividad no cuenta como «de otros» para este: él mismo, sus miembros y sus parejas. */
async function excludedFor(viewerId: string) {
  const profiles = await listProfiles();
  const me = profiles.find((p) => p.id === viewerId);
  const excluded = new Set([viewerId, ...(me?.members ?? []), ...profiles.filter((p) => p.members.includes(viewerId)).map((p) => p.id)]);
  return { profiles, excluded };
}

/** Contadores sociales por título (sin títulos resueltos: barato, para puntuar). */
export async function socialCounts(viewerId: string): Promise<Record<string, SocialCount>> {
  const [{ profiles, excluded }, all] = await Promise.all([excludedFor(viewerId), allEntries()]);
  return countsOf(
    all.filter((e) => !excluded.has(e.p)),
    new Map(profiles.map((p) => [p.id, p.name])),
  );
}

function countsOf(entries: RawEntry[], names: Map<string, string>): Record<string, SocialCount> {
  const by = new Map<string, RawEntry[]>();
  for (const e of entries) by.set(e.k, [...(by.get(e.k) ?? []), e]);
  const out: Record<string, SocialCount> = {};
  for (const [k, list] of by) {
    const sorted = [...list].sort((a, b) => RANK[b.s] - RANK[a.s]);
    out[k] = { n: sorted.length, names: sorted.map((e) => names.get(e.p) ?? "Alguien"), top: sorted[0].s };
  }
  return out;
}

/** Actividad reciente de otros perfiles para `viewerId`, con títulos resueltos (los más recientes primero). */
export async function getActivity(viewerId: string, limit = 24): Promise<ActivityResult> {
  const [{ profiles, excluded }, all] = await Promise.all([excludedFor(viewerId), allEntries()]);
  const others = profiles.filter((p) => !excluded.has(p.id));
  const mine = all.filter((e) => !excluded.has(e.p));
  const counts = countsOf(mine, new Map(profiles.map((p) => [p.id, p.name])));

  // Feed variado: como mucho 3 seguidas del mismo perfil al principio, para que no lo acapare quien más valora.
  const picked: RawEntry[] = [];
  const perProfile = new Map<string, number>();
  for (const e of mine) {
    if (picked.length >= limit) break;
    const n = perProfile.get(e.p) ?? 0;
    if (n >= Math.max(3, Math.ceil(limit / Math.max(1, others.length)))) continue;
    perProfile.set(e.p, n + 1);
    picked.push(e);
  }
  const feats = await getManyFeatures(picked.map((e) => e.k));
  const meta = new Map(profiles.map((p) => [p.id, toPublic(p)]));
  const items: ActivityItem[] = [];
  for (const e of picked) {
    const f = feats.get(e.k);
    const p = meta.get(e.p);
    if (!f || !p) continue;
    items.push({
      profile: { id: p.id, name: p.name, emoji: p.emoji, color: p.color },
      title: {
        id: f.id,
        type: f.type,
        title: f.title,
        year: f.year,
        rating: f.rating,
        overview: f.overview,
        poster: f.poster,
        backdrop: f.backdrop,
        genreIds: f.genreIds,
      },
      signal: e.s,
      t: e.t,
    });
  }
  return { items, counts, others: others.length, active: new Set(mine.map((e) => e.p)).size };
}
