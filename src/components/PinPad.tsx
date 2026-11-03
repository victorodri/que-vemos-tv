"use client";
import { useEffect, useRef, useState } from "react";
import { focusFirst, useBackHandler } from "./spatialNav";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✕"];

/**
 * Teclado de PIN para el mando (flechas + OK) y también para las teclas numéricas del mando o del teclado.
 * `confirm`: pide el PIN dos veces (al crearlo). `onSubmit` devuelve un mensaje de error o null si ha ido bien.
 */
export function PinPad({
  title,
  hint,
  confirm = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  hint?: string;
  confirm?: boolean;
  onSubmit: (pin: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  // El PIN vive en una ref: con pulsaciones rápidas del mando el estado de React aún no se ha actualizado.
  const pinRef = useRef("");
  const firstRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const [pin, setPinState] = useState("");
  const [first, setFirstState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const setPin = (v: string) => ((pinRef.current = v), setPinState(v));
  const setFirst = (v: string | null) => ((firstRef.current = v), setFirstState(v));
  const setBusy = (v: boolean) => ((busyRef.current = v), setBusyState(v));

  useEffect(() => {
    requestAnimationFrame(focusFirst);
  }, []);
  // Atrás del mando = cancelar.
  useBackHandler(true, onCancel);

  const submit = async (value: string) => {
    if (confirm && firstRef.current === null) {
      setFirst(value);
      setPin("");
      return;
    }
    if (confirm && firstRef.current !== value) {
      setError("Los PIN no coinciden. Vuelve a empezar.");
      setFirst(null);
      setPin("");
      return;
    }
    setBusy(true);
    const err = await onSubmit(value);
    setBusy(false);
    if (err) {
      setError(err);
      setPin("");
      if (confirm) setFirst(null);
    }
  };

  const press = (k: string) => {
    if (busyRef.current) return;
    if (k === "✕") return onCancel();
    if (k === "⌫") return setPin(pinRef.current.slice(0, -1));
    setError(null);
    const next = (pinRef.current + k).slice(0, 4);
    setPin(next);
    if (next.length === 4) void submit(next);
  };

  // Teclas numéricas del mando o del teclado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace" && pinRef.current) {
        e.preventDefault();
        e.stopPropagation();
        press("⌫");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="pin-overlay" data-nav-modal role="dialog" aria-label={title}>
      <div className="pin-box">
        <h2 className="quiz-title">{confirm && first !== null ? "Repite el PIN" : title}</h2>
        {hint && <p className="quiz-hint">{hint}</p>}
        <div className="pin-dots" aria-live="polite" aria-label={`${pin.length} de 4 cifras`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i < pin.length ? "pin-dot pin-dot--on" : "pin-dot"} />
          ))}
        </div>
        {error && <p className="error pin-error">{error}</p>}
        {busy && <p className="hint">Comprobando…</p>}
        <div className="pin-keys">
          {KEYS.map((k, i) => (
            <button key={k} className={`pin-key${k === "✕" ? " pin-key--muted" : ""}`} onClick={() => press(k)} data-autofocus={i === 0 || undefined} aria-label={k === "⌫" ? "Borrar" : k === "✕" ? "Cancelar" : k}>
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
