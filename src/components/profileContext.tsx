"use client";
import { createContext, useContext } from "react";
import type { ProfileId } from "@/config/profiles";
import type { ImplicitEvent, Signal } from "@/lib/reco/types";
import type { Filters, ProfileData, SavedTitle, Title } from "@/lib/types";

export interface ProfileApi {
  id: ProfileId;
  data: ProfileData;
  inList: (t: { type: Title["type"]; id: number }) => boolean;
  isSeen: (t: { type: Title["type"]; id: number }) => boolean;
  toggleList: (t: Title | SavedTitle) => void;
  toggleSeen: (t: Title | SavedTitle) => void;
  setPlatforms: (ids: number[]) => void;
  clearSeen: () => void;
  setLastFilters: (f: Filters) => void;
  /** Valoración explícita del perfil para un título, si la hay. */
  feedbackOf: (t: { type: Title["type"]; id: number }) => Signal | undefined;
  /** Valora un título; volver a pulsar la misma valoración la quita (signal null = quitar). */
  rate: (t: Title | SavedTitle, signal: Signal | null) => void;
  /** Señal implícita para el modelo (abrir, saltar…). No espera respuesta. */
  track: (t: Title | SavedTitle, event: ImplicitEvent) => void;
}

export const ProfileContext = createContext<ProfileApi | null>(null);

export function useProfile(): ProfileApi {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile fuera de ProfileContext");
  return ctx;
}
