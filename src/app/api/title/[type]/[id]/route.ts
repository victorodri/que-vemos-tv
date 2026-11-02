import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { getDetail } from "@/lib/tmdb";

export async function GET(_req: Request, ctx: RouteContext<"/api/title/[type]/[id]">) {
  const { type, id } = await ctx.params;
  const numId = Number(id);
  if ((type !== "movie" && type !== "tv") || !Number.isInteger(numId)) {
    return NextResponse.json({ error: "Título no válido" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getDetail(type, numId));
  } catch (err) {
    return errorResponse(err);
  }
}
