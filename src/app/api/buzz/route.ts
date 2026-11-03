import { after, NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { buzzFor, refreshBuzzScores } from "@/lib/buzz";
import { authorize } from "@/lib/profiles";
import { getManyFeatures } from "@/lib/reco/features";
import { warmReviews } from "@/lib/reviews";

export const dynamic = "force-dynamic";

// GET /api/buzz?profile=<id>&limit=12
//   → { items: BuzzPersonal[] (Title + kind, trendRank, critic, rt, hook[], social…), builtAt }
// Estrenos recientes en cines y plataformas de España, ordenados por tirón y por los gustos del perfil.
export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get("profile");
  const auth = await authorize(req, profileId);
  if (auth instanceof NextResponse) return auth;
  try {
    const limit = Math.max(1, Math.min(24, Number(req.nextUrl.searchParams.get("limit")) || 12));
    const { items, builtAt, fresh, keys } = await buzzFor(auth.id, limit);
    // En segundo plano: críticas de los estrenos (para el gancho «92 % en Rotten Tomatoes» del próximo cálculo)
    // y sus rasgos (para ordenar por afinidad sin esperar).
    after(async () => {
      await warmReviews(keys, fresh ? 10 : 3).catch(() => 0);
      await refreshBuzzScores(keys).catch(() => {});
      if (fresh) await getManyFeatures(keys).catch(() => null);
    });
    return NextResponse.json({ items, builtAt });
  } catch (err) {
    return errorResponse(err);
  }
}
