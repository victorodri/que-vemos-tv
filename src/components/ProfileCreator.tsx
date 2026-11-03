"use client";
import { useEffect, useState } from "react";
import { sendJSON } from "@/lib/client";
import type { PublicProfile } from "@/lib/profiles";
import { PinPad } from "./PinPad";
import { focusFirst } from "./spatialNav";

type Step = "kind" | "name" | "members" | "avatar" | "pin";

/**
 * Alta de perfil: individual o en pareja → nombre → (pareja: con qué perfiles se enlaza) → avatar → PIN.
 * Al terminar, el perfil entra directamente en el cuestionario de gustos.
 */
export function ProfileCreator({
  profiles,
  emojis,
  colors,
  onCreated,
  onCancel,
}: {
  profiles: PublicProfile[];
  emojis: string[];
  colors: string[];
  onCreated: (p: PublicProfile, token: string) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<"single" | "couple">("single");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [emoji, setEmoji] = useState(emojis[0]);
  const [color, setColor] = useState(colors[profiles.length % colors.length]);
  const [error, setError] = useState<string | null>(null);
  const singles = profiles.filter((p) => p.kind === "single");

  useEffect(() => {
    requestAnimationFrame(focusFirst);
  }, [step]);

  const nameError = (n: string) =>
    n.trim().length < 2 ? "Escribe al menos 2 letras" : profiles.some((p) => p.name.toLowerCase() === n.trim().toLowerCase()) ? "Ya hay un perfil con ese nombre" : null;

  const order: Step[] = kind === "couple" && singles.length >= 2 ? ["kind", "name", "members", "avatar", "pin"] : ["kind", "name", "avatar", "pin"];
  const go = (dir: 1 | -1) => {
    const i = order.indexOf(step) + dir;
    if (i < 0) return onCancel();
    setError(null);
    setStep(order[i]);
  };

  const progress = (
    <div className="quiz-progress">
      <span>
        Nuevo perfil · paso {order.indexOf(step) + 1} de {order.length}
      </span>
      <div className="quiz-bar">
        <span style={{ width: `${((order.indexOf(step) + 1) / order.length) * 100}%` }} />
      </div>
    </div>
  );
  const nav = (canNext: boolean) => (
    <div className="actions quiz-nav">
      <button className="btn" onClick={() => go(-1)}>
        {step === "kind" ? "Cancelar" : "← Anterior"}
      </button>
      {step !== "kind" && (
        <button className="btn btn--primary" disabled={!canNext} onClick={() => go(1)}>
          Siguiente →
        </button>
      )}
    </div>
  );

  if (step === "pin") {
    return (
      <PinPad
        title="Elige un PIN de 4 cifras"
        hint="Se pide una sola vez en cada tele. Así nadie más puede cambiar tus valoraciones."
        confirm
        onCancel={() => go(-1)}
        onSubmit={async (pin) => {
          try {
            const r = await sendJSON<{ profile: PublicProfile; token: string }>("/api/profiles", "POST", { name: name.trim(), kind, members, emoji, color, pin });
            onCreated(r.profile, r.token);
            return null;
          } catch (e) {
            return e instanceof Error ? e.message : "No se ha podido crear el perfil";
          }
        }}
      />
    );
  }

  return (
    <main className="quiz" data-nav-modal key={step}>
      {progress}
      {step === "kind" && (
        <>
          <h2 className="quiz-title">¿Cómo vais a usar este perfil?</h2>
          <p className="quiz-hint">Un perfil en pareja busca lo que os gusta a los dos.</p>
          <div className="quiz-options">
            {(
              [
                ["single", "🙋", "Solo yo", "Recomendaciones a tu medida"],
                ["couple", "💑", "En pareja", "Lo que os gusta a los dos"],
              ] as const
            ).map(([k, icon, label, sub], i) => (
              <button
                key={k}
                className="quiz-option"
                aria-pressed={kind === k}
                data-autofocus={i === 0 || undefined}
                onClick={() => {
                  setKind(k);
                  setEmoji(k === "couple" ? "💑" : emojis[0]);
                  setStep("name");
                }}
              >
                <span className="quiz-icon">{icon}</span>
                <span>
                  {label}
                  <small className="quiz-sub">{sub}</small>
                </span>
              </button>
            ))}
          </div>
          {nav(true)}
        </>
      )}

      {step === "name" && (
        <>
          <h2 className="quiz-title">{kind === "couple" ? "¿Cómo se llama la pareja?" : "¿Cómo te llamas?"}</h2>
          <p className="quiz-hint">{kind === "couple" ? "Por ejemplo: «Rafa y Lucía»." : "Es lo que verán los demás perfiles de Qué Vemos."}</p>
          <form
            className="name-form"
            onSubmit={(e) => {
              e.preventDefault();
              const err = nameError(name);
              if (err) setError(err);
              else go(1);
            }}
          >
            <input
              className="name-input"
              value={name}
              maxLength={30}
              autoComplete="off"
              placeholder={kind === "couple" ? "Nombre de la pareja" : "Tu nombre"}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              data-autofocus
            />
            {error && <p className="error">{error}</p>}
          </form>
          {nav(!nameError(name))}
        </>
      )}

      {step === "members" && (
        <>
          <h2 className="quiz-title">¿Quiénes sois?</h2>
          <p className="quiz-hint">Opcional: si cada uno tiene ya su perfil, enlazadlos y buscaremos lo que os guste a los dos desde el principio.</p>
          <div className="quiz-options quiz-options--multi">
            {singles.map((p, i) => (
              <button
                key={p.id}
                className="quiz-option"
                aria-pressed={members.includes(p.id)}
                data-autofocus={i === 0 || undefined}
                onClick={() => setMembers((m) => (m.includes(p.id) ? m.filter((x) => x !== p.id) : m.length >= 2 ? [m[1], p.id] : [...m, p.id]))}
              >
                <span className="quiz-icon">{p.emoji}</span>
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <p className="quiz-hint">{members.length === 1 ? "Elige a la otra persona, o ninguna." : members.length === 2 ? "✓ Enlazados" : "Sin enlazar: la pareja aprenderá solo de sus propias valoraciones."}</p>
          {nav(members.length !== 1)}
        </>
      )}

      {step === "avatar" && (
        <>
          <h2 className="quiz-title">Elige tu avatar</h2>
          <div className="avatar-preview">
            <span className="avatar" style={{ background: color }}>
              {emoji}
            </span>
            <span className="profile-name">{name}</span>
          </div>
          <div className="chips chips--wrap">
            {emojis.map((e, i) => (
              <button key={e} className="chip chip--emoji" aria-pressed={emoji === e} onClick={() => setEmoji(e)} data-autofocus={(emoji === e || (i === 0 && !emojis.includes(emoji))) || undefined} aria-label={`Avatar ${e}`}>
                {e}
              </button>
            ))}
          </div>
          <div className="chips chips--wrap">
            {colors.map((c) => (
              <button key={c} className="chip chip--color" aria-pressed={color === c} onClick={() => setColor(c)} aria-label="Color">
                <span style={{ background: c }} />
              </button>
            ))}
          </div>
          {nav(true)}
        </>
      )}
    </main>
  );
}
