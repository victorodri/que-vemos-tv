import { NextRequest, NextResponse } from "next/server";
import { errorResponse, loadProfile } from "@/lib/api";
import { paramsToFilters } from "@/lib/filters";
import { discover, getDetail } from "@/lib/tmdb";
import { titleKey } from "@/lib/types";

// Solo se sortea entre las primeras páginas por popularidad, para no proponer rarezas.
const MAX_PAGES = 20;
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

// GET /api/surprise?<filtros>&profile=victor&skip=movie:1,tv:2
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const f = { ...paramsToFilters(sp), query: "" };
  try {
    const profile = await loadProfile(sp.get("profile"));
    const opts = { platforms: f.onlyMine ? (profile?.platforms ?? []) : [], prefs: profile?.prefs };
    const excluded = new Set([...(profile?.seen ?? []), ...(sp.get("skip")?.split(",") ?? [])]);

    const first = await discover(f, 1, opts);
    if (first.totalResults === 0) return NextResponse.json({ item: null, reason: "empty" });
    const pages = Math.min(first.totalPages, MAX_PAGES);

    // Varias páginas al azar; si todas están vistas, se recorre en orden.
    const order = [...new Set([randInt(1, pages), randInt(1, pages), randInt(1, pages)])];
    for (let p = 1; p <= pages && order.length < 8; p++) if (!order.includes(p)) order.push(p);

    for (const page of order) {
      const data = page === 1 ? first : await discover(f, page, opts);
      const candidates = data.items.filter((t) => !excluded.has(titleKey(t)));
      if (candidates.length) {
        const pick = candidates[randInt(0, candidates.length - 1)];
        return NextResponse.json({ item: await getDetail(pick.type, pick.id) });
      }
    }
    return NextResponse.json({ item: null, reason: "exhausted" });
  } catch (err) {
    return errorResponse(err);
  }
}
