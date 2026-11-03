import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize, getMeta } from "@/lib/profiles";
import { answerSurvey, getEngage, markAsked, nextSurvey } from "@/lib/reco/engagement";
import { getProfile } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/survey?profile=<id>&session=<id> → { survey: Survey | null }   (el servidor decide si toca preguntar)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const profile = sp.get("profile") ?? "";
  const session = (sp.get("session") ?? "").slice(0, 64);
  const auth = await authorize(req, profile);
  if (auth instanceof NextResponse) return auth;
  try {
    if (!session) return NextResponse.json({ survey: null });
    const [engage, data, meta] = await Promise.all([getEngage(profile), getProfile(profile), getMeta(profile)]);
    // Vistos sin valorar, más recientes primero (los de la lista traen título y póster).
    const saved = new Map(data.watchlist.map((w) => [`${w.type}:${w.id}`, w]));
    const unratedSeen = [...data.seen]
      .filter((k) => !data.feedback[k] && saved.has(k))
      .sort((a, b) => (data.seenAt?.[b] ?? 0) - (data.seenAt?.[a] ?? 0))
      .map((k) => ({ key: k, title: saved.get(k)!.title, poster: saved.get(k)!.poster }));
    const survey = nextSurvey(engage, session, { plural: meta?.kind === "couple", unratedSeen });
    if (survey && engage.survey.pending?.session !== session) await markAsked(profile, session, survey);
    return NextResponse.json({ survey });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/survey { profile, session, id, answer }   (answer "dismiss" = cerrada sin responder)
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { profile?: string; session?: string; id?: string; answer?: string };
    const auth = await authorize(req, body.profile ?? null);
    if (auth instanceof NextResponse) return auth;
    if (!body.profile || !body.session || !body.id || !body.answer) return NextResponse.json({ error: "Respuesta incompleta" }, { status: 400 });
    await answerSurvey(body.profile, body.session.slice(0, 64), body.id.slice(0, 100), body.answer.slice(0, 40));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
