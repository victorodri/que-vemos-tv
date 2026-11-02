import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { getSeeds } from "@/lib/reco/engine";
import type { MediaType } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/reco/seeds?type=movie|tv|all → { items } para puntuar en el onboarding
export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  const types: MediaType[] = type === "movie" || type === "tv" ? [type] : ["movie", "tv"];
  try {
    return NextResponse.json({ items: await getSeeds(types) });
  } catch (err) {
    return errorResponse(err);
  }
}
