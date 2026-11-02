import { NextRequest, NextResponse } from "next/server";
import { errorResponse, loadProfile } from "@/lib/api";
import { paramsToFilters } from "@/lib/filters";
import { discover, search, withProviders } from "@/lib/tmdb";

// GET /api/titles?type=movie&genre=..&runtime=..&rating=..&year=..&mine=1&q=..&page=1&profile=victor
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const f = paramsToFilters(sp);
  const page = Math.min(Math.max(Number(sp.get("page")) || 1, 1), 500);
  try {
    const profile = await loadProfile(sp.get("profile"));
    const platforms = f.onlyMine ? (profile?.platforms ?? []) : [];
    const result = f.query ? await search(f, page) : await discover(f, page, { platforms, prefs: profile?.prefs });
    let items = await withProviders(result.items);
    if (f.query && platforms.length) {
      items = items.filter((t) => t.providers?.some((p) => platforms.includes(p.id)));
    }
    return NextResponse.json({ ...result, items });
  } catch (err) {
    return errorResponse(err);
  }
}
