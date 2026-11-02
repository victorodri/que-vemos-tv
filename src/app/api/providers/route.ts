import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { getProviders } from "@/lib/tmdb";
import type { MediaType, Provider } from "@/lib/types";

// GET /api/providers?items=movie:1,tv:2 → { "movie:1": [...], "tv:2": [...] }
export async function GET(req: NextRequest) {
  const keys = (req.nextUrl.searchParams.get("items") ?? "")
    .split(",")
    .filter((k) => /^(movie|tv):\d+$/.test(k))
    .slice(0, 100);
  try {
    const entries = await Promise.all(
      keys.map(async (k): Promise<[string, Provider[]]> => {
        const [type, id] = k.split(":");
        const { providers } = await getProviders(type as MediaType, Number(id)).catch(() => ({ providers: [] }));
        return [k, providers];
      }),
    );
    return NextResponse.json(Object.fromEntries(entries));
  } catch (err) {
    return errorResponse(err);
  }
}
