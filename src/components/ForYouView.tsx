"use client";
import { useState } from "react";
import { hashOf } from "@/lib/client";
import { DEFAULT_FILTERS, filtersToParams } from "@/lib/filters";
import { GENRE_GROUPS } from "@/lib/prefs";
import type { MediaType, Title } from "@/lib/types";
import { useProfile } from "./profileContext";
import { TitleGrid } from "./TitleGrid";
import { useTitles } from "./useTitles";

/** Recomendaciones según el cuestionario del perfil, sin filtros que tocar. */
export function ForYouView({ onOpen, onRedo }: { onOpen: (t: Title) => void; onRedo: () => void }) {
  const profile = useProfile();
  const prefs = profile.data.prefs!;
  const [type, setType] = useState<MediaType>(prefs.types[0]);
  const mine = profile.data.platforms.length > 0;

  const params = filtersToParams({ ...DEFAULT_FILTERS, type, taste: true, onlyMine: mine });
  params.set("profile", profile.id);
  params.set("v", hashOf([prefs, profile.data.platforms]));
  const titles = useTitles(params.toString());
  const items = titles.items.filter((t) => !profile.isSeen(t));

  const likes = GENRE_GROUPS.filter((g) => prefs.likes.includes(g.id)).map((g) => g.label);
  const pareja = profile.id === "pareja";

  return (
    <div className="view">
      <div className="foryou-header">
        <div>
          <h2>{pareja ? "Para vosotros" : "Para ti"}</h2>
          <p className="hint">
            {likes.length ? likes.join(" · ") : "Todos los géneros"}
            {mine ? " · en tus plataformas" : ""}
          </p>
        </div>
        <div className="chips">
          {prefs.types.length > 1 &&
            (["movie", "tv"] as const).map((t, i) => (
              <button key={t} className="chip" aria-pressed={type === t} onClick={() => setType(t)} data-autofocus={i === 0 || undefined}>
                {t === "movie" ? "Películas" : "Series"}
              </button>
            ))}
          <button className="chip" onClick={onRedo}>
            ✎ Cambiar gustos
          </button>
        </div>
      </div>
      <TitleGrid {...titles} items={items} onOpen={onOpen} empty="Nada encaja del todo con tus gustos. Prueba a cambiarlos o a buscar con filtros." />
    </div>
  );
}
