import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorize, toPublic, updateProfile } from "@/lib/profiles";
import { retrain } from "@/lib/reco/model";

export const dynamic = "force-dynamic";

// PATCH /api/profiles/<id> { name?, emoji?, color?, members? } (con el token del perfil) → { profile }
export async function PATCH(req: Request, ctx: RouteContext<"/api/profiles/[id]">) {
  const { id } = await ctx.params;
  const auth = await authorize(req, id);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const meta = await updateProfile(id, body);
    if (!meta) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });
    if (JSON.stringify(meta.members) !== JSON.stringify(auth.members)) await retrain(id);
    return NextResponse.json({ profile: toPublic(meta) });
  } catch (err) {
    return errorResponse(err);
  }
}
