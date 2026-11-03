import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize, toPublic } from "@/lib/profiles";
import { neighbors } from "@/lib/reco/community";
import { getManyFeatures } from "@/lib/reco/features";
import { getTaste } from "@/lib/reco/model";
import type { Title } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/community?profile=<id> → { people: [{ profile, match (0..100), shared, loved: Title[] }] }
// Lo único que se comparte de cada perfil: nombre, emoji y lo que le encantó o gustó.
export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get("profile");
  const auth = await authorize(req, profileId);
  if (auth instanceof NextResponse) return auth;
  try {
    const taste = await getTaste(auth.id);
    const ns = await neighbors(auth.id, taste);
    const keys = ns.flatMap((n) => [...n.loved, ...n.liked].slice(0, 12));
    const feats = await getManyFeatures(keys);
    const people = ns.map((n) => ({
      profile: toPublic(n.meta),
      match: Math.round(Math.max(0, Math.min(1, n.sim)) * 100),
      shared: n.shared,
      loved: [...n.loved, ...n.liked]
        .slice(0, 12)
        .map((k) => feats.get(k))
        .filter((f) => !!f)
        .map(
          (f): Title => ({ id: f!.id, type: f!.type, title: f!.title, year: f!.year, rating: f!.rating, overview: f!.overview, poster: f!.poster, backdrop: f!.backdrop, genreIds: f!.genreIds }),
        ),
    }));
    return NextResponse.json({ people });
  } catch (err) {
    return errorResponse(err);
  }
}
