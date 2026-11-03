import { NextRequest, NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { errorResponse } from "@/lib/api";
import { paramsToFilters } from "@/lib/filters";
import { KEY_RE } from "@/lib/reco/feedback";
import { surpriseBatch } from "@/lib/reco/surprise";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/surprise?<filtros>&profile=victor&n=4&skip=movie:1,tv:2
// → { items: SurpriseItem[], item (= items[0], compatibilidad), reason?: "empty" }
// Lote de propuestas para el Sorpréndeme infinito (ver src/lib/reco/surprise.ts). El cliente las va
// mostrando y pide otro lote cuando le quedan pocas.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const profile = sp.get("profile") ?? "";
  if (!isProfileId(profile)) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });
  const f = { ...paramsToFilters(sp), query: "" };
  const n = Math.min(Math.max(Number(sp.get("n")) || 4, 1), 6);
  const skip = (sp.get("skip") ?? "").split(",").filter((k) => KEY_RE.test(k)).slice(0, 200);
  try {
    const res = await surpriseBatch(profile, f, n, skip);
    return NextResponse.json({ ...res, item: res.items[0] ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
