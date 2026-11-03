import "server-only";
import { kvGet, kvSet } from "../store";
import { tmdb } from "../tmdb";
import type { MediaType } from "../types";
import { aspects, bestExcerpt, clip, cleanText, detectLang, norm, sentences, sentiment } from "./text";
import type { CriticScores, Review } from "./types";

const UA = "QueVemos/1.0 (+https://que-vemos-tv.vercel.app; recomendador personal)";
const get = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10000), next: { revalidate: 86400 } } as RequestInit);

export interface TitleRef {
  type: MediaType;
  id: number;
  title: string;
  originalTitle: string;
  year: number | null;
  imdbId: string | null;
  wikidataId: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function titleRef(type: MediaType, id: number): Promise<TitleRef> {
  const raw = await tmdb<any>(`/${type}/${id}`, { language: "es-ES", append_to_response: "external_ids" }, 7 * 86400);
  const date: string | undefined = type === "movie" ? raw.release_date : raw.first_air_date;
  return {
    type,
    id,
    title: (type === "movie" ? raw.title : raw.name) ?? "",
    originalTitle: (type === "movie" ? raw.original_title : raw.original_name) ?? "",
    year: date ? Number(date.slice(0, 4)) || null : null,
    imdbId: raw.external_ids?.imdb_id ?? null,
    wikidataId: raw.external_ids?.wikidata_id ?? null,
  };
}

// ---------- TMDB: reseñas de usuarios ----------

export async function tmdbReviews(ref: TitleRef): Promise<Review[]> {
  const pages = await Promise.all(
    ["es-ES", "en-US"].map((language) => tmdb<any>(`/${ref.type}/${ref.id}/reviews`, { language }, 86400).catch(() => ({ results: [] }))),
  );
  const seen = new Set<string>();
  return pages
    .flatMap((p) => p.results ?? [])
    .filter((r: any) => !seen.has(r.id) && !!seen.add(r.id))
    // Fuera autopromoción y textos de una línea («¡visita mi web!»).
    .filter((r: any) => (r.content ?? "").length >= 120 && !/https?:\/\/|www\.|\.com\b/i.test((r.content ?? "").slice(0, 300)))
    .slice(0, 12)
    .map((r: any): Review => {
      const text = cleanText(r.content ?? "");
      const lang = detectLang(text);
      return {
        source: "tmdb",
        outlet: "TMDB",
        author: r.author_details?.username || r.author || null,
        excerpt: bestExcerpt(text),
        url: r.url ?? null,
        score: typeof r.author_details?.rating === "number" ? r.author_details.rating / 10 : null,
        sentiment: sentiment(text),
        lang,
        date: r.created_at?.slice(0, 10) ?? null,
        aspects: aspects(text),
      };
    });
}

// ---------- Wikipedia: sección de recepción crítica ----------

const RECEPTION = [/critical (response|reception)/i, /^recepci[oó]n cr[ií]tica/i, /^cr[ií]tica$/i, /^recepci[oó]n/i, /reception/i];

function receptionSection(extract: string): string {
  const parts = extract.split(/\n(={2,})\s*([^=\n]+?)\s*\1\n/);
  // parts = [intro, "==", título, texto, "===", título, texto…]
  const secs: { level: number; title: string; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 3) secs.push({ level: parts[i].length, title: parts[i + 1], text: parts[i + 2] ?? "" });
  for (const re of RECEPTION) {
    const i = secs.findIndex((s) => re.test(s.title));
    if (i < 0) continue;
    let text = secs[i].text;
    for (let j = i + 1; j < secs.length && secs[j].level > secs[i].level; j++) text += "\n" + secs[j].text;
    if (text.trim().length > 80) return text;
  }
  return "";
}

export async function wikipediaReviews(ref: TitleRef): Promise<{ reviews: Review[]; scores: CriticScores }> {
  if (!ref.wikidataId) return { reviews: [], scores: {} };
  const wd = await get(`https://www.wikidata.org/wiki/Special:EntityData/${ref.wikidataId}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const links = wd?.entities?.[ref.wikidataId]?.sitelinks ?? {};
  const scores: CriticScores = {};
  const reviews: Review[] = [];
  await Promise.all(
    (["es", "en"] as const).map(async (lang) => {
      const page = links[`${lang}wiki`]?.title;
      if (!page) return;
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(page)}`;
      const data = await get(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const extract: string = (Object.values(data?.query?.pages ?? {})[0] as any)?.extract ?? "";
      const text = cleanText(receptionSection(extract));
      if (!text) return;
      // Notas agregadas que suele citar la Wikipedia en inglés.
      const rt = text.match(/(\d{1,3})\s?% (?:of|approval|aprobaci)/i) ?? text.match(/approval rating of (\d{1,3})\s?%/i);
      const mc = text.match(/(?:Metacritic|metacritic)[^.]*?\b(\d{1,3}) out of 100/i) ?? text.match(/\b(\d{1,3}) out of 100[^.]*Metacritic/i);
      if (rt && /rotten/i.test(text)) scores.rt ??= Number(rt[1]);
      if (mc) scores.metacritic ??= Number(mc[1]);
      // Las dos frases con más opinión de la sección (suelen ser la valoración general y la de un crítico).
      // (Las frases de agregadores ya salen como notas: se buscan las de críticos con nombre.)
      const ss = sentences(text)
        .filter((s) => s.length < 400 && !/rotten tomatoes|metacritic|imdb|filmaffinity|agregador|aggregator|cinemascore/i.test(s))
        .map((s) => ({ s, v: Math.abs(sentiment(s)) + (/(critic|crític|praised|elogi|acclaim|aclam)/i.test(s) ? 0.6 : 0) }))
        .sort((a, b) => b.v - a.v)
        // En español se muestran más frases: la ficha solo enseña opiniones en castellano.
        .slice(0, lang === "es" ? 4 : 2);
      for (const { s } of ss)
        reviews.push({
          source: "wikipedia",
          outlet: `Wikipedia (${lang})`,
          author: null,
          excerpt: clip(s),
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, "_"))}`,
          score: null,
          sentiment: sentiment(s),
          lang,
          date: null,
          aspects: aspects(text),
        });
    }),
  );
  return { reviews, scores };
}

// ---------- OMDb: Rotten Tomatoes, Metacritic, IMDb ----------

export async function omdbScores(ref: TitleRef): Promise<CriticScores> {
  const key = process.env.OMDB_API_KEY?.trim();
  if (!key || !ref.imdbId) return {};
  const d = await get(`https://www.omdbapi.com/?apikey=${key}&i=${ref.imdbId}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!d || d.Response === "False") return {};
  const out: CriticScores = {};
  for (const r of d.Ratings ?? []) {
    if (r.Source === "Rotten Tomatoes") out.rt = parseInt(r.Value, 10);
    if (r.Source === "Metacritic") out.metacritic = parseInt(r.Value, 10);
  }
  if (d.imdbRating && d.imdbRating !== "N/A") out.imdb = Number(d.imdbRating);
  if (d.Metascore && d.Metascore !== "N/A") out.metacritic ??= Number(d.Metascore);
  return out;
}

// ---------- Reddit ----------

const SUBS: Record<MediaType, string> = {
  movie: "movies+TrueFilm+flicks+documentaries+horror+criterion+peliculas+cine",
  tv: "television+TrueTelevision+documentaries+series+netflix+HBO",
};

async function redditToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID?.trim();
  const secret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  const cached = await kvGet<string>("reddit:token");
  if (cached) return cached;
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: "grant_type=client_credentials",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  const d = res?.ok ? await res.json() : null;
  if (!d?.access_token) return null;
  await kvSet("reddit:token", d.access_token, Math.max(60, (d.expires_in ?? 3600) - 120));
  return d.access_token;
}

/** Hilos de discusión del título y sus comentarios más votados. */
export async function redditReviews(ref: TitleRef): Promise<Review[]> {
  const token = await redditToken();
  if (!token) return [];
  const api = (path: string) =>
    get(`https://oauth.reddit.com${path}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const name = ref.originalTitle || ref.title;
  const q = `title:"${name.replace(/"/g, "")}"${ref.year ? ` ${ref.year}` : ""}`;
  const search = await api(`/r/${SUBS[ref.type]}/search?q=${encodeURIComponent(q)}&restrict_sr=1&sort=relevance&t=all&limit=10&raw_json=1`);
  const want = norm(name);
  const threads = ((search?.data?.children ?? []) as any[])
    .map((c) => c.data)
    .filter((p) => p && norm(p.title).includes(want) && p.num_comments >= 10)
    // Primero los hilos de discusión oficiales («Official Discussion», «Review»…), luego por comentarios.
    .sort((a, b) => Number(/discussion|review|thoughts|opini/i.test(b.title)) - Number(/discussion|review|thoughts|opini/i.test(a.title)) || b.num_comments - a.num_comments)
    .slice(0, 2);
  const out: Review[] = [];
  for (const t of threads) {
    const data = await api(`/comments/${t.id}?sort=top&limit=12&depth=1&raw_json=1`);
    const comments = ((data?.[1]?.data?.children ?? []) as any[])
      .map((c) => c.data)
      .filter((c) => c?.body && !c.stickied && c.score >= 5 && c.author !== "AutoModerator" && c.body.length > 60)
      .slice(0, 6);
    for (const c of comments) {
      const text = cleanText(c.body);
      out.push({
        source: "reddit",
        outlet: `r/${t.subreddit}`,
        author: c.author ? `u/${c.author}` : null,
        excerpt: bestExcerpt(text),
        url: `https://www.reddit.com${c.permalink}`,
        score: null,
        sentiment: sentiment(text),
        lang: detectLang(text),
        date: c.created_utc ? new Date(c.created_utc * 1000).toISOString().slice(0, 10) : null,
        votes: c.score,
        aspects: aspects(text),
      });
    }
  }
  return out;
}
