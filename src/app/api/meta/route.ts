import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { storageMode } from "@/lib/store";
import { getGenres, getRegionProviders } from "@/lib/tmdb";
import type { Meta } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [movie, tv, providers] = await Promise.all([getGenres("movie"), getGenres("tv"), getRegionProviders()]);
    const meta: Meta = { genres: { movie, tv }, providers, storage: storageMode };
    return NextResponse.json(meta);
  } catch (err) {
    return errorResponse(err);
  }
}
