import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize } from "@/lib/profiles";
import { arrangeShelves, getEngage, intentShelf, rememberFirst } from "@/lib/reco/engagement";
import { getShelves } from "@/lib/reco/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/reco?profile=victor&type=movie|tv|all&session=<id> → { shelves }
// `session` identifica la apertura de la app: dentro de una sesión el orden es estable; en la siguiente, cambia
// (tiras según su uso, portada sin repetir, títulos cansados fuera). Ver src/lib/reco/engagement.ts.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const profile = sp.get("profile") ?? "";
  const type = sp.get("type");
  const session = (sp.get("session") ?? "").slice(0, 64) || `anon:${Math.floor(Date.now() / 3600_000)}`;
  const auth = await authorize(req, profile);
  if (auth instanceof NextResponse) return auth;
  try {
    const [base, engage] = await Promise.all([getShelves(profile, type === "movie" || type === "tv" ? type : "all"), getEngage(profile)]);
    const today = intentShelf(base, engage);
    const shelves = arrangeShelves(today ? [today, ...base] : base, engage, session);
    const top = shelves.find((s) => s.id === "top")?.items[0];
    await rememberFirst(profile, engage, top && `${top.type}:${top.id}`, session).catch(() => {});
    return NextResponse.json({ shelves });
  } catch (err) {
    return errorResponse(err);
  }
}
