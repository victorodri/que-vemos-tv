"use client";
import { createContext, useContext } from "react";
import type { ProfileId } from "@/config/profiles";
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
}

export const ProfileContext = createContext<ProfileApi | null>(null);

export function useProfile(): ProfileApi {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile fuera de ProfileContext");
  return ctx;
}
