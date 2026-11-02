import { after, NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { errorResponse } from "@/lib/api";
import { IMPLICIT, KEY_RE, SIGNALS } from "@/lib/reco/feedback";
import { coupleRetrainAfter, logEvent, retrain } from "@/lib/reco/model";
import type { ImplicitEvent, Signal } from "@/lib/reco/types";
import { getProfile, kvGet, kvSet, saveFeedback } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/feedback { profile, key, signal?: Signal | null, event?: ImplicitEvent }
//                  o { profile, batch: [{ key, signal }] }  (varias valoraciones de golpe, p. ej. el onboarding)
// Valoraciones explícitas (se guardan en el perfil) y eventos implícitos (historial). Reentrena al momento
// si la señal es explícita; los implícitos se acumulan y entran en el siguiente reentrenamiento.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      profile?: string;
      key?: string;
      signal?: Signal | null;
      event?: ImplicitEvent;
      batch?: { key: string; signal: Signal | null }[];
    };
    const { profile, key } = body;
    if (!profile || !isProfileId(profile)) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });

    if (Array.isArray(body.batch)) {
      const items = body.batch.filter((b) => KEY_RE.test(b?.key) && (b.signal === null || SIGNALS.includes(b.signal))).slice(0, 200);
      const now = Date.now();
      const { feedback } = await getProfile(profile);
      for (const b of items) {
        if (b.signal === null) delete feedback[b.key];
        else feedback[b.key] = { s: b.signal, t: now };
      }
      await saveFeedback(profile, feedback);
      for (const b of items) await logEvent(profile, { k: b.key, e: b.signal ?? "clear", t: now });
      await retrain(profile);
      coupleRetrainAfter(profile, after);
      return NextResponse.json({ ok: true, feedback });
    }

    if (!key || !KEY_RE.test(key)) return NextResponse.json({ error: "Título no válido" }, { status: 400 });

    const t = Date.now();
    if (body.event !== undefined) {
      if (!IMPLICIT.includes(body.event)) return NextResponse.json({ error: "Evento no válido" }, { status: 400 });
      // Un mismo evento sobre el mismo título cuenta una vez por minuto (evita ruido y gasto de Redis).
      const dedupeKey = `ev:${profile}:${key}:${body.event}`;
      if (await kvGet(dedupeKey).catch(() => null)) return NextResponse.json({ ok: true, deduped: true });
      await kvSet(dedupeKey, 1, 60).catch(() => {});
      await logEvent(profile, { k: key, e: body.event, t });
      return NextResponse.json({ ok: true });
    }

    if (body.signal !== null && !SIGNALS.includes(body.signal as Signal)) {
      return NextResponse.json({ error: "Valoración no válida" }, { status: 400 });
    }
    const { feedback } = await getProfile(profile);
    if (body.signal === null) delete feedback[key];
    else feedback[key] = { s: body.signal as Signal, t };
    await saveFeedback(profile, feedback);
    await logEvent(profile, { k: key, e: body.signal ?? "clear", t });
    await retrain(profile);
    coupleRetrainAfter(profile, after);
    return NextResponse.json({ ok: true, feedback });
  } catch (err) {
    return errorResponse(err);
  }
}
