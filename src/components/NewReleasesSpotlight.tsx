"use client";
import { useEffect, useRef, useState } from "react";
import type { BuzzPersonal } from "@/lib/buzz";
import { getJSON } from "@/lib/client";
import type { Signal } from "@/lib/reco/types";
import { titleKey, type Title } from "@/lib/types";
import { playMove } from "@/lib/sound";
import { useProfile } from "./profileContext";
import { focusEl } from "./spatialNav";
import { SIGNALS } from "./TitleFeature";
import { SIGNAL_BADGE } from "./TitleCard";
import "./social.css";
import { burstHearts } from "./HeartBurst";

// «Estrenos que están dando que hablar»: destacado grande con lo recién llegado a cines y plataformas
// (/api/buzz), para valorarlo en un toque. El foco en una miniatura cambia el destacado; Enter abre la ficha.

export function NewReleasesSpotlight({ onOpen }: { onOpen: (t: Title) => void }) {
  const profile = useProfile();
  const [items, setItems] = useState<BuzzPersonal[] | null>(null);
  const [error, setError] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAction = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getJSON<{ items: BuzzPersonal[] }>(`/api/buzz?profile=${profile.id}&limit=12`, ctrl.signal).then(
      (r) => setItems(r.items),
      () => !ctrl.signal.aborted && setError(true),
    );
    return () => ctrl.abort();
  }, [profile.id]);
  useEffect(() => () => void (advance.current && clearTimeout(advance.current)), []);

  // Lo que se descarta o se marca como visto desaparece al momento (el servidor ya no lo devolverá).
  const visible = (items ?? []).filter((t) => {
    const f = profile.feedbackOf(t);
    return f !== "dislike" && f !== "not_interested" && !profile.isSeen(t);
  });
  if (error || !visible.length) return null;
  const idx = Math.max(
    0,
    visible.findIndex((t) => titleKey(t) === current),
  );
  const it = visible[idx];
  const rated = profile.feedbackOf(it);

  const rate = (s: Signal) => {
    const wasSame = rated === s;
    profile.rate(it, s);
    if (wasSame) return;
    // Tras valorar, pasa al siguiente sin valorar (el foco se queda en el mismo botón: se puede ir encadenando).
    if (advance.current) clearTimeout(advance.current);
    const nextUnrated = [...visible.slice(idx + 1), ...visible.slice(0, idx)].find((t) => !profile.feedbackOf(t));
    if (s === "love" || s === "like") advance.current = setTimeout(() => nextUnrated && setCurrent(titleKey(nextUnrated)), 650);
    else setCurrent(nextUnrated ? titleKey(nextUnrated) : null);
  };

  // Arriba/abajo entre el destacado y sus miniaturas van siempre al sitio esperado (la navegación por cercanía
  // saltaría a la franja de arriba desde las miniaturas de la derecha, lejos de los botones).
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const section = e.currentTarget;
    let to: HTMLElement | null = null;
    if (e.key === "ArrowUp" && el.classList.contains("spot-thumb")) {
      to = lastAction.current && section.contains(lastAction.current) ? lastAction.current : section.querySelector<HTMLElement>(".spot-actions button");
    } else if (e.key === "ArrowDown" && el.closest(".spot-actions")) {
      lastAction.current = el;
      to = section.querySelector<HTMLElement>('.spot-thumb[aria-current="true"]');
    } else if (e.key === "ArrowRight" && el.closest(".spot-actions") && !el.nextElementSibling && el.closest(".spot-rate")) {
      // Fin de la fila de botones: no saltar en diagonal a una miniatura (cambiaría el destacado sin querer).
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    playMove();
    focusEl(to);
  };

  // Con el mando, al entrar en cualquier botón del destacado se muestra el bloque entero (destacado + miniaturas):
  // si no, al bajar a las miniaturas el destacado quedaría medio tapado por la cabecera.
  const onFocusIn = (e: React.FocusEvent<HTMLElement>) => {
    const section = e.currentTarget;
    if (!(e.target as HTMLElement).matches(":focus-visible")) return;
    requestAnimationFrame(() => section.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const meta = [it.type === "tv" ? "Serie" : "Película", it.year].filter(Boolean).join(" · ");
  return (
    <section className="spot" aria-label="Estrenos que están dando que hablar" onKeyDown={onKeyDown} onFocus={onFocusIn}>
      <h3 className="shelf-title spot-heading">
        Estrenos que están dando que hablar
        <span className="spot-count" aria-hidden>
          {idx + 1}/{visible.length}
        </span>
      </h3>
      <div className="spot-hero">
        {it.backdrop && <img key={it.backdrop} className="spot-bg" src={it.backdrop} alt="" />}
        <div className="spot-info">
          <p className="spot-meta">{meta}</p>
          <h4 className="spot-title">{it.title}</h4>
          {it.hook.length > 0 && (
            <p className="spot-hook">
              {it.hook.map((h, i) => (
                <span key={h} className={i === 0 ? "spot-hook-lead" : undefined}>
                  {h}
                </span>
              ))}
            </p>
          )}
          {it.overview && <p className="spot-overview">{it.overview}</p>}
          <div className="spot-actions">
            <button className="btn btn--primary" onClick={() => onOpen(it)}>
              Ver ficha
            </button>
            <div className="spot-rate" role="group" aria-label={`Valora ${it.title}`}>
              {SIGNALS.map((o) => (
                <button key={o.s} className="spot-rate-btn" aria-pressed={rated === o.s} aria-label={o.label} title={o.label} onClick={(e) => {
                    if (o.s === "love" && rated !== "love") burstHearts(e.currentTarget);
                    rate(o.s);
                  }}>
                  {o.icon}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="shelf-row spot-strip">
        {visible.map((t, i) => {
          const f = profile.feedbackOf(t);
          return (
            <button
              key={titleKey(t)}
              className="spot-thumb"
              aria-current={i === idx || undefined}
              aria-label={`${t.title}. ${t.hook.join(". ")}`}
              onFocus={() => setCurrent(titleKey(t))}
              // En la tele el foco ya lo ha seleccionado y Enter abre la ficha; con el dedo, el primer toque selecciona.
              onClick={() => (i === idx ? onOpen(t) : setCurrent(titleKey(t)))}
            >
              {t.backdrop ? <img src={t.backdrop.replace("/w1280/", "/w300/")} alt="" loading="lazy" /> : <span className="poster-fallback">{t.title}</span>}
              <span className="spot-thumb-title">{t.title}</span>
              {f && <span className="badge badge--rated spot-thumb-badge">{SIGNAL_BADGE[f]}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
