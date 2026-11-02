import { NextRequest, NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { errorResponse, loadProfile } from "@/lib/api";
import { paramsToFilters } from "@/lib/filters";
import { pickWeighted } from "@/lib/reco/engine";
import { getTaste } from "@/lib/reco/model";
import { discover, getDetail } from "@/lib/tmdb";
import { titleKey, type Title } from "@/lib/types";

// Se sortea entre las primeras páginas por popularidad, para no proponer rarezas.
const MAX_PAGES = 20;
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

// GET /api/surprise?<filtros>&profile=victor&skip=movie:1,tv:2
// Los filtros del usuario son obligatorios; dentro de lo que los cumple, se elige con muestreo ponderado
// por el modelo de gustos (afinidad + calidad), excluyendo lo ya visto, valorado o rechazado.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const f = { ...paramsToFilters(sp), query: "" };
  const profileId = sp.get("profile") ?? "";
  try {
    const profile = await loadProfile(profileId);
    const taste = isProfileId(profileId) ? await getTaste(profileId) : null;
    const opts = { platforms: f.onlyMine ? (profile?.platforms ?? []) : [], prefs: profile?.prefs };
    // Se excluye lo visto, lo rechazado y lo ya propuesto; lo que está en «Quiero verla» SÍ puede salir.
    const excluded = new Set([...(profile?.seen ?? []), ...(taste?.rejected ?? []), ...(sp.get("skip")?.split(",") ?? [])]);

    const first = await discover(f, 1, opts);
    if (first.totalResults === 0) return NextResponse.json({ item: null, reason: "empty" });
    const pages = Math.min(first.totalPages, MAX_PAGES);

    // Hasta 3 páginas al azar (más la primera) para tener variedad de candidatos.
    const order = [...new Set([1, randInt(1, pages), randInt(1, pages), randInt(1, pages)])];
    const pool: Title[] = [];
    for (const page of order) {
      const data = page === 1 ? first : await discover(f, page, opts);
      pool.push(...data.items.filter((t) => !excluded.has(titleKey(t)) && !pool.some((p) => titleKey(p) === titleKey(t))));
    }
    // Si todo lo de esas páginas estaba descartado, se recorren las demás en orden.
    for (let p = 2; !pool.length && p <= pages && p <= 8; p++) {
      if (order.includes(p)) continue;
      pool.push(...(await discover(f, p, opts)).items.filter((t) => !excluded.has(titleKey(t))));
    }
    if (!pool.length) return NextResponse.json({ item: null, reason: "exhausted" });

    const pick = taste ? pickWeighted(pool, taste) : pool[randInt(0, pool.length - 1)];
    if (!pick) return NextResponse.json({ item: null, reason: "exhausted" });
    return NextResponse.json({ item: await getDetail(pick.type, pick.id) });
  } catch (err) {
    return errorResponse(err);
  }
}
