import { NextRequest, NextResponse } from "next/server";
import { getActivity } from "@/lib/activity";
import { errorResponse } from "@/lib/api";
import { authorize } from "@/lib/profiles";

export const dynamic = "force-dynamic";

// GET /api/activity?profile=<id>&limit=24
//   → { items: [{ profile: {id,name,emoji,color}, title, signal: love|like|want|seen, t }],
//       counts: { "movie:1": { n, names, top } }, others, active }
// Actividad positiva y real de OTROS perfiles (nunca la del propio ni la de sus parejas). Sin otros perfiles
// activos, `items` va vacío y el cliente muestra una invitación.
export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get("profile");
  const auth = await authorize(req, profileId);
  if (auth instanceof NextResponse) return auth;
  try {
    const limit = Math.max(1, Math.min(60, Number(req.nextUrl.searchParams.get("limit")) || 24));
    return NextResponse.json(await getActivity(auth.id, limit));
  } catch (err) {
    return errorResponse(err);
  }
}
