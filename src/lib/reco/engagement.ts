import "server-only";
import { hashOf } from "../client";
import { kvGet, kvSet } from "../store";
import type { RecoItem, Shelf } from "./types";

// Capa de interacción sobre las estanterías (lo que hace el «equipo de marketing y big data»):
//  1. Mide qué tiras ve el perfil (impresiones reales: la tira entra en pantalla) y en cuáles abre o guarda algo.
//  2. Cada apertura de la app (sesión) reordena tiras y portadas: más arriba y con más títulos las que usa,
//     abajo o fuera las que ignora (con un insight que lo explica), y los títulos que ya ha visto pasar sin tocarlos
//     dejan sitio a otros. La primera portada no repite las de las últimas aperturas.
//  3. Mide el éxito de cada sesión (¿añadió algo a su lista?, ¿cuánto tardó?) y decide cuándo merece la pena
//     preguntar (micro-encuestas), sin agobiar.
// `getShelves()` sigue siendo el ranking puro y cacheado; esto se aplica encima en cada petición.

const DAY = 86400_000;
const HALF_LIFE = 14 * DAY; // olvido de las estadísticas de las tiras
const FATIGUE_HALF_LIFE = 4 * DAY; // olvido de las impresiones de un título
const FATIGUE_DROP = 3.5; // impresiones (con olvido) sin abrirlo → se retira un tiempo
const HIDE_AFTER = 5; // sesiones viendo una tira sin tocarla → se retira
const HIDE_FOR = 21 * DAY;
const RECENT_FIRSTS = 8;

export interface ShelfStat {
  /** Sesiones en las que se vio (con olvido). */
  v: number;
  /** Sesiones en las que abrió algo de ella (con olvido). */
  e: number;
  /** Títulos añadidos a la lista o valorados bien desde ella (con olvido). */
  a: number;
  /** Sesiones seguidas viéndola sin tocarla. */
  streak: number;
  last: number;
  title: string;
  hiddenUntil?: number;
  /** El perfil dijo en una encuesta que la quiere (no se retira sola). */
  keep?: boolean;
}

export interface SessionStat {
  id: string;
  start: number;
  last: number;
  opens: number;
  adds: number;
  loves: number;
  views: number;
  firstOpenMs?: number;
  firstAddMs?: number;
  /** De dónde salió lo que añadió (tira o pestaña). */
  addFrom?: string[];
}

export interface Insight {
  t: number;
  kind: "shelf_ignored" | "shelf_loved" | "survey" | "fatigue" | "success" | "struggle";
  text: string;
}

export interface Intent {
  label: string;
  genres: number[];
  until: number;
}

export interface EngageState {
  v: 1;
  shelves: Record<string, ShelfStat>;
  /** Impresiones por título: n (con olvido), última vez y si lo llegó a abrir. */
  items: Record<string, { n: number; last: number; o?: boolean }>;
  firsts: string[];
  sessions: SessionStat[];
  insights: Insight[];
  survey: {
    lastAt: number;
    lastSession: string | null;
    asked: Record<string, number>;
    answers: { id: string; a: string; t: number }[];
    /** Pregunta enseñada y aún sin responder en esa sesión: se repite si la vista se recarga. */
    pending?: { session: string; survey: Survey };
  };
  intent?: Intent;
  /** Sesión que ya contó cada tira (una vista por sesión). */
  seenIn: Record<string, string>;
}

const key = (profile: string) => `engage:v1:${profile}`;

export const emptyState = (): EngageState => ({
  v: 1,
  shelves: {},
  items: {},
  firsts: [],
  sessions: [],
  insights: [],
  survey: { lastAt: 0, lastSession: null, asked: {}, answers: [] },
  seenIn: {},
});

export async function getEngage(profile: string): Promise<EngageState> {
  const s = await kvGet<EngageState>(key(profile)).catch(() => null);
  return s?.v === 1 ? { ...emptyState(), ...s } : emptyState();
}

export async function saveEngage(profile: string, s: EngageState) {
  // Recortes para que el JSON no crezca sin límite.
  const items = Object.entries(s.items).sort((a, b) => b[1].last - a[1].last).slice(0, 1500);
  s.items = Object.fromEntries(items);
  s.sessions = s.sessions.slice(-80);
  s.insights = s.insights.slice(-60);
  s.survey.answers = s.survey.answers.slice(-60);
  s.seenIn = Object.fromEntries(Object.entries(s.seenIn).slice(-60));
  await kvSet(key(profile), s);
}

const decay = (x: number, dt: number, half: number) => x * Math.pow(0.5, Math.max(0, dt) / half);

function stat(s: EngageState, fam: string, title: string, now: number): ShelfStat {
  const cur = s.shelves[fam] ?? { v: 0, e: 0, a: 0, streak: 0, last: now, title };
  const dt = now - cur.last;
  const next = { ...cur, v: decay(cur.v, dt, HALF_LIFE), e: decay(cur.e, dt, HALF_LIFE), a: decay(cur.a, dt, HALF_LIFE), last: now, title: title || cur.title };
  s.shelves[fam] = next;
  return next;
}

function addInsight(s: EngageState, kind: Insight["kind"], text: string, now: number) {
  // Una misma conclusión no se repite en una semana.
  if (s.insights.some((i) => i.text === text && now - i.t < 7 * DAY)) return;
  s.insights.push({ t: now, kind, text });
}

function session(s: EngageState, id: string, now: number): SessionStat {
  let ses = s.sessions.find((x) => x.id === id);
  if (!ses) {
    ses = { id, start: now, last: now, opens: 0, adds: 0, loves: 0, views: 0 };
    s.sessions.push(ses);
  }
  ses.last = now;
  return ses;
}

export type EngageAction = "open" | "want" | "love" | "like" | "dislike" | "not_interested" | "seen";

export interface EngageBatch {
  session: string;
  /** Tiras que han entrado en pantalla, con los títulos visibles. */
  views?: { shelf: string; title: string; keys: string[] }[];
  /** Acciones sobre títulos; `from` = tira (o pestaña: search, surprise…) desde la que se abrió. */
  actions?: { key: string; a: EngageAction; from?: string; t?: number }[];
}

/** Registra un lote de impresiones y acciones de una sesión y saca conclusiones (insights). */
export async function recordEngagement(profile: string, batch: EngageBatch, now = Date.now()): Promise<EngageState> {
  const s = await getEngage(profile);
  const ses = session(s, batch.session, now);

  for (const v of batch.views ?? []) {
    const st = stat(s, v.shelf, v.title, now);
    if (s.seenIn[v.shelf] !== batch.session) {
      s.seenIn[v.shelf] = batch.session;
      st.v += 1;
      ses.views += 1;
      // Racha sin tocarla: se cierra la de la sesión anterior (si en ella no la usó, crece).
      st.streak += 1;
    }
    for (const k of v.keys.slice(0, 8)) {
      const it = s.items[k];
      const n = it ? decay(it.n, now - it.last, FATIGUE_HALF_LIFE) : 0;
      // Cada título cuenta una vez por sesión.
      if (it && it.last >= ses.start) continue;
      s.items[k] = { n: n + 1, last: now, o: it?.o };
    }
  }

  for (const act of batch.actions ?? []) {
    const t = act.t && act.t <= now && act.t > now - DAY ? act.t : now;
    const from = act.from && act.from.length < 80 ? act.from : undefined;
    const st = from && s.shelves[from] ? stat(s, from, "", now) : null;
    if (act.a === "open") {
      ses.opens += 1;
      ses.firstOpenMs ??= t - ses.start;
      s.items[act.key] = { ...(s.items[act.key] ?? { n: 0, last: now }), o: true };
      if (st) {
        // Una sesión cuenta como «usó la tira» una sola vez.
        if (st.streak > 0) st.e += 1;
        st.streak = 0;
      }
    } else if (act.a === "want" || act.a === "love" || act.a === "like") {
      if (act.a === "want") {
        ses.adds += 1;
        ses.firstAddMs ??= t - ses.start;
        ses.addFrom = [...(ses.addFrom ?? []), from ?? "?"].slice(-10);
      }
      if (act.a === "love") ses.loves += 1;
      if (st) st.a += 1;
    }
  }

  // Conclusiones sobre las tiras.
  for (const [fam, st] of Object.entries(s.shelves)) {
    if (fam === "top" || st.keep) continue;
    if (st.streak >= HIDE_AFTER && !(st.hiddenUntil && st.hiddenUntil > now)) {
      st.hiddenUntil = now + HIDE_FOR;
      st.streak = 0;
      addInsight(s, "shelf_ignored", `Pasas de largo por «${st.title}»: la hemos retirado unas semanas para dejar sitio a otras.`, now);
    }
    if (st.e >= 3 && st.e / Math.max(st.v, 1) >= 0.5) addInsight(s, "shelf_loved", `«${st.title}» es de tus tiras favoritas: te la pondremos más arriba y con más títulos.`, now);
  }
  const recent = s.sessions.slice(-4);
  if (recent.length >= 3 && recent.every((x) => x.adds === 0 && x.opens >= 2))
    addInsight(s, "struggle", "En tus últimas aperturas has mirado varias fichas sin guardar ninguna: estamos probando recomendaciones más variadas.", now);
  if (recent.length >= 3 && recent.filter((x) => (x.firstAddMs ?? Infinity) < 90_000).length >= 2)
    addInsight(s, "success", "Últimamente encuentras algo para tu lista en menos de minuto y medio.", now);

  await saveEngage(profile, s);
  return s;
}

// ---------- Reordenación por sesión ----------

/** Generador pseudoaleatorio con semilla (mulberry32): misma sesión → mismo orden, nueva sesión → orden nuevo. */
function rng(seed: string) {
  let a = parseInt(hashOf(seed).slice(0, 8), 36) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Muestra de una Beta(a, b) aproximada (suficiente para ordenar tiras con muestreo de Thompson). */
function betaSample(a: number, b: number, rand: () => number) {
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  return Math.min(1, Math.max(0, mean + sd * z));
}

/** Penalización por cansancio: títulos que ha visto pasar varias veces sin abrir. */
function fatigue(s: EngageState, k: string, now: number) {
  const it = s.items[k];
  if (!it || it.o) return 0;
  return decay(it.n, now - it.last, FATIGUE_HALF_LIFE);
}

/** Prior de interés por tipo de tira (antes de tener datos del perfil). */
const PRIOR: Record<string, [number, number]> = {
  top: [3, 2],
  together: [3, 2],
  because: [2, 2],
  community: [1.5, 2],
  discover: [1.5, 2],
  people: [1.5, 2.5],
  trending: [1.2, 2.5],
  today: [3, 2],
};

/** Menos títulos en las tiras poco usadas: menos que mirar, menos carga. */
const sizeFor = (rate: number) => (rate >= 0.45 ? 24 : rate >= 0.25 ? 16 : 10);

/**
 * Ordena y recorta las estanterías para esta sesión. `shelves` trae más candidatos de los que se enseñan.
 * - Fuera: tiras retiradas por ignoradas; títulos cansados (vistos pasar ~4 veces sin abrir).
 * - Dentro de cada tira: orden por puntuación con un poco de azar de sesión y penalización por cansancio.
 * - Primera portada: muestreo entre los mejores, sin repetir las de las últimas aperturas.
 * - Orden de las tiras: «Lo mejor» primero; el resto por muestreo de Thompson sobre su tasa de uso.
 * - «Porque te gustó…» / «Más de…»: se eligen hasta 2 y 1 entre varias, rotando.
 */
export function arrangeShelves(shelves: Shelf[], s: EngageState, sessionId: string, now = Date.now()): Shelf[] {
  const rand = rng(sessionId);
  const recentFirsts = new Set(s.firsts);
  const famOf = (sh: Shelf) => sh.key ?? sh.id;
  const rate = (sh: Shelf) => {
    const st = s.shelves[famOf(sh)];
    const [a, b] = PRIOR[sh.id] ?? [1.5, 2];
    return { a: a + (st?.e ?? 0) + 0.5 * (st?.a ?? 0), b: b + Math.max(0, (st?.v ?? 0) - (st?.e ?? 0)) };
  };
  const meanRate = (sh: Shelf) => {
    const r = rate(sh);
    return r.a / (r.a + r.b);
  };

  const hidden = (sh: Shelf) => {
    const st = s.shelves[famOf(sh)];
    return Boolean(st?.hiddenUntil && st.hiddenUntil > now && sh.id !== "top");
  };
  const live = shelves.filter((sh) => !hidden(sh));
  // Con casi todo retirado, la portada se quedaría vacía: vuelven las que llevan más tiempo fuera, para probar otra vez.
  const back = shelves
    .filter(hidden)
    .sort((a, b) => (s.shelves[famOf(a)]!.hiddenUntil ?? 0) - (s.shelves[famOf(b)]!.hiddenUntil ?? 0))
    .slice(0, Math.max(0, 4 - live.length));
  live.push(...back);

  const pickFromGroup = (id: Shelf["id"], n: number) => {
    const group = live.filter((sh) => sh.id === id);
    // Las usadas primero; entre las demás, las que lleva más tiempo sin ver (rotación).
    const scored = group.map((sh) => {
      const st = s.shelves[famOf(sh)];
      const lastSeen = s.seenIn[famOf(sh)] ? (st?.last ?? 0) : 0;
      return { sh, v: betaSample(rate(sh).a, rate(sh).b, rand) - (now - lastSeen < DAY ? 0.15 : 0) };
    });
    return new Set(scored.sort((x, y) => y.v - x.v).slice(0, n).map((x) => x.sh));
  };
  const keepBecause = pickFromGroup("because", 2);
  const keepPeople = pickFromGroup("people", 1);
  const chosen = live.filter((sh) => (sh.id === "because" ? keepBecause.has(sh) : sh.id === "people" ? keepPeople.has(sh) : true));

  const shownElsewhere = new Set<string>();
  const arranged = chosen.map((sh) => {
    const k = (it: RecoItem) => `${it.type}:${it.id}`;
    const fresh = sh.items.filter((it) => fatigue(s, k(it), now) < FATIGUE_DROP);
    const pool = fresh.length >= 6 ? fresh : sh.items;
    // Puntuación de sesión: la del motor, menos el cansancio, con un poco de ruido (Gumbel) para que cambie el orden.
    const scored = pool
      .map((it, i) => {
        const gumbel = -Math.log(-Math.log(rand() || 1e-9) || 1e-9);
        return { it, v: (it.score || 1 - i / pool.length) - 0.06 * fatigue(s, k(it), now) + 0.035 * gumbel };
      })
      .sort((a, b) => b.v - a.v)
      .map((x) => x.it);
    // Lo que ya va en otras tiras, al final (menos repetición a la vista).
    let items = [...scored.filter((it) => !shownElsewhere.has(k(it))), ...scored.filter((it) => shownElsewhere.has(k(it)))];
    if (sh.id === "top") {
      // Primera portada: nunca una de las últimas aperturas.
      const firstIdx = items.findIndex((it, i) => i < 12 && !recentFirsts.has(k(it)));
      if (firstIdx > 0) items = [items[firstIdx], ...items.slice(0, firstIdx), ...items.slice(firstIdx + 1)];
    }
    items = items.slice(0, sh.id === "top" ? 20 : sizeFor(meanRate(sh)));
    items.slice(0, 6).forEach((it) => shownElsewhere.add(k(it)));
    return { ...sh, items };
  });

  const [first, ...rest] = arranged.sort((a, b) => (a.id === "today" ? -1 : b.id === "today" ? 1 : a.id === "top" ? -1 : b.id === "top" ? 1 : 0));
  const leading = first?.id === "today" ? [first, ...rest.filter((x) => x.id === "top")] : first ? [first] : [];
  const others = arranged.filter((x) => !leading.includes(x));
  const ordered = others
    .map((sh) => ({ sh, v: betaSample(rate(sh).a, rate(sh).b, rand) }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.sh);
  return [...leading, ...ordered];
}

/** Recuerda la primera portada que se enseñó en esta sesión, para no repetirla en las siguientes. */
export async function rememberFirst(profile: string, s: EngageState, firstKey: string | undefined, sessionId: string) {
  if (!firstKey || s.firsts[0] === firstKey || s.seenIn.__first === sessionId) return;
  s.firsts = [firstKey, ...s.firsts.filter((k) => k !== firstKey)].slice(0, RECENT_FIRSTS);
  s.seenIn.__first = sessionId;
  await saveEngage(profile, s);
}

// ---------- Micro-encuestas ----------

export interface SurveyOption {
  id: string;
  label: string;
}

export interface Survey {
  id: string;
  kind: "shelf" | "mood" | "rate" | "help";
  question: string;
  hint?: string;
  options: SurveyOption[];
  /** Para «rate»: el título por el que se pregunta. */
  item?: { key: string; title: string; poster: string | null };
}

/** Estados de ánimo → géneros de TMDB (pelis y series usan IDs distintos para algunos). */
export const MOODS: { id: string; label: string; genres: number[] }[] = [
  { id: "light", label: "😄 Algo ligero", genres: [35, 16, 10751] },
  { id: "tense", label: "😱 Tensión e intriga", genres: [53, 9648, 80, 27] },
  { id: "epic", label: "🚀 Aventura y épica", genres: [28, 12, 878, 14, 10759, 10765] },
  { id: "moving", label: "🥹 Que me emocione", genres: [18, 10749, 10402] },
  { id: "real", label: "🌍 Historias reales", genres: [99, 36, 10752] },
];

/**
 * El «agente» decide si toca preguntar algo en esta sesión y qué. Reglas:
 * nunca en la primera sesión, como mucho una pregunta por sesión, cada 2 sesiones y 30 h como mínimo,
 * y se prioriza lo que más información aporta (una tira que parece no gustar, una racha sin éxito, un visto sin nota).
 */
export function nextSurvey(
  s: EngageState,
  sessionId: string,
  ctx: { plural: boolean; unratedSeen: { key: string; title: string; poster: string | null }[] },
  now = Date.now(),
): Survey | null {
  if (s.survey.pending?.session === sessionId) return s.survey.pending.survey;
  const done = s.sessions.filter((x) => x.id !== sessionId);
  if (done.length < 1) return null;
  // Como mucho una pregunta por sesión.
  if (s.survey.lastSession === sessionId) return null;
  const sinceAsked = s.sessions.filter((x) => x.start > s.survey.lastAt).length;
  if (now - s.survey.lastAt < 30 * 3600_000 || (s.survey.lastAt && sinceAsked < 2)) return null;
  const asked = (id: string, within: number) => (s.survey.asked[id] ?? 0) > now - within;
  const os = ctx.plural ? "os" : "te";

  // 1. Una tira que lleva varias sesiones sin tocarse: mejor preguntar antes de retirarla.
  const doubtful = Object.entries(s.shelves)
    .filter(([fam, st]) => fam !== "top" && !st.keep && !(st.hiddenUntil && st.hiddenUntil > now) && st.streak >= 3 && st.e < 1)
    .sort((a, b) => b[1].streak - a[1].streak)[0];
  if (doubtful && !asked(`shelf:${doubtful[0]}`, 30 * DAY))
    return {
      id: `shelf:${doubtful[0]}`,
      kind: "shelf",
      question: `¿${ctx.plural ? "Os" : "Te"} interesa la tira «${doubtful[1].title}»?`,
      hint: `Vemos que ${ctx.plural ? "pasáis" : "pasas"} de largo. Con una respuesta ajustamos la portada.`,
      options: [
        { id: "keep", label: "Sí, quiero más" },
        { id: "hide", label: "No, quítala" },
      ],
    };

  // 2. Varias sesiones mirando sin guardar nada: preguntar qué apetece hoy.
  const lastTwo = done.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((x) => x.adds === 0) && !asked("mood", 3 * DAY))
    return {
      id: "mood",
      kind: "mood",
      question: `¿Qué ${os} apetece hoy?`,
      hint: "Ponemos arriba una tira con eso durante unas horas.",
      options: [...MOODS.map((m) => ({ id: m.id, label: m.label })), { id: "none", label: "Nada en concreto" }],
    };

  // 3. Algo marcado como visto sin valorar: la nota enseña mucho al algoritmo.
  const pending = ctx.unratedSeen.find((it) => !asked(`rate:${it.key}`, 60 * DAY));
  if (pending)
    return {
      id: `rate:${pending.key}`,
      kind: "rate",
      question: `¿Qué ${ctx.plural ? "os" : "te"} pareció «${pending.title}»?`,
      options: [
        { id: "love", label: "❤️ Me encantó" },
        { id: "like", label: "👍 Bien" },
        { id: "dislike", label: "👎 No me gustó" },
      ],
      item: pending,
    };

  // 4. Cada ~8 sesiones: ¿las recomendaciones ayudan a decidir?
  if (done.length >= 4 && !asked("help", 14 * DAY))
    return {
      id: "help",
      kind: "help",
      question: `¿${ctx.plural ? "Os" : "Te"} están ayudando las recomendaciones a decidir qué ver?`,
      options: [
        { id: "yes", label: "Sí, mucho" },
        { id: "some", label: "A veces" },
        { id: "no", label: "Poco" },
      ],
    };
  return null;
}

/** Apunta que se ha enseñado una pregunta: aunque no se responda, no vuelve a salir enseguida. */
export async function markAsked(profile: string, sessionId: string, survey: Survey, now = Date.now()) {
  const s = await getEngage(profile);
  s.survey.lastAt = now;
  s.survey.lastSession = sessionId;
  s.survey.asked[survey.id] = now;
  s.survey.pending = { session: sessionId, survey };
  await saveEngage(profile, s);
}

/** Aplica la respuesta a una encuesta (o que la cerró sin responder: `a = "dismiss"`). */
export async function answerSurvey(profile: string, sessionId: string, id: string, a: string, now = Date.now()): Promise<void> {
  const s = await getEngage(profile);
  s.survey.lastAt = now;
  s.survey.lastSession = sessionId;
  s.survey.asked[id] = now;
  s.survey.answers.push({ id, a, t: now });
  s.survey.pending = undefined;
  if (a !== "dismiss") {
    if (id.startsWith("shelf:")) {
      const st = s.shelves[id.slice(6)];
      if (st) {
        if (a === "keep") {
          st.keep = true;
          st.streak = 0;
          addInsight(s, "survey", `Nos dijiste que quieres más de «${st.title}»: se queda en tu portada.`, now);
        } else {
          st.hiddenUntil = now + 60 * DAY;
          addInsight(s, "survey", `Nos dijiste que «${st.title}» no te interesa: retirada.`, now);
        }
      }
    } else if (id === "mood") {
      const m = MOODS.find((x) => x.id === a);
      s.intent = m ? { label: m.label.replace(/^\S+\s/, ""), genres: m.genres, until: now + 12 * 3600_000 } : undefined;
      if (m) addInsight(s, "survey", `Te apetecía «${m.label.replace(/^\S+\s/, "").toLowerCase()}»: lo hemos puesto arriba unas horas.`, now);
    } else if (id === "help" && a === "no") {
      addInsight(s, "survey", "Nos dijiste que las recomendaciones te ayudan poco: estamos variando más las tiras.", now);
    }
  }
  await saveEngage(profile, s);
}

/** Tira «Para hoy: …» con lo que pidió en la encuesta de estado de ánimo, a partir de todas las estanterías. */
export function intentShelf(shelves: Shelf[], s: EngageState, now = Date.now()): Shelf | null {
  const it = s.intent;
  if (!it || it.until < now) return null;
  const seen = new Set<string>();
  const items = shelves
    .flatMap((sh) => sh.items)
    .filter((x) => x.genreIds?.some((g) => it.genres.includes(g)) && !seen.has(`${x.type}:${x.id}`) && seen.add(`${x.type}:${x.id}`))
    .sort((a, b) => b.score - a.score)
    .slice(0, 16)
    .map((x) => ({ ...x, reason: `Para hoy: ${it.label.toLowerCase()}` }));
  return items.length >= 4 ? { id: "today", key: "today", title: `Para hoy: ${it.label.toLowerCase()}`, items } : null;
}
