"use client";
import { useEffect, useState } from "react";
import { DEFAULT_PREFS, GENRE_GROUPS, type GenreGroupId, type Prefs } from "@/lib/prefs";
import type { Meta } from "@/lib/types";
import { focusFirst } from "./spatialNav";

interface Option {
  value: string;
  label: string;
  icon?: string;
  logo?: string | null;
}

interface Step {
  title: string;
  hint?: string;
  multi?: boolean;
  /** En pasos múltiples, si se puede avanzar sin elegir nada. */
  optional?: boolean;
  options: Option[];
  get: (a: Answers) => string[];
  set: (a: Answers, values: string[]) => Answers;
}

type Answers = Prefs & { platforms: number[] };

const genreOptions = (exclude: string[] = []): Option[] =>
  GENRE_GROUPS.filter((g) => !exclude.includes(g.id)).map((g) => ({ value: g.id, label: g.label, icon: g.emoji }));

function buildSteps(pareja: boolean, meta: Meta): Step[] {
  // Mismas preguntas para todos; solo cambia la persona (tú / vosotros).
  const w = (tu: string, vosotros: string) => (pareja ? vosotros : tu);
  return [
    {
      title: w("¿Qué sueles ver más?", "¿Qué soléis ver más?"),
      options: [
        { value: "movie", label: "Películas", icon: "🎬" },
        { value: "tv", label: "Series", icon: "📺" },
        { value: "both", label: "Las dos", icon: "🍿" },
      ],
      get: (a) => [a.types.length > 1 ? "both" : a.types[0]],
      set: (a, [v]) => ({ ...a, types: v === "both" ? ["movie", "tv"] : [v as "movie" | "tv"] }),
    },
    {
      title: w("¿Qué géneros te gustan?", "¿Qué géneros os gustan?"),
      hint: "Elige todos los que quieras y pulsa «Siguiente».",
      multi: true,
      options: genreOptions(),
      get: (a) => a.likes,
      set: (a, v) => ({ ...a, likes: v as GenreGroupId[], avoid: a.avoid.filter((x) => !v.includes(x)) }),
    },
    {
      title: w("¿Hay algo que no quieras ver nunca?", "¿Hay algo que no queráis ver nunca?"),
      hint: "Opcional. No os lo recomendaremos.",
      multi: true,
      optional: true,
      options: [],
      get: (a) => a.avoid,
      set: (a, v) => ({ ...a, avoid: v as GenreGroupId[] }),
    },
    {
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
      title: w("¿De qué época lo prefieres?", "¿De qué época lo preferís?"),
      options: [
        { value: "new", label: "Novedades (últimos años)", icon: "✨" },
        { value: "modern", label: "Del 2000 en adelante", icon: "📅" },
        { value: "any", label: "Me da igual, clásicos también", icon: "🎞️" },
      ],
      get: (a) => [a.era],
      set: (a, [v]) => ({ ...a, era: v as Prefs["era"] }),
    },
    {
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
      title: w("¿Éxitos conocidos o joyas ocultas?", "¿Éxitos conocidos o joyas ocultas?"),
      options: [
        { value: "popular", label: "Lo que está de moda", icon: "🔥" },
        { value: "hidden", label: "Joyas menos conocidas", icon: "💎" },
        { value: "mix", label: "Un poco de todo", icon: "🎲" },
      ],
      get: (a) => [a.discovery],
      set: (a, [v]) => ({ ...a, discovery: v as Prefs["discovery"] }),
    },
    {
      title: w("¿Qué plataformas tienes?", "¿Qué plataformas tenéis?"),
      hint: "Recomendaremos solo lo que está en ellas. Si no eliges ninguna, se busca en todas.",
      multi: true,
      optional: true,
      options: meta.providers.map((p) => ({ value: String(p.id), label: p.name, logo: p.logo })),
      get: (a) => a.platforms.map(String),
      set: (a, v) => ({ ...a, platforms: v.map(Number) }),
    },
  ];
}

export function Questionnaire({
  name,
  pareja,
  meta,
  initial,
  initialPlatforms,
  onDone,
  onCancel,
}: {
  name: string;
  pareja: boolean;
  meta: Meta;
  initial: Prefs | null;
  initialPlatforms: number[];
  onDone: (prefs: Prefs, platforms: number[]) => void;
  /** Solo al repetir el cuestionario: salir sin guardar. */
  onCancel?: () => void;
}) {
  const steps = buildSteps(pareja, meta);
  const [index, setIndex] = useState(-1); // -1 = bienvenida
  const [answers, setAnswers] = useState<Answers>({ ...DEFAULT_PREFS, likes: [], ...initial, platforms: initialPlatforms });

  useEffect(() => {
    requestAnimationFrame(focusFirst);
  }, [index]);

  const finish = (a: Answers) => {
    const { platforms, ...prefs } = a;
    onDone(prefs, platforms);
  };
  const next = (a: Answers) => (index === steps.length - 1 ? finish(a) : setIndex(index + 1));

  if (index === -1) {
    return (
      <main className="quiz" data-nav-modal>
        <h1 className="logo logo--big">
          Qué <span>Vemos</span>
        </h1>
        <h2 className="quiz-title">¡Hola, {name}!</h2>
        <p className="quiz-hint">
          {pareja ? "Antes de empezar, contestad" : "Antes de empezar, contesta"} {steps.length} preguntas rápidas para saber qué{" "}
          {pareja ? "os" : "te"} recomendamos. Se pueden cambiar cuando {pareja ? "queráis" : "quieras"}.
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

  const step = steps[index];
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
      <p className="quiz-progress">
        Pregunta {index + 1} de {steps.length}
      </p>
      <div className="quiz-bar">
        <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
      </div>
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
        <button className="btn" onClick={() => setIndex(index - 1)}>
          ← Anterior
        </button>
        {(step.multi || selected[0]) && (
          <button className="btn btn--primary" disabled={!canContinue} onClick={() => next(answers)}>
            {index === steps.length - 1 ? "✓ Terminar" : step.multi && !selected.length ? "Saltar →" : "Siguiente →"}
          </button>
        )}
      </div>
    </main>
  );
}
