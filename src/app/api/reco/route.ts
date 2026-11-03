import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize } from "@/lib/profiles";
import { getShelves } from "@/lib/reco/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/reco?profile=victor&type=movie|tv|all → { shelves }
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const profile = sp.get("profile") ?? "";
  const type = sp.get("type");
  const auth = await authorize(req, profile);
  if (auth instanceof NextResponse) return auth;
  try {
    const shelves = await getShelves(profile, type === "movie" || type === "tv" ? type : "all");
    return NextResponse.json({ shelves });
  } catch (err) {
    return errorResponse(err);
  }
}
