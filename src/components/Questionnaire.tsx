"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/client";
import { DEFAULT_PREFS, GENRE_GROUPS, type GenreGroupId, type Prefs } from "@/lib/prefs";
import type { FeedbackEntry, Signal } from "@/lib/reco/types";
import { titleKey, type Meta, type Title } from "@/lib/types";
import { focusFirst } from "./spatialNav";

/** Valoraciones hechas en el paso de pósters: clave "movie:123" → señal + título. */
export type QuizRatings = Record<string, { signal: Signal; item: Title }>;

interface Option {
  value: string;
  label: string;
  icon?: string;
  logo?: string | null;
}

interface ChoiceStep {
  kind: "choice";
  title: string;
  hint?: string;
  multi?: boolean;
  /** En pasos múltiples, si se puede avanzar sin elegir nada. */
  optional?: boolean;
  options: Option[];
  get: (a: Answers) => string[];
  set: (a: Answers, values: string[]) => Answers;
}

interface SeedsStep {
  kind: "seeds";
  title: string;
  hint: string;
}

type Step = ChoiceStep | SeedsStep;
type Answers = Prefs & { platforms: number[] };

// OK sobre un póster va rotando: sin marcar → me gustó → me encantó → no me gustó → sin marcar.
const CYCLE: (Signal | undefined)[] = [undefined, "like", "love", "dislike"];
const SEED_BADGE: Partial<Record<Signal, { icon: string; label: string }>> = {
  like: { icon: "👍", label: "Me gustó" },
  love: { icon: "❤️", label: "Me encantó" },
  dislike: { icon: "👎", label: "No me gustó" },
};
const MIN_RATINGS = 5;

const genreOptions = (exclude: string[] = []): Option[] =>
  GENRE_GROUPS.filter((g) => !exclude.includes(g.id)).map((g) => ({ value: g.id, label: g.label, icon: g.emoji }));

function buildSteps(pareja: boolean, meta: Meta, withSeeds: boolean): Step[] {
  // Mismas preguntas para todos; solo cambia la persona (tú / vosotros).
  const w = (tu: string, vosotros: string) => (pareja ? vosotros : tu);
  const steps: Step[] = [
    {
      kind: "choice",
      title: w("¿Qué te apetece más?", "¿Qué os apetece más?"),
      options: [
        { value: "movie", label: "Películas", icon: "🎬" },
        { value: "tv", label: "Series", icon: "📺" },
        { value: "both", label: "Las dos", icon: "🍿" },
      ],
      get: (a) => [a.types.length > 1 ? "both" : a.types[0]],
      set: (a, [v]) => ({ ...a, types: v === "both" ? ["movie", "tv"] : [v as "movie" | "tv"] }),
    },
    {
      kind: "seeds",
      title: w("Puntúa lo que hayas visto", "Puntuad lo que hayáis visto"),
      hint: "Pulsa OK sobre un póster para cambiar: 👍 me gustó → ❤️ me encantó → 👎 no me gustó. Lo que no hayáis visto, déjalo sin marcar.",
    },
    {
      kind: "choice",
      title: w("¿Qué géneros te gustan?", "¿Qué géneros os gustan?"),
      hint: "Marca todos los que quieras y pulsa «Siguiente».",
      multi: true,
      options: genreOptions(),
      get: (a) => a.likes,
      set: (a, v) => ({ ...a, likes: v as GenreGroupId[], avoid: a.avoid.filter((x) => !v.includes(x)) }),
    },
    {
      kind: "choice",
      title: w("¿Algo que no quieras ver nunca?", "¿Algo que no queráis ver nunca?"),
      hint: "Opcional: nunca te lo recomendaremos.",
      multi: true,
      optional: true,
      options: [],
      get: (a) => a.avoid,
      set: (a, v) => ({ ...a, avoid: v as GenreGroupId[] }),
    },
    {
      kind: "choice",
      title: w("¿Cuánto tiempo sueles tener?", "¿Cuánto tiempo soléis tener?"),
      options: [
        { value: "short", label: "Poco: algo cortito", icon: "⏱️" },
        { value: "normal", label: "Lo normal (hasta ~2 h)", icon: "🕘" },
        { value: "any", label: "Me da igual lo que dure", icon: "♾️" },
      ],
      get: (a) => [a.runtime],
      set: (a, [v]) => ({ ...a, runtime: v as Prefs["runtime"] }),
    },
    {
      kind: "choice",
      title: w("¿De qué época?", "¿De qué época?"),
      options: [
        { value: "new", label: "Novedades (últimos años)", icon: "✨" },
        { value: "modern", label: "Del 2000 en adelante", icon: "📅" },
        { value: "any", label: "Me da igual, clásicos también", icon: "🎞️" },
      ],
      get: (a) => [a.era],
      set: (a, [v]) => ({ ...a, era: v as Prefs["era"] }),
    },
    {
      kind: "choice",
      title: w("¿Cómo de exigente eres?", "¿Cómo de exigentes sois?"),
      options: [
        { value: "top", label: "Solo lo mejor (★ 7,5+)", icon: "🏆" },
        { value: "good", label: "Que esté bien (★ 6,5+)", icon: "👍" },
        { value: "any", label: "Me vale cualquier cosa", icon: "🤷" },
      ],
      get: (a) => [a.quality],
      set: (a, [v]) => ({ ...a, quality: v as Prefs["quality"] }),
    },
    {
      kind: "choice",
      title: "¿Éxitos conocidos o joyas ocultas?",
      options: [
        { value: "popular", label: "Lo que está de moda", icon: "🔥" },
        { value: "hidden", label: "Joyas menos conocidas", icon: "💎" },
        { value: "mix", label: "Un poco de todo", icon: "🎲" },
      ],
      get: (a) => [a.discovery],
      set: (a, [v]) => ({ ...a, discovery: v as Prefs["discovery"] }),
    },
    {
      kind: "choice",
      title: w("¿Qué plataformas tienes?", "¿Qué plataformas tenéis?"),
      hint: "Recomendaremos solo lo que esté en ellas. Si no marcas ninguna, buscamos en todas.",
      multi: true,
      optional: true,
      options: meta.providers.map((p) => ({ value: String(p.id), label: p.name, logo: p.logo })),
      get: (a) => a.platforms.map(String),
      set: (a, v) => ({ ...a, platforms: v.map(Number) }),
    },
  ];
  return withSeeds ? steps : steps.filter((s) => s.kind !== "seeds");
}

type SeedsState = { status: "loading" | "ready" | "error"; items: Title[]; forType: string };

export function Questionnaire({
  profileId,
  name,
  pareja,
  meta,
  initial,
  initialPlatforms,
  initialFeedback,
  onDone,
  onCancel,
}: {
  profileId: string;
  name: string;
  pareja: boolean;
  meta: Meta;
  initial: Prefs | null;
  initialPlatforms: number[];
  initialFeedback: Record<string, FeedbackEntry>;
  onDone: (prefs: Prefs, platforms: number[], ratings: QuizRatings) => void;
  /** Solo al repetir el cuestionario: salir sin guardar. */
  onCancel?: () => void;
}) {
  const [index, setIndex] = useState(-1); // -1 = bienvenida
  const [answers, setAnswers] = useState<Answers>({ ...DEFAULT_PREFS, likes: [], ...initial, platforms: initialPlatforms });
  const [ratings, setRatings] = useState<Record<string, Signal | undefined>>({});
  const [seeds, setSeeds] = useState<SeedsState>({ status: "loading", items: [], forType: "" });

  const seedType = answers.types.length > 1 ? "all" : answers.types[0];

  // Las semillas dependen de si quiere pelis, series o las dos: se piden al cambiar esa respuesta.
  useEffect(() => {
    const ctrl = new AbortController();
    setSeeds({ status: "loading", items: [], forType: seedType });
    getJSON<{ items: Title[] }>(`/api/reco/seeds?profile=${profileId}&type=${seedType}`, ctrl.signal).then(
      (r) => setSeeds({ status: r.items?.length ? "ready" : "error", items: r.items ?? [], forType: seedType }),
      () => !ctrl.signal.aborted && setSeeds({ status: "error", items: [], forType: seedType }),
    );
    return () => ctrl.abort();
  }, [profileId, seedType]);

  const steps = buildSteps(pareja, meta, seeds.status !== "error");

  useEffect(() => {
    requestAnimationFrame(focusFirst);
  }, [index, seeds.status]);

  const signalOf = (t: Title): Signal | undefined => {
    const k = titleKey(t);
    return k in ratings ? ratings[k] : (initialFeedback[k]?.s as Signal | undefined);
  };

  const finish = (a: Answers) => {
    const { platforms, ...prefs } = a;
    const out: QuizRatings = {};
    for (const item of seeds.items) {
      const s = signalOf(item);
      if (s && s !== "not_interested") out[titleKey(item)] = { signal: s, item };
    }
    onDone(prefs, platforms, out);
  };
  const next = (a: Answers) => (index >= steps.length - 1 ? finish(a) : setIndex(index + 1));

  if (index === -1) {
    return (
      <main className="quiz" data-nav-modal>
        <h1 className="logo logo--big">
          Qué <span>Vemos</span>
        </h1>
        <h2 className="quiz-title">¡Hola, {name}!</h2>
        <p className="quiz-hint">
          {pareja ? "Contadnos" : "Cuéntanos"} un poco qué {pareja ? "os gusta" : "te gusta"} y {pareja ? "os" : "te"} recomendaremos mejor.
          Son {steps.length} pasos rápidos y luego la app sigue aprendiendo con cada «me gusta».
        </p>
        <div className="actions">
          <button className="btn btn--primary btn--big" data-autofocus onClick={() => setIndex(0)}>
            Empezar →
          </button>
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Cancelar
            </button>
          )}
        </div>
      </main>
    );
  }

  const step = steps[Math.min(index, steps.length - 1)];
  const progress = (
    <>
      <p className="quiz-progress">
        Paso {index + 1} de {steps.length}
      </p>
      <div className="quiz-bar">
        <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
      </div>
    </>
  );

  if (step.kind === "seeds") {
    const rated = seeds.items.filter((t) => signalOf(t)).length;
    return (
      <main className="quiz quiz--seeds" data-nav-modal key={`seeds-${index}`}>
        {progress}
        <h2 className="quiz-title">{step.title}</h2>
        <p className="quiz-hint">{step.hint}</p>
        {seeds.status === "loading" && <p className="loading">Cargando títulos…</p>}
        {seeds.status === "ready" && (
          <div className="seeds">
            {seeds.items.map((t, i) => {
              const s = signalOf(t);
              const badge = s ? SEED_BADGE[s] : undefined;
              return (
                <button
                  key={titleKey(t)}
                  className="seed"
                  aria-pressed={Boolean(badge)}
                  data-signal={s}
                  aria-label={`${t.title}${badge ? `: ${badge.label}` : ""}`}
                  data-autofocus={i === 0 || undefined}
                  onClick={() => {
                    const pos = CYCLE.indexOf(s);
                    setRatings((r) => ({ ...r, [titleKey(t)]: CYCLE[(pos + 1) % CYCLE.length] }));
                  }}
                >
                  {t.poster ? <img src={t.poster} alt="" loading="lazy" /> : <span className="poster-fallback">{t.title}</span>}
                  {badge && (
                    <span className="seed-badge">
                      {badge.icon} {badge.label}
                    </span>
                  )}
                  <span className="seed-title">{t.title}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="seeds-footer">
          <p className="quiz-hint quiz-count">
            <strong>{rated}</strong> valorada{rated === 1 ? "" : "s"} · cuantas más, mejor
            {rated < MIN_RATINGS ? ` (mínimo ${MIN_RATINGS} recomendado)` : " ✓"}
          </p>
          <div className="actions quiz-nav">
            <button className="btn" onClick={() => setIndex(index - 1)}>
              ← Anterior
            </button>
            <button className="btn btn--primary" onClick={() => next(answers)}>
              {rated ? "Siguiente →" : "Saltar →"}
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Lo que ya gusta no puede estar también en «no ver nunca».
  const options = step.options.length ? step.options : genreOptions(answers.likes);
  const selected = step.get(answers);
  const canContinue = step.optional || selected.length > 0;

  const choose = (value: string) => {
    if (step.multi) {
      setAnswers(step.set(answers, selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]));
    } else {
      const a = step.set(answers, [value]);
      setAnswers(a);
      next(a);
    }
  };

  return (
    <main className="quiz" data-nav-modal key={index}>
      {progress}
      <h2 className="quiz-title">{step.title}</h2>
      {step.hint && <p className="quiz-hint">{step.hint}</p>}

      <div className={`quiz-options${step.multi ? " quiz-options--multi" : ""}`}>
        {options.map((o, i) => (
          <button
            key={o.value}
            className="quiz-option"
            aria-pressed={selected.includes(o.value)}
            onClick={() => choose(o.value)}
            data-autofocus={(step.multi ? i === 0 : selected[0] === o.value || (!selected[0] && i === 0)) || undefined}
          >
            {o.logo ? <img src={o.logo} alt="" /> : o.icon ? <span className="quiz-icon">{o.icon}</span> : null}
            <span>{o.label}</span>
          </button>
        ))}
      </div>

      <div className="actions quiz-nav">
        {/* En la primera pregunta vuelve a la bienvenida, donde está «Cancelar» al repetir el cuestionario. */}
        <button className="btn" onClick={() => setIndex(index - 1)}>
          ← Anterior
        </button>
        {(step.multi || selected[0]) && (
          <button className="btn btn--primary" disabled={!canContinue} onClick={() => next(answers)}>
            {index === steps.length - 1 ? "✓ Terminar" : step.optional && !selected.length ? "Saltar →" : "Siguiente →"}
          </button>
        )}
      </div>
    </main>
  );
}
