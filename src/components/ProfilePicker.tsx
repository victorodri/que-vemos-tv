"use client";
import { useEffect } from "react";
import type { PublicProfile } from "@/lib/profiles";
import { Logo } from "./Logo";
import { focusFirst } from "./spatialNav";

export function Avatar({ p, small }: { p: Pick<PublicProfile, "emoji" | "color" | "name">; small?: boolean }) {
  return (
    <span className={small ? "avatar avatar--small" : "avatar"} style={{ background: p.color }} aria-hidden>
      {p.emoji}
    </span>
  );
}

/**
 * ¿Quién está viendo? El foco empieza en el perfil propuesto: el último de esta tele o, si es nueva, el que
 * más se usa desde esta red.
 */
export function ProfilePicker({
  profiles,
  focusId,
  onPick,
  onCreate,
  error,
}: {
  profiles: PublicProfile[] | null;
  focusId: string | null;
  onPick: (p: PublicProfile) => void;
  onCreate: () => void;
  error?: string | null;
}) {
  useEffect(() => {
    if (profiles) requestAnimationFrame(focusFirst);
  }, [profiles]);

  const target = profiles?.some((p) => p.id === focusId) ? focusId : profiles?.[0]?.id;

  return (
    <main className="picker">
      <Logo big />
      <p className="picker-question">¿Quién está viendo?</p>
      {error && <p className="error">{error}</p>}
      {!profiles && !error && <p className="loading">Cargando perfiles…</p>}
      {profiles && (
        <div className="profiles">
          {profiles.map((p) => (
            <button key={p.id} className="profile" onClick={() => onPick(p)} data-autofocus={p.id === target || undefined}>
              <Avatar p={p} />
              <span className="profile-name">{p.name}</span>
              <span className="profile-kind">{p.kind === "couple" ? "En pareja" : p.hasPin ? "🔒 Con PIN" : "Sin PIN"}</span>
            </button>
          ))}
          <button className="profile profile--new" onClick={onCreate} data-autofocus={!profiles.length || undefined}>
            <span className="avatar avatar--new" aria-hidden>
              +
            </span>
            <span className="profile-name">Nuevo perfil</span>
            <span className="profile-kind">Individual o en pareja</span>
          </button>
        </div>
      )}
    </main>
  );
}
