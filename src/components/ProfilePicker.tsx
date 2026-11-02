"use client";
import { useEffect } from "react";
import { PROFILES, type ProfileId } from "@/config/profiles";
import { focusFirst } from "./spatialNav";

export function ProfilePicker({ lastUsed, onPick }: { lastUsed: string | null; onPick: (id: ProfileId) => void }) {
  useEffect(() => {
    requestAnimationFrame(focusFirst);
  }, []);

  return (
    <main className="picker">
      <h1 className="logo logo--big">
        Qué <span>Vemos</span>
      </h1>
      <p className="picker-question">¿Quién está viendo?</p>
      <div className="profiles">
        {PROFILES.map((p, i) => (
          <button
            key={p.id}
            className="profile"
            onClick={() => onPick(p.id)}
            data-autofocus={(lastUsed ? p.id === lastUsed : i === 1) || undefined}
          >
            <span className="avatar" style={{ background: p.color }}>
              {p.initials}
            </span>
            <span className="profile-name">{p.name}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
