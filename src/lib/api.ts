import "server-only";
import { NextResponse } from "next/server";
import { isProfileId } from "@/config/profiles";
import { getProfile } from "./store";
import { TmdbError } from "./tmdb";
import type { ProfileData } from "./types";

export function errorResponse(err: unknown) {
  const status = err instanceof TmdbError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Error inesperado";
  console.error(err);
  return NextResponse.json({ error: message }, { status });
}

/** Datos del perfil, o null si no hay perfil válido. */
export async function loadProfile(profile: string | null): Promise<ProfileData | null> {
  if (!profile || !isProfileId(profile)) return null;
  return getProfile(profile);
}
