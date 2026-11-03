import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { COLORS, createProfile, EMOJIS, listProfiles, recordNetwork, suggestedFor, toPublic, tokenFor, validPin } from "@/lib/profiles";

export const dynamic = "force-dynamic";

// GET  /api/profiles → { profiles: PublicProfile[], suggested: id | null, emojis, colors }
//      `suggested` = el perfil que más recientemente se ha abierto desde esta misma red (IP guardada como HMAC).
// POST /api/profiles { name, kind: "single" | "couple", members?: id[], emoji, color, pin } → { profile, token }
export async function GET(req: Request) {
  try {
    const list = await listProfiles();
    return NextResponse.json({ profiles: list.map(toPublic), suggested: await suggestedFor(req, list), emojis: EMOJIS, colors: COLORS });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: unknown; kind?: unknown; members?: unknown; emoji?: unknown; color?: unknown; pin?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 30) return NextResponse.json({ error: "El nombre debe tener entre 2 y 30 caracteres" }, { status: 400 });
    if (!validPin(body.pin)) return NextResponse.json({ error: "El PIN son 4 cifras" }, { status: 400 });
    const list = await listProfiles();
    if (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) return NextResponse.json({ error: "Ya hay un perfil con ese nombre" }, { status: 409 });
    const meta = await createProfile({
      name,
      kind: body.kind === "couple" ? "couple" : "single",
      members: Array.isArray(body.members) ? body.members.filter((m): m is string => typeof m === "string") : [],
      emoji: typeof body.emoji === "string" ? body.emoji : "",
      color: typeof body.color === "string" ? body.color : "",
      pin: body.pin,
    });
    await recordNetwork(req, meta.id).catch(() => {});
    return NextResponse.json({ profile: toPublic(meta), token: tokenFor(meta) });
  } catch (err) {
    return errorResponse(err);
  }
}
