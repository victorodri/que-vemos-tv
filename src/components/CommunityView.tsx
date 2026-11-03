"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/client";
import type { PublicProfile } from "@/lib/profiles";
import { titleKey, type Title } from "@/lib/types";
import { useProfile } from "./profileContext";
import { Avatar } from "./ProfilePicker";
import { PosterCard } from "./ForYouView";

interface Person {
  profile: PublicProfile;
  match: number;
  shared: number;
  loved: Title[];
}

/** La red de Qué Vemos: otros perfiles, cuánto se parecen sus gustos a los tuyos y lo que les encantó. */
export function CommunityView({ onOpen }: { onOpen: (t: Title) => void }) {
  const profile = useProfile();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getJSON<{ people: Person[] }>(`/api/community?profile=${profile.id}`, ctrl.signal).then(
      (r) => setPeople(r.people),
      (e) => !ctrl.signal.aborted && setError(e.message),
    );
    return () => ctrl.abort();
  }, [profile.id]);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>Comunidad</h2>
          <p className="hint">Lo que les encanta a otros perfiles de Qué Vemos, del más parecido a {profile.plural ? "vosotros" : "ti"} al menos.</p>
        </div>
      </div>
      {error && <p className="error">No se ha podido cargar la comunidad: {error}</p>}
      {!people && !error && <p className="loading">Buscando perfiles parecidos…</p>}
      {people && people.length === 0 && (
        <p className="empty">Aún no hay otros perfiles con valoraciones. Cuando alguien cree el suyo y marque lo que le encanta, aparecerá aquí.</p>
      )}
      {people?.map((p, i) => (
        <section key={p.profile.id} className="shelf" aria-label={p.profile.name}>
          <h3 className="shelf-title community-title">
            <Avatar p={p.profile} small />
            <span>{p.profile.name}</span>
            <span className="community-match">
              {p.match >= 15 ? `Coincidís en un ${p.match} %` : "Gustos distintos"}
              {p.shared ? ` · ${p.shared} en común` : ""}
            </span>
          </h3>
          <div className="shelf-row">
            {p.loved.map((t, j) => (
              <PosterCard key={titleKey(t)} item={{ ...t, score: 0, reason: `A ${p.profile.name} le encantó` }} onOpen={() => onOpen(t)} autofocus={i === 0 && j === 0} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
