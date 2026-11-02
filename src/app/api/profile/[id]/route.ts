import { NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { errorResponse } from "@/lib/api";
import { emptyProfile, getProfile, saveProfile } from "@/lib/store";
import type { ProfileData } from "@/lib/types";

export const dynamic = "force-dynamic";

const LIMIT = 2000;

/** Normaliza lo que llega del cliente para no guardar basura. */
function sanitize(body: Partial<ProfileData>): ProfileData {
  const base = emptyProfile();
  return {
    watchlist: Array.isArray(body.watchlist)
      ? body.watchlist
          .filter((t) => t && (t.type === "movie" || t.type === "tv") && Number.isInteger(t.id))
          .slice(0, LIMIT)
          .map(({ id, type, title, year, rating, overview, poster }) => ({
            id,
            type,
            title: String(title ?? "").slice(0, 300),
            year: year ?? null,
            rating: rating ?? null,
            overview: String(overview ?? "").slice(0, 2000),
            poster: poster ?? null,
          }))
      : base.watchlist,
    seen: Array.isArray(body.seen) ? body.seen.filter((k) => /^(movie|tv):\d+$/.test(k)).slice(0, LIMIT * 5) : base.seen,
    platforms: Array.isArray(body.platforms) ? body.platforms.filter(Number.isInteger).slice(0, 50) : base.platforms,
    lastFilters: body.lastFilters ?? null,
  };
}

export async function GET(_req: Request, ctx: RouteContext<"/api/profile/[id]">) {
  const { id } = await ctx.params;
  if (!isProfileId(id)) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });
  try {
    return NextResponse.json(await getProfile(id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request, ctx: RouteContext<"/api/profile/[id]">) {
  const { id } = await ctx.params;
  if (!isProfileId(id)) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });
  try {
    const data = sanitize(await req.json());
    await saveProfile(id, data);
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
