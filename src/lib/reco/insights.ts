import "server-only";
import { getMeta } from "../profiles";
import { TAG_LABEL } from "../reviews/types";
import { getProfile } from "../store";
import { getGenres } from "../tmdb";
import { getEngage, type Insight } from "./engagement";
import { getManyFeatures } from "./features";
import { getTaste } from "./model";

// «Lo que hemos aprendido de ti»: el vector de gustos y el uso de la app traducidos a frases y cifras.
// Todo sale de datos del propio perfil; nada se inventa.

export interface Trait {
  label: string;
  /** -1..1 relativo al rasgo más fuerte de su grupo. */
  weight: number;
}

export interface ProfileInsights {
  summary: string[];
  likes: { group: string; traits: Trait[] }[];
  avoids: Trait[];
  shelves: { title: string; rate: number; views: number; hidden: boolean }[];
  kpis: { label: string; value: string; hint?: string }[];
  log: Insight[];
  counts: { love: number; like: number; dislike: number; notInterested: number; seen: number; list: number };
}

const LANG: Record<string, string> = {
  en: "inglés", es: "español", fr: "francés", it: "italiano", de: "alemán", ja: "japonés", ko: "coreano", da: "danés",
  sv: "sueco", no: "noruego", pt: "portugués", zh: "chino", hi: "hindi", tr: "turco", ca: "catalán", nl: "neerlandés", pl: "polaco",
};
const RUNTIME: Record<string, string> = { short: "duración corta", medium: "duración media", long: "duración larga" };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const fmtTime = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`);

export async function getInsights(profileId: string): Promise<ProfileInsights> {
  const [data, taste, engage, meta, gm, gt] = await Promise.all([
    getProfile(profileId),
    getTaste(profileId),
    getEngage(profileId),
    getMeta(profileId),
    getGenres("movie").catch(() => []),
    getGenres("tv").catch(() => []),
  ]);
  const plural = meta?.kind === "couple";
  const genreName = new Map([...gm, ...gt].map((g) => [String(g.id), g.name]));

  // Nombres de temas y personas: de los títulos que ha valorado o guardado.
  const fb = Object.entries(data.feedback);
  const sample = [...fb.sort((a, b) => b[1].t - a[1].t).map(([k]) => k), ...data.watchlist.map((w) => `${w.type}:${w.id}`)].slice(0, 60);
  const feats = await getManyFeatures(sample).catch(() => new Map());
  const labels = new Map<string, string>();
  for (const f of feats.values()) for (const [k, v] of Object.entries(f.labels ?? {})) labels.set(k, v as string);

  const name = (k: string): string | null => {
    const [fam, v] = [k.slice(0, 1), k.slice(2)];
    if (fam === "g") return genreName.get(v) ?? null;
    if (fam === "a") return TAG_LABEL[v as keyof typeof TAG_LABEL] ?? null;
    if (fam === "d") return `años ${v.slice(2)}`;
    if (fam === "l") return LANG[v] ? `en ${LANG[v]}` : null;
    if (fam === "r") return RUNTIME[v] ?? null;
    if (fam === "t") return v === "movie" ? "películas" : "series";
    return labels.get(k) ?? null;
  };

  const GROUPS: [string, string[]][] = [
    ["Géneros", ["g"]],
    ["Temas", ["k"]],
    ["Lo que destacas de una historia", ["a"]],
    ["Directores y creadores", ["c"]],
    ["Reparto", ["p"]],
    ["Épocas e idiomas", ["d", "l"]],
  ];
  const entries = Object.entries(taste.w).filter(([k]) => name(k));
  const likes = GROUPS.map(([group, fams]) => {
    const list = entries.filter(([k, w]) => fams.includes(k[0]) && w > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = list[0]?.[1] || 1;
    return { group, traits: list.map(([k, w]) => ({ label: name(k)!, weight: Math.round((w / max) * 100) / 100 })) };
  }).filter((g) => g.traits.length);
  const neg = entries.filter(([k, w]) => w < 0 && ["g", "k", "a"].includes(k[0])).sort((a, b) => a[1] - b[1]).slice(0, 6);
  const negMax = Math.abs(neg[0]?.[1] ?? 1) || 1;
  const avoids = neg.map(([k, w]) => ({ label: name(k)!, weight: Math.round((w / negMax) * 100) / 100 }));

  // Uso de las tiras.
  const now = Date.now();
  const shelves = Object.entries(engage.shelves)
    .filter(([, s]) => s.v >= 0.5 && s.title)
    .map(([, s]) => ({ title: s.title, rate: Math.round((s.e / Math.max(s.v, 1)) * 100) / 100, views: Math.round(s.v), hidden: Boolean(s.hiddenUntil && s.hiddenUntil > now) }))
    .sort((a, b) => b.rate - a.rate || b.views - a.views)
    .slice(0, 10);

  // Métricas clave: encontrar algo rápido y guardarlo en la lista.
  const recent = engage.sessions.filter((s) => s.start > now - 30 * 86400_000);
  const withAdd = recent.filter((s) => s.adds > 0);
  const ttAdd = median(withAdd.map((s) => s.firstAddMs ?? 0).filter(Boolean));
  const ttOpen = median(recent.map((s) => s.firstOpenMs ?? 0).filter(Boolean));
  const help = engage.survey.answers.filter((a) => a.id === "help" && a.a !== "dismiss");
  const kpis: ProfileInsights["kpis"] = [
    { label: "Aperturas (30 días)", value: String(recent.length) },
    { label: "Aperturas en las que guardaste algo", value: recent.length ? `${Math.round((withAdd.length / recent.length) * 100)} %` : "—", hint: "Objetivo: más del 50 %" },
    { label: "Tiempo hasta guardar el primero", value: ttAdd != null ? fmtTime(ttAdd) : "—", hint: "Mediana. Objetivo: menos de 2 min" },
    { label: "Tiempo hasta abrir la primera ficha", value: ttOpen != null ? fmtTime(ttOpen) : "—" },
    { label: "Títulos guardados por apertura", value: recent.length ? (recent.reduce((s, x) => s + x.adds, 0) / recent.length).toFixed(1) : "—" },
  ];
  if (help.length) kpis.push({ label: "¿Te ayudan las recomendaciones?", value: { yes: "Sí, mucho", some: "A veces", no: "Poco" }[help[help.length - 1].a] ?? "—", hint: "Tu última respuesta" });

  const counts = {
    love: fb.filter(([, v]) => v.s === "love").length,
    like: fb.filter(([, v]) => v.s === "like").length,
    dislike: fb.filter(([, v]) => v.s === "dislike").length,
    notInterested: fb.filter(([, v]) => v.s === "not_interested").length,
    seen: data.seen.length,
    list: data.watchlist.length,
  };

  // Conclusiones en frases.
  const summary: string[] = [];
  const te = plural ? "os" : "te";
  const g = likes.find((x) => x.group === "Géneros")?.traits.slice(0, 3).map((t) => t.label.toLowerCase());
  if (g?.length) summary.push(`Lo que más ${te} engancha: ${g.join(", ")}.`);
  const a = likes.find((x) => x.group.startsWith("Lo que destacas"))?.traits.slice(0, 3).map((t) => t.label.toLowerCase());
  if (a?.length) summary.push(`Valoras historias ${a.join(", ")}.`);
  const k = likes.find((x) => x.group === "Temas")?.traits.slice(0, 3).map((t) => t.label);
  if (k?.length) summary.push(`Temas que se repiten en lo que ${plural ? "os gusta" : "te gusta"}: ${k.join(", ")}.`);
  const c = likes.find((x) => x.group === "Directores y creadores")?.traits[0];
  if (c) summary.push(`${c.label} es de ${plural ? "vuestros" : "tus"} nombres de cabecera.`);
  const tv = taste.w["t:tv"] ?? 0, mv = taste.w["t:movie"] ?? 0;
  if (Math.abs(tv - mv) > 0.05) summary.push(tv > mv ? `Últimamente ${plural ? "tiráis" : "tiras"} más de series que de películas.` : `${plural ? "Preferís" : "Prefieres"} películas antes que series.`);
  if (avoids.length) summary.push(`Lo que ${plural ? "evitáis" : "evitas"}: ${avoids.slice(0, 3).map((t) => t.label.toLowerCase()).join(", ")}.`);
  const best = shelves.find((s) => s.rate >= 0.4 && s.views >= 2);
  if (best) summary.push(`La tira que más ${plural ? "usáis" : "usas"}: «${best.title}».`);
  if (taste.signals < 10) summary.push(`Aún ${plural ? "nos dais" : "nos das"} pocas pistas (${taste.signals} señales): cada valoración afina mucho.`);

  return { summary, likes, avoids, shelves, kpis, log: [...engage.insights].reverse().slice(0, 12), counts };
}
