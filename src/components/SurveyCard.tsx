"use client";
import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "@/lib/client";
import type { Survey } from "@/lib/reco/engagement";
import type { Signal } from "@/lib/reco/types";
import { parseTitleKey } from "@/lib/types";
import { useProfile } from "./profileContext";
import { lastInputPointer, recoverFocus } from "./spatialNav";

/**
 * Micro-encuesta de «Para ti»: una sola pregunta, de vez en cuando (el servidor decide cuándo y cuál, ver
 * nextSurvey en engagement.ts). Se responde con un botón o se cierra con «Ahora no»; no interrumpe nada.
 */
export function SurveyCard({ session, onChanged }: { session: string; onChanged: () => void }) {
  const profile = useProfile();
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    let alive = true;
    setSurvey(null);
    setThanks(false);
    getJSON<{ survey: Survey | null }>(`/api/survey?profile=${profile.id}&session=${session}`)
      .then((r) => alive && setSurvey(r.survey))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [profile.id, session]);

  if (thanks) return <p className="survey survey--thanks" role="status">¡Gracias! Lo tendremos en cuenta.</p>;
  if (!survey) return null;

  const answer = (a: string) => {
    sendJSON("/api/survey", "POST", { profile: profile.id, session, id: survey.id, answer: a }).then(
      () => (survey.kind === "shelf" || survey.kind === "mood") && a !== "dismiss" && onChanged(),
      () => {},
    );
    if (survey.kind === "rate" && survey.item && a !== "dismiss") {
      const { type, id } = parseTitleKey(survey.item.key);
      profile.rate({ type, id, title: survey.item.title, poster: survey.item.poster, year: null, rating: null, overview: "" }, a as Signal);
    }
    setSurvey(null);
    // Los botones desaparecen con la respuesta: el foco del mando pasa a lo más cercano (la primera estantería).
    if (!lastInputPointer) requestAnimationFrame(recoverFocus);
    if (a !== "dismiss") {
      setThanks(true);
      setTimeout(() => setThanks(false), 2500);
    }
  };

  return (
    <section className="survey" aria-label="Pregunta rápida" data-nav-block>
      {survey.item?.poster && <img className="survey-poster" src={survey.item.poster} alt="" />}
      <div className="survey-body">
        <p className="survey-kicker">Pregunta rápida</p>
        <h3 className="survey-q">{survey.question}</h3>
        {survey.hint && <p className="hint">{survey.hint}</p>}
        <div className="chips survey-options">
          {survey.options.map((o) => (
            <button key={o.id} className="chip" onClick={() => answer(o.id)}>
              {o.label}
            </button>
          ))}
          <button className="chip chip--muted" onClick={() => answer("dismiss")}>
            Ahora no
          </button>
        </div>
      </div>
    </section>
  );
}
