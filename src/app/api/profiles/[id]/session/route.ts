import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { login, recordNetwork, validPin } from "@/lib/profiles";

export const dynamic = "force-dynamic";

// POST /api/profiles/<id>/session { pin } → { token }
// Si el perfil aún no tiene PIN (perfiles antiguos), este primer PIN se convierte en el suyo.
export async function POST(req: Request, ctx: RouteContext<"/api/profiles/[id]/session">) {
  const { id } = await ctx.params;
  try {
    const { pin } = (await req.json()) as { pin?: unknown };
    if (!validPin(pin)) return NextResponse.json({ error: "El PIN son 4 cifras" }, { status: 400 });
    const res = await login(id, pin);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    await recordNetwork(req, id).catch(() => {});
    return NextResponse.json(res);
  } catch (err) {
    return errorResponse(err);
  }
}
