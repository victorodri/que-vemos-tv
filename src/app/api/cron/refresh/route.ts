import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { getSeeds } from "@/lib/reco/engine";
import { retrain } from "@/lib/reco/model";
import { listProfiles } from "@/lib/profiles";
import { warmReviews } from "@/lib/reviews";
import { ingestFeeds } from "@/lib/reviews/rss";
import { getProfile } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron (ver vercel.json), una vez al día: reentrena todos los perfiles (el olvido temporal hace que
// los gustos evolucionen aunque no haya señales nuevas) y precalienta la caché de semillas.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    // Hemeroteca de críticas: se leen los blogs y medios del día.
    const rss = await ingestFeeds().catch((e) => ({ error: String(e) }));
    // Primero los individuales: las parejas se construyen con ellos.
    const profiles = await listProfiles();
    const order = [...profiles.filter((p) => p.kind === "single"), ...profiles.filter((p) => p.kind === "couple")];
    // Críticas de lo que cada perfil ha valorado o visto, para que sus aspectos entren en el modelo.
    let reviews = 0;
    for (const p of order) {
      const d = await getProfile(p.id);
      reviews += await warmReviews([...Object.keys(d.feedback), ...d.seen].reverse(), 25).catch(() => 0);
    }
    const result: Record<string, number> = {};
    for (const p of order) result[p.id] = (await retrain(p.id)).signals;
    await Promise.all([getSeeds(["movie"]), getSeeds(["tv"]), getSeeds(["movie", "tv"])]);
    return NextResponse.json({ ok: true, signals: result, rss, reviews });
  } catch (err) {
    return errorResponse(err);
  }
}
