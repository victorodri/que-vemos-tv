"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/client";
import { titleKey, type Provider, type SavedTitle } from "@/lib/types";
import { useProfile } from "./profileContext";
import { TitleCard } from "./TitleCard";

export function ListView({ onOpen }: { onOpen: (t: SavedTitle) => void }) {
  const profile = useProfile();
  const list = profile.data.watchlist;
  const [providers, setProviders] = useState<Record<string, Provider[]>>({});
  const keys = list.map(titleKey).join(",");

  useEffect(() => {
    if (!keys) return;
    const ctrl = new AbortController();
    getJSON<Record<string, Provider[]>>(`/api/providers?items=${keys}`, ctrl.signal)
      .then(setProviders)
      .catch(() => {});
    return () => ctrl.abort();
  }, [keys]);

  const pending = list.filter((t) => !profile.isSeen(t));

  return (
    <div className="view">
      <div className="list-header">
        <h2>Quiero verla ({list.length})</h2>
        {pending.length > 0 && (
          <button className="btn btn--primary" data-autofocus onClick={() => onOpen(pending[Math.floor(Math.random() * pending.length)])}>
            🎲 Elige una de mi lista
          </button>
        )}
      </div>
      {list.length === 0 && <p className="empty">Tu lista está vacía. Añade títulos con «＋ Quiero verla».</p>}
      <div className="grid">
        {[...list].reverse().map((t) => (
          <TitleCard key={titleKey(t)} title={{ ...t, providers: providers[titleKey(t)] }} onOpen={() => onOpen(t)} />
        ))}
      </div>
    </div>
  );
}
