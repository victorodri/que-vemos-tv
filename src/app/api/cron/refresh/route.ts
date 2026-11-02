import { NextResponse } from "next/server";
import { PROFILES } from "@/config/profiles";
import { errorResponse } from "@/lib/api";
import { getSeeds } from "@/lib/reco/engine";
import { retrain } from "@/lib/reco/model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron (ver vercel.json), una vez al día: reentrena todos los perfiles (el olvido temporal hace que
// los gustos evolucionen aunque no haya señales nuevas) y precalienta la caché de semillas.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    // Primero los individuales: el de pareja se construye con ellos.
    const order = [...PROFILES.filter((p) => p.id !== "pareja"), ...PROFILES.filter((p) => p.id === "pareja")];
    const result: Record<string, number> = {};
    for (const p of order) result[p.id] = (await retrain(p.id)).signals;
    await Promise.all([getSeeds(["movie"]), getSeeds(["tv"]), getSeeds(["movie", "tv"])]);
    return NextResponse.json({ ok: true, signals: result });
  } catch (err) {
    return errorResponse(err);
  }
}
