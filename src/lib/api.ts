import "server-only";
import { NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { getProfile } from "./store";
import { TmdbError } from "./tmdb";

export function errorResponse(err: unknown) {
  const status = err instanceof TmdbError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Error inesperado";
  console.error(err);
  return NextResponse.json({ error: message }, { status });
}

/** Plataformas del perfil, o [] si no hay perfil válido. */
export async function profilePlatforms(profile: string | null): Promise<number[]> {
  if (!profile || !isProfileId(profile)) return [];
  return (await getProfile(profile)).platforms;
}
