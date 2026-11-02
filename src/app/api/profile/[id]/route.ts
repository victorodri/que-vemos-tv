import { after, NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { errorResponse } from "@/lib/api";
import { sanitizePrefs } from "@/lib/prefs";
import { hashOf } from "@/lib/client";
import { DEFAULT_FILTERS, filtersToParams, paramsToFilters } from "@/lib/filters";
import { coupleRetrainAfter, retrain } from "@/lib/reco/model";
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
    lastFilters: body.lastFilters && typeof body.lastFilters === "object" ? paramsToFilters(filtersToParams({ ...DEFAULT_FILTERS, ...body.lastFilters })) : null,
    prefs: sanitizePrefs(body.prefs),
    feedback: {}, // las valoraciones solo se escriben por /api/feedback
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
    const prev = await getProfile(id);
    await saveProfile(id, data);
    // Solo lista, vistos, gustos y plataformas entrenan el modelo: cambiar filtros no lo reentrena
    // (ni invalida la caché de «Para ti»).
    const trainingInputs = (p: ProfileData) => hashOf([p.watchlist.map((t) => `${t.type}:${t.id}`), p.seen, p.prefs, p.platforms]);
    if (trainingInputs(prev) !== trainingInputs(data)) {
      after(() => retrain(id).catch((e) => console.error("retrain", e)));
      coupleRetrainAfter(id, after);
    }
    return NextResponse.json({ ...data, feedback: prev.feedback });
  } catch (err) {
    return errorResponse(err);
  }
}
