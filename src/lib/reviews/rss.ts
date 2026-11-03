import "server-only";
import { createHash } from "crypto";
import { kvGet, kvMGet, kvSet } from "../store";
import { aspects, bestExcerpt, cleanText, norm, sentiment } from "./text";
import type { Review } from "./types";

// Blogs y medios de crítica. Sus RSS solo traen lo último (10-60 entradas), así que el cron diario los lee y va
// guardando cada entrada bajo el nombre del título que comenta: la hemeroteca crece sola con el tiempo.
// `name`: cómo sacar el título comentado del titular. «quoted» = lo que va entre comillas, «whole» = todo el titular
// (feeds que solo publican críticas con el título de la obra), «critica» = «Crítica | X» o «Crítica de X».
const FEEDS: { outlet: string; url: string; lang: "es" | "en"; name: ("quoted" | "whole" | "critica" | "colon")[] }[] = [
  { outlet: "Espinof", url: "https://www.espinof.com/feedburner.xml", lang: "es", name: ["critica", "quoted"] },
  { outlet: "El Antepenúltimo Mohicano", url: "http://feeds.feedburner.com/ElAntepenultimoMohicano", lang: "es", name: ["critica", "quoted"] },
  { outlet: "El Mundo", url: "https://www.elmundo.es/rss/cultura/cine.xml", lang: "es", name: ["colon", "quoted"] },
  { outlet: "El País", url: "https://feeds.elpais.com/mrss-s/list/ep/site/elpais.com/section/cultura/subsection/cine", lang: "es", name: ["quoted"] },
  { outlet: "Fotogramas", url: "https://www.fotogramas.es/rss/all.xml/", lang: "es", name: ["critica", "quoted"] },
  { outlet: "RogerEbert.com", url: "https://www.rogerebert.com/reviews/feed", lang: "en", name: ["whole"] },
  { outlet: "Variety", url: "https://variety.com/c/reviews/feed/", lang: "en", name: ["quoted"] },
  { outlet: "The Hollywood Reporter", url: "https://www.hollywoodreporter.com/c/movies/movie-reviews/feed/", lang: "en", name: ["quoted"] },
  { outlet: "IndieWire", url: "https://www.indiewire.com/c/criticism/feed/", lang: "en", name: ["quoted"] },
  { outlet: "Slant", url: "https://www.slantmagazine.com/feed/", lang: "en", name: ["quoted"] },
  { outlet: "AV Club", url: "https://www.avclub.com/rss.xml", lang: "en", name: ["quoted"] },
];

const PER_TITLE = 8;
const TTL = 400 * 24 * 3600;
const nameKey = (n: string) => `rss:t:${n}`;

interface RssItem {
  title: string;
  link: string;
  date: string | null;
  text: string;
}

function parseFeed(xml: string): RssItem[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
  const tag = (b: string, t: string) => b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "";
  return blocks.map((b) => ({
    title: cleanText(tag(b, "title")),
    link: cleanText(tag(b, "link")) || b.match(/<link[^>]*href="([^"]+)"/)?.[1] || "",
    date: cleanText(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated")) || null,
    text: cleanText(tag(b, "content:encoded") || tag(b, "description") || tag(b, "summary") || tag(b, "content")),
  }));
}

/** Títulos de obra que comenta un titular (puede haber varios: «‘A’ y ‘B’…»). */
export function namesIn(headline: string, modes: (typeof FEEDS)[number]["name"]): string[] {
  const out = new Set<string>();
  for (const m of modes) {
    if (m === "whole") out.add(headline);
    if (m === "critica") {
      const x = headline.match(/^cr[ií]tica\s*(?:[|:–-]|de)\s*['"‘“«]?([^'"’”»|:(]+)/i)?.[1];
      if (x) out.add(x);
    }
    if (m === "colon") {
      // El Mundo: «Karateka: Dar mito, pulir mito (***)».
      const x = headline.match(/^([^:]{2,60}):.*\(\*+\)\s*$/)?.[1];
      if (x) out.add(x);
    }
    if (m === "quoted") for (const q of headline.matchAll(/[‘'"“«]([^‘’'"“”«»]{2,70})[’'"”»]/g)) out.add(q[1]);
  }
  return [...out].map(norm).filter((n) => n.length >= 4 && n.split(" ").length <= 10);
}

const isReview = (headline: string) => /cr[ií]tica|review|an[aá]lisis|\(\*+\)/i.test(headline);
const stars = (headline: string) => {
  const m = headline.match(/\((\*{1,5})\)\s*$/);
  return m ? m[1].length / 5 : null;
};

/** Lee todos los feeds y guarda sus entradas por título comentado. Devuelve cuántas entradas nuevas. */
export async function ingestFeeds(): Promise<{ feeds: number; added: number }> {
  const seenLinks = new Set((await kvGet<string[]>("rss:links")) ?? []);
  const byName = new Map<string, Review[]>();
  let feeds = 0;
  await Promise.all(
    FEEDS.map(async (f) => {
      const xml = await fetch(f.url, { headers: { "user-agent": "QueVemos/1.0 (+https://que-vemos-tv.vercel.app)" }, cache: "no-store", signal: AbortSignal.timeout(12000) })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      if (!xml) return;
      feeds++;
      for (const it of parseFeed(xml)) {
        if (!it.link || seenLinks.has(hash(it.link))) continue;
        const names = namesIn(it.title, f.name);
        if (!names.length) continue;
        seenLinks.add(hash(it.link));
        const body = it.text || it.title;
        const r: Review = {
          source: "rss",
          outlet: f.outlet,
          author: null,
          excerpt: bestExcerpt(body.length > 40 ? body : it.title),
          url: it.link,
          score: stars(it.title),
          sentiment: sentiment(it.title + ". " + body),
          lang: f.lang,
          date: it.date ? new Date(it.date).toISOString().slice(0, 10) : null,
          votes: isReview(it.title) ? 1 : 0,
          aspects: aspects(it.title + ". " + body),
        };
        for (const n of names) byName.set(n, [...(byName.get(n) ?? []), r]);
      }
    }),
  );
  const names = [...byName.keys()];
  const prev = await kvMGet<Review[]>(names.map(nameKey));
  await Promise.all(names.map((n, i) => kvSet(nameKey(n), [...byName.get(n)!, ...(prev[i] ?? [])].slice(0, PER_TITLE), TTL)));
  await kvSet("rss:links", [...seenLinks].slice(-8000), TTL);
  return { feeds, added: [...byName.values()].reduce((s, x) => s + x.length, 0) };
}

const hash = (s: string) => createHash("sha1").update(s).digest("base64url").slice(0, 12);

/** Entradas de blogs sobre un título (por su nombre en español o el original). */
export async function rssReviews(names: string[]): Promise<Review[]> {
  const keys = [...new Set(names.map(norm).filter((n) => n.length >= 4))];
  if (!keys.length) return [];
  const found = await kvMGet<Review[]>(keys.map(nameKey)).catch(() => []);
  const seen = new Set<string>();
  return found.flat().filter((r): r is Review => !!r && !seen.has(r.url ?? "") && !!seen.add(r.url ?? ""));
}
