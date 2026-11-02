import { NextRequest, NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { errorResponse } from "@/lib/api";
import { getShelves } from "@/lib/reco/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/reco?profile=victor&type=movie|tv|all → { shelves }
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const profile = sp.get("profile") ?? "";
  const type = sp.get("type");
  if (!isProfileId(profile)) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });
  try {
    const shelves = await getShelves(profile, type === "movie" || type === "tv" ? type : "all");
    return NextResponse.json({ shelves });
  } catch (err) {
    return errorResponse(err);
  }
}
