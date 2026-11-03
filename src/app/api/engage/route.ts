import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize } from "@/lib/profiles";
import { KEY_RE } from "@/lib/reco/feedback";
import { recordEngagement, type EngageAction, type EngageBatch } from "@/lib/reco/engagement";

export const dynamic = "force-dynamic";

const ACTIONS: EngageAction[] = ["open", "want", "love", "like", "dislike", "not_interested", "seen"];

// POST /api/engage { profile, session, views: [{ shelf, title, keys }], actions: [{ key, a, from?, t? }] }
// Impresiones de las tiras y acciones de la sesión (el cliente las envía en lotes). Ver src/lib/reco/engagement.ts.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<EngageBatch> & { profile?: string };
    const auth = await authorize(req, body.profile ?? null);
    if (auth instanceof NextResponse) return auth;
    if (!body.profile || typeof body.session !== "string" || !body.session) return NextResponse.json({ error: "Falta la sesión" }, { status: 400 });
    const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
    const batch: EngageBatch = {
      session: body.session.slice(0, 64),
      views: (Array.isArray(body.views) ? body.views : [])
        .slice(0, 40)
        .map((v) => ({ shelf: str(v?.shelf, 80), title: str(v?.title, 120), keys: (Array.isArray(v?.keys) ? v.keys : []).filter((k) => KEY_RE.test(k)).slice(0, 8) }))
        .filter((v) => v.shelf),
      actions: (Array.isArray(body.actions) ? body.actions : [])
        .slice(0, 60)
        .filter((a) => KEY_RE.test(a?.key) && ACTIONS.includes(a?.a))
        .map((a) => ({ key: a.key, a: a.a, from: a.from ? str(a.from, 80) : undefined, t: Number(a.t) || undefined })),
    };
    await recordEngagement(body.profile, batch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
