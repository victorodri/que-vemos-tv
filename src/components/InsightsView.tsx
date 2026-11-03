"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/client";
import type { ProfileInsights, Trait } from "@/lib/reco/insights";
import { useProfile } from "./profileContext";

// Cada bloque es un botón sin acción para que el mando pueda recorrer la página (como «Qué dice la crítica»).
const noop = () => {};
const DATE = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
});

function Bars({ traits, negative }: { traits: Trait[]; negative?: boolean }) {
  return (
    <ul className="traits">
      {traits.map((t) => (
        <li key={t.label} className={negative ? "trait trait--neg" : "trait"}>
          <span className="trait-label">{t.label}</span>
          <span className="trait-bar" aria-hidden="true">
            <span
              style={{ width: `${Math.max(8, Math.abs(t.weight) * 100)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** «Lo que hemos aprendido de ti»: conclusiones del algoritmo, gustos, uso de las tiras y métricas clave. */
export function InsightsView() {
  const profile = useProfile();
  const [data, setData] = useState<ProfileInsights | null>(null);
  const [error, setError] = useState(false);
  const te = profile.plural ? "vosotros" : "ti";

  useEffect(() => {
    let alive = true;
    getJSON<ProfileInsights>(`/api/insights?profile=${profile.id}`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [profile.id]);

  if (error)
    return <p className="hint">No se han podido cargar tus insights.</p>;
  if (!data) return <p className="loading">Analizando tus gustos…</p>;
  const c = data.counts;

  return (
    <section
      className="insights"
      aria-label={`Lo que hemos aprendido de ${te}`}
    >
      <h2>Lo que hemos aprendido de {te}</h2>
      <p className="hint">
        Sale de {c.love} ❤️, {c.like} 👍, {c.dislike + c.notInterested} 👎/🚫,{" "}
        {c.seen} vistos, {c.list} en la lista y de cómo{" "}
        {profile.plural ? "usáis" : "usas"} la app.
      </p>

      {data.summary.length > 0 && (
        <button
          className="insight-block"
          onClick={noop}
          data-autofocus
          aria-label={data.summary.join(" ")}
        >
          <ul className="insight-summary">
            {data.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </button>
      )}

      <div className="insight-grid">
        {data.likes.map((g) => (
          <button
            key={g.group}
            className="insight-card"
            onClick={noop}
            aria-label={`${g.group}: ${g.traits.map((t) => t.label).join(", ")}`}
          >
            <h3>{g.group}</h3>
            <Bars traits={g.traits} />
          </button>
        ))}
        {data.avoids.length > 0 && (
          <button className="insight-card" onClick={noop}>
            <h3>Lo que {profile.plural ? "evitáis" : "evitas"}</h3>
            <Bars traits={data.avoids} negative />
          </button>
        )}
      </div>

      <h3 className="insight-sub">Métricas clave</h3>
      <button className="kpis insight-block" onClick={noop}>
        {data.kpis.map((k) => (
          <span key={k.label} className="kpi">
            <span className="kpi-value">{k.value}</span>
            <span className="kpi-label">{k.label}</span>
            {k.hint && <span className="kpi-hint">{k.hint}</span>}
          </span>
        ))}
      </button>

      {data.shelves.length > 0 && (
        <>
          <h3 className="insight-sub">
            Las tiras que más {profile.plural ? "usáis" : "usas"}
          </h3>
          <button className="insight-block" onClick={noop}>
            <ul className="traits">
              {data.shelves.map((s) => (
                <li
                  key={s.title}
                  className={s.hidden ? "trait trait--off" : "trait"}
                >
                  <span className="trait-label">
                    {s.title}
                    {s.hidden ? " · retirada" : ""}
                  </span>
                  <span className="trait-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(4, s.rate * 100)}%` }} />
                  </span>
                  <span className="trait-num">
                    {Math.round(s.rate * 100)} %
                  </span>
                </li>
              ))}
            </ul>
          </button>
        </>
      )}

      {data.log.length > 0 && (
        <>
          <h3 className="insight-sub">Últimas conclusiones</h3>
          <button className="insight-block" onClick={noop}>
            <ul className="insight-log">
              {data.log.map((i) => (
                <li key={i.t + i.text}>
                  <span className="insight-date">{DATE.format(i.t)}</span>{" "}
                  {i.text}
                </li>
              ))}
            </ul>
          </button>
        </>
      )}
    </section>
  );
}
