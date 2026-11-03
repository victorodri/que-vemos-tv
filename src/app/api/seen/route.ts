import { NextRequest, NextResponse } from "next/server";
import { errorResponse, loadProfile } from "@/lib/api";
import type { RecoEvent } from "@/lib/reco/types";
import { listRange } from "@/lib/store";
import { getDetail } from "@/lib/tmdb";
import type { MediaType, SeenItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_ITEMS = 500;
const CONCURRENCY = 8;

/** Ejecuta `fn` sobre cada elemento con un máximo de `n` a la vez (para no saturar TMDB). */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

// GET /api/seen?profile=victor → { items: SeenItem[] } ordenados del más reciente al más antiguo;
// los que no tienen fecha van al final (en orden de marcado, del último al primero).
export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get("profile");
    const profile = await loadProfile(profileId);
    if (!profile) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });

    // Vistos antiguos sin fecha: se usa el último evento «seen» del historial, si lo hay (la lista va del más nuevo al más viejo).
    const dates: Record<string, number> = {};
    if (profile.seen.some((k) => !profile.seenAt?.[k])) {
      const events = await listRange<RecoEvent>(`events:${profileId}`, 2000).catch(() => [] as RecoEvent[]);
      for (const ev of events) if (ev?.e === "seen" && !(ev.k in dates)) dates[ev.k] = ev.t;
    }
    const watch = new Map(profile.watchlist.map((t) => [`${t.type}:${t.id}`, t]));

    const keys = [...profile.seen].reverse().slice(0, MAX_ITEMS);
    const items = await mapLimit(keys, CONCURRENCY, async (k): Promise<SeenItem | null> => {
      const [type, id] = k.split(":") as [MediaType, string];
      const seenAt = profile.seenAt?.[k] ?? dates[k] ?? null;
      try {
        const d = await getDetail(type, Number(id));
        return { id: d.id, type, title: d.title, year: d.year, rating: d.rating, overview: d.overview, poster: d.poster, backdrop: null, genreIds: d.genreIds, providers: d.providers, seenAt };
      } catch {
        // Si TMDB falla, al menos lo que tengamos guardado en la lista.
        const w = watch.get(k);
        return w ? { ...w, backdrop: null, genreIds: [], seenAt } : null;
      }
    });

    const order = new Map(keys.map((k, i) => [k, i]));
    const result = items
      .filter((x): x is SeenItem => x !== null)
      .sort((a, b) => (b.seenAt ?? -1) - (a.seenAt ?? -1) || order.get(`${a.type}:${a.id}`)! - order.get(`${b.type}:${b.id}`)!);
    return NextResponse.json({ items: result });
  } catch (err) {
    return errorResponse(err);
  }
}
