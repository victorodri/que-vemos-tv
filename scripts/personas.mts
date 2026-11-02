// Personas sintéticas para la evaluación offline del recomendador.
// Cada una tiene un gusto OCULTO u(item) definido sobre rasgos reales de TMDB y unas prefs de cuestionario
// coherentes (lo que contestaría en el onboarding). u ≥ LIKE ⇒ le gusta; u ≥ LOVE ⇒ le encanta.
import type { Prefs } from "../src/lib/prefs";
import type { MediaType } from "../src/lib/types";

export const LIKE = 1.0;
export const LOVE = 2.0;
export const DISLIKE = -0.3;

/** Lo mínimo que la utilidad necesita de un título. */
export interface ItemView {
  key: string;
  type: MediaType;
  title: string;
  year: number | null;
  genreIds: number[];
  /** Claves de rasgos presentes (g:, k:, c:, p:, d:, l:, t:, r:). */
  fkeys: string[];
  labels: Record<string, string>;
  rating: number | null;
  voteCount: number;
  popularity: number;
}

export interface Persona {
  id: string;
  name: string;
  types: MediaType[];
  prefs: Prefs;
  /** Pesos ocultos por género (ids de pelis y series). */
  genres: Record<number, number>;
  /** Temas (regex sobre las palabras clave de TMDB, que vienen en inglés). */
  keywords?: { re: RegExp; w: number };
  /** Personas (regex sobre nombres de dirección/creación y reparto). */
  people?: { re: RegExp; w: number };
  extra?: (it: ItemView) => number;
}

const labelsOf = (it: ItemView, prefix: string) => Object.entries(it.labels).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
const has = (it: ItemView, k: string) => it.fkeys.includes(k);
const q = (it: ItemView, center = 7, w = 0.6) => (it.rating ? (it.rating - center) * w : 0);

export function utility(p: Persona, it: ItemView): number {
  let u = 0;
  // Géneros: se promedia lo que aportan para no premiar títulos con 6 géneros.
  const gs = it.genreIds.map((g) => p.genres[g] ?? 0);
  if (gs.length) {
    const pos = gs.filter((x) => x > 0);
    const neg = gs.filter((x) => x < 0);
    u += (pos.length ? Math.max(...pos) + 0.3 * (pos.reduce((a, b) => a + b, 0) - Math.max(...pos)) : 0) + neg.reduce((a, b) => a + b, 0);
  }
  if (p.keywords) {
    const hits = labelsOf(it, "k:").filter((l) => p.keywords!.re.test(l)).length;
    u += Math.min(2, hits) * p.keywords.w;
  }
  if (p.people) {
    const hits = [...labelsOf(it, "c:"), ...labelsOf(it, "p:")].filter((l) => p.people!.re.test(l)).length;
    u += Math.min(1, hits) * p.people.w;
  }
  if (p.extra) u += p.extra(it);
  return u;
}

/** Peso oculto de un rasgo concreto (para juzgar si una explicación cita algo que de verdad le gusta). */
export function featureLiked(p: Persona, key: string, label: string | undefined): boolean {
  if (key.startsWith("g:")) return (p.genres[Number(key.slice(2))] ?? 0) > 0;
  if (key.startsWith("k:")) return !!label && !!p.keywords?.re.test(label);
  if (key.startsWith("c:") || key.startsWith("p:")) return !!label && !!p.people?.re.test(label);
  return false;
}

const base: Omit<Prefs, "likes" | "avoid" | "types"> = { runtime: "any", era: "any", quality: "good", discovery: "mix" };

export const PERSONAS: Persona[] = [
  {
    id: "p-scifi",
    name: "Sci-fi cerebral (Nolan/Villeneuve)",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["scifi", "thriller", "action"], avoid: ["romance", "horror"] },
    genres: { 878: 1.5, 10765: 1.5, 12: 0.4, 53: 0.5, 9648: 0.4, 28: 0.2, 10749: -1, 35: -0.4, 27: -0.8, 10751: -0.6, 16: -0.3 },
    keywords: { re: /space|time travel|artificial intelligence|dystopia|alien|future|robot|time loop|virtual reality/i, w: 0.5 },
    people: { re: /Christopher Nolan|Denis Villeneuve|Ridley Scott|James Cameron|Alex Garland/i, w: 1 },
    extra: (it) => q(it, 7, 0.5),
  },
  {
    id: "p-romcom",
    name: "Comedia romántica ligera",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["comedy", "romance"], avoid: ["horror", "thriller"], runtime: "normal", era: "modern" },
    genres: { 10749: 1.3, 35: 1.0, 18: 0.3, 10402: 0.4, 27: -1.5, 53: -0.7, 878: -0.4, 28: -0.5, 80: -0.5, 10752: -0.8 },
    keywords: { re: /romance|love|wedding|friendship|romantic comedy|dating|new york/i, w: 0.4 },
    extra: (it) => (has(it, "r:short") ? 0.3 : has(it, "r:long") ? -0.4 : 0) + (it.year && it.year < 1995 ? -0.4 : 0) + q(it, 6.8, 0.3),
  },
  {
    id: "p-eurocrime",
    name: "Thriller/crimen europeo y en español",
    types: ["movie", "tv"],
    prefs: { ...base, types: ["movie", "tv"], likes: ["crime", "thriller"], avoid: ["animation", "family"], discovery: "hidden" },
    genres: { 80: 1.2, 53: 0.8, 9648: 0.6, 18: 0.3, 16: -1, 10751: -1, 35: -0.3, 10762: -1.2, 878: -0.3 },
    keywords: { re: /police|detective|murder|heist|investigation|corruption|drug/i, w: 0.3 },
    extra: (it) => {
      const lang = it.fkeys.find((k) => k.startsWith("l:"))?.slice(2);
      return (lang === "es" ? 1.0 : ["fr", "it", "de", "da", "sv", "no", "pt", "nl", "pl"].includes(lang ?? "") ? 0.7 : lang === "en" ? -0.2 : 0) + q(it, 7, 0.4);
    },
  },
  {
    id: "p-family",
    name: "Animación y familiar",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["animation", "family"], avoid: ["horror", "thriller", "crime"], runtime: "short" },
    genres: { 16: 1.5, 10751: 1.0, 12: 0.4, 35: 0.4, 14: 0.3, 27: -2, 53: -0.8, 80: -0.8, 18: -0.3, 10752: -1 },
    extra: (it) => q(it, 6.8, 0.4),
  },
  {
    id: "p-docs",
    name: "Documentales y true crime",
    types: ["movie", "tv"],
    prefs: { ...base, types: ["movie", "tv"], likes: ["documentary", "crime"], avoid: ["animation", "romance"] },
    genres: { 99: 1.8, 80: 0.4, 36: 0.4, 10749: -0.6, 16: -0.6, 878: -0.5, 10765: -0.5, 14: -0.5, 10751: -0.5 },
    keywords: { re: /true crime|serial killer|investigation|based on true story|biography|murder|documentary|interview/i, w: 0.5 },
    extra: (it) => q(it, 7, 0.3),
  },
  {
    id: "p-horror",
    name: "Terror de autor (joyas)",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["horror", "thriller"], avoid: ["family", "animation", "romance"], quality: "top", discovery: "hidden" },
    genres: { 27: 1.5, 53: 0.6, 9648: 0.5, 35: -0.5, 10751: -1.2, 16: -1, 10749: -0.6, 28: -0.2 },
    keywords: { re: /supernatural|haunted|psychological|cult|folk horror|possession|slasher|ghost/i, w: 0.35 },
    extra: (it) => q(it, 6.6, 0.8) + (it.voteCount < 3000 ? 0.4 : 0),
  },
  {
    id: "p-classics",
    name: "Cinéfilo de clásicos y joyas ocultas",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["drama", "crime", "history"], avoid: ["animation"], quality: "top", discovery: "hidden" },
    genres: { 18: 0.6, 80: 0.5, 37: 0.4, 36: 0.4, 10752: 0.3, 16: -0.3, 10751: -0.6, 28: -0.3, 27: -0.3 },
    keywords: { re: /superhero|based on comic/i, w: -1 },
    extra: (it) => {
      const y = it.year ?? 2020;
      return (y < 1980 ? 1.0 : y < 1990 ? 0.6 : y < 2000 ? 0.3 : y >= 2020 ? -0.5 : 0) + q(it, 7, 1.0) + (it.voteCount < 5000 ? 0.3 : 0);
    },
  },
];

/** Pareja con gustos parcialmente opuestos (acción vs drama romántico). Ids fijos porque el motor solo arma «pareja» con victor+alba. */
export const COUPLE: { a: Persona; b: Persona; prefs: Prefs } = {
  a: {
    id: "victor",
    name: "Pareja · A: acción/aventura",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["action", "scifi", "thriller"], avoid: ["romance"] },
    genres: { 28: 1.5, 12: 0.6, 878: 0.5, 53: 0.4, 35: 0.2, 10749: -0.8, 18: -0.2, 27: -0.4 },
    extra: (it) => q(it, 7, 0.4),
  },
  b: {
    id: "alba",
    name: "Pareja · B: drama romántico",
    types: ["movie"],
    prefs: { ...base, types: ["movie"], likes: ["romance", "drama", "comedy"], avoid: ["horror", "action"] },
    genres: { 10749: 1.3, 18: 1.0, 35: 0.4, 10402: 0.3, 28: -0.8, 27: -1.5, 878: -0.3, 10752: -0.5 },
    extra: (it) => q(it, 7, 0.4),
  },
  prefs: { ...base, types: ["movie"], likes: ["comedy", "romance", "action", "drama"], avoid: ["horror"] },
};

export const coupleUtility = (it: ItemView) => Math.min(utility(COUPLE.a, it), utility(COUPLE.b, it));
