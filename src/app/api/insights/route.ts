import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize } from "@/lib/profiles";
import { getInsights } from "@/lib/reco/insights";

export const dynamic = "force-dynamic";

// GET /api/insights?profile=<id> → ProfileInsights («Lo que hemos aprendido de ti»)
export async function GET(req: NextRequest) {
  const profile = req.nextUrl.searchParams.get("profile") ?? "";
  const auth = await authorize(req, profile);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await getInsights(profile));
  } catch (err) {
    return errorResponse(err);
  }
}
