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

/**
 * Fechas de «visto»: solo para claves que siguen en `seen`. Se conservan las que ya había (un cliente antiguo
 * que no envía `seenAt` no las borra) y lo que se marca nuevo sin fecha recibe la de ahora.
 */
function sanitizeSeenAt(seen: string[], incoming: unknown, prev: ProfileData): Record<string, number> {
  const now = Date.now();
  const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= now + 86400000;
  const fromClient = incoming && typeof incoming === "object" ? (incoming as Record<string, unknown>) : {};
  const prevSeen = new Set(prev.seen);
  const out: Record<string, number> = {};
  for (const k of seen) {
    const c = fromClient[k];
    const p = prev.seenAt?.[k];
    if (valid(c)) out[k] = Math.round(c);
    else if (valid(p)) out[k] = p;
    else if (!prevSeen.has(k)) out[k] = now;
  }
  return out;
}

/** Normaliza lo que llega del cliente para no guardar basura. */
function sanitize(body: Partial<ProfileData>, prev: ProfileData): ProfileData {
  const base = emptyProfile();
  const seen = Array.isArray(body.seen)
    ? [...new Set(body.seen.filter((k) => typeof k === "string" && /^(movie|tv):\d+$/.test(k)))].slice(0, LIMIT * 5)
    : base.seen;
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
    seen,
    seenAt: sanitizeSeenAt(seen, body.seenAt, prev),
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
    const body = await req.json();
    const prev = await getProfile(id);
    const data = sanitize(body, prev);
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
