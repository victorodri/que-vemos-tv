"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { ActivityItem, ActivityResult, SocialCount, SocialSignal } from "@/lib/activity";
import { getJSON } from "@/lib/client";
import { titleKey, type Title } from "@/lib/types";
import { Avatar } from "./ProfilePicker";
import "./social.css";

// Gancho social: lo que otros perfiles de QuéVer están valorando, viendo o quieren ver (datos reales de
// /api/activity, solo señales positivas). Sin otros perfiles activos se muestra una invitación, nunca relleno.

/** Contadores sociales por título para las tarjetas («👥 2»). Vacío fuera de un proveedor. */
export const SocialCountsContext = createContext<Record<string, SocialCount>>({});
export const useSocialCount = (t: { type: Title["type"]; id: number }): SocialCount | null => useContext(SocialCountsContext)[titleKey(t)] ?? null;

/** Actividad de la comunidad para el perfil activo; se recarga cuando cambia `version`. */
export function useActivity(profileId: string, limit = 24, version = ""): { data: ActivityResult | null; error: string | null } {
  const [data, setData] = useState<ActivityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    getJSON<ActivityResult>(`/api/activity?profile=${profileId}&limit=${limit}`, ctrl.signal).then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e) => !ctrl.signal.aborted && setError((e as Error).message),
    );
    return () => ctrl.abort();
  }, [profileId, limit, version]);
  return { data, error };
}

const VERB: Record<SocialSignal, string> = { love: "le encantó", like: "le gustó", seen: "ha visto", want: "quiere ver" };

/** «A Rafa le encantó» / «Rafa ha visto» / «Rafa quiere ver». */
export function activityPhrase(name: string, s: SocialSignal) {
  return s === "love" || s === "like" ? `A ${name} ${VERB[s]}` : `${name} ${VERB[s]}`;
}

/** «hace 5 min», «hace 2 h», «ayer», «hace 3 días», «el 12 oct». */
export function timeAgo(t: number, now = Date.now()) {
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return "ayer";
  if (d < 7) return `hace ${d} días`;
  return `el ${new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}`;
}

/** Texto corto para una tarjeta: «A Rafa le gustó» o «Rafa y 2 perfiles más». */
export function socialLabel(s: SocialCount) {
  if (s.n === 1) return activityPhrase(s.names[0], s.top);
  return `${s.names[0]} y ${s.n - 1} ${s.n === 2 ? "perfil" : "perfiles"} más`;
}

/** Una entrada de actividad: avatar + póster + frase. Abre la ficha. */
export function ActivityCard({ item, onOpen, compact, autofocus }: { item: ActivityItem; onOpen: (t: Title) => void; compact?: boolean; autofocus?: boolean }) {
  const phrase = activityPhrase(item.profile.name, item.signal);
  return (
    <button
      className={compact ? "act act--compact" : "act"}
      onClick={() => onOpen(item.title)}
      aria-label={`${phrase} ${item.title.title}, ${timeAgo(item.t)}`}
      data-autofocus={autofocus || undefined}
    >
      <span className="act-poster">{item.title.poster ? <img src={item.title.poster} alt="" loading="lazy" /> : null}</span>
      <span className="act-body">
        <span className="act-who">
          <Avatar p={item.profile} small />
          <span className="act-phrase">{phrase}</span>
        </span>
        <span className="act-title">{item.title.title}</span>
        <span className="act-time">{timeAgo(item.t)}</span>
      </span>
    </button>
  );
}

/** Franja «En QuéVer» de «Para ti»: lo último que han hecho otros perfiles. */
export function SocialPulse({ data, onOpen, plural }: { data: ActivityResult | null; onOpen: (t: Title) => void; plural: boolean }) {
  if (!data) return null;
  // Sin actividad de otros perfiles no se muestra nada (ni invitaciones).
  if (!data.items.length) return null;
  return (
    <section className="shelf social-pulse" aria-label="En QuéVer">
      <h3 className="shelf-title social-title">
        <span className="social-dot" aria-hidden /> En QuéVer
        <span className="social-sub">{data.active === 1 ? "lo último de otro perfil" : `lo último de ${data.active} perfiles`}</span>
      </h3>
      <div className="shelf-row social-row">
        {data.items.slice(0, 12).map((it) => (
          <ActivityCard key={`${it.profile.id}:${titleKey(it.title)}`} item={it} onOpen={onOpen} compact />
        ))}
      </div>
    </section>
  );
}
