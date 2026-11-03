import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { getReviews } from "@/lib/reviews";

export const maxDuration = 30;

// GET /api/reviews/movie/680 → TitleReviews (notas de la crítica, aspectos y opiniones destacadas)
export async function GET(_req: Request, ctx: RouteContext<"/api/reviews/[type]/[id]">) {
  const { type, id } = await ctx.params;
  const numId = Number(id);
  if ((type !== "movie" && type !== "tv") || !Number.isInteger(numId)) {
    return NextResponse.json({ error: "Título no válido" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getReviews(type, numId));
  } catch (err) {
    return errorResponse(err);
  }
}
