"use client";
import "./tvkeyboard.css";
import { useEffect, useRef, useState } from "react";
import { focusFirst, useBackHandler } from "./spatialNav";

// Escritura con el mando. En la tele (Fire TV, Android TV…) el teclado del sistema no siempre se abre desde un
// WebView, así que la app trae el suyo: una rejilla de letras que se recorre con las flechas y OK (como YouTube o
// Netflix en la tele). En el móvil y el ordenador se usa el campo de texto normal.

const ROWS = [
  ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  ["k", "l", "m", "n", "ñ", "o", "p", "q", "r", "s"],
  ["t", "u", "v", "w", "x", "y", "z", "á", "é", "í"],
  ["ó", "ú", "1", "2", "3", "4", "5", "6", "7", "8"],
  ["9", "0", "-", "'", ".", ",", "&", ":", "!", "?"],
];

const TV_UA = /QueVemosTV|AFT[A-Z]|Android TV|GoogleTV|SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AppleTV|CrKey|HbbTV/i;

/** ¿Estamos en una tele? (APK de QuéVer, Fire TV, Android TV, navegadores de Smart TV). `?tv=1` lo fuerza para probar. */
export function useIsTv(): boolean {
  const [tv, setTv] = useState(false);
  useEffect(() => {
    let forced: string | null = null;
    try {
      const q = new URLSearchParams(location.search).get("tv");
      if (q !== null) localStorage.setItem("quevemos:tv", q);
      forced = localStorage.getItem("quevemos:tv");
    } catch {}
    setTv(forced === "1" || (forced !== "0" && TV_UA.test(navigator.userAgent)));
  }, []);
  return tv;
}

/** Panel de teclado en pantalla. Atrás lo cierra conservando lo escrito. */
export function TvKeyboard({
  value,
  onChange,
  onDone,
  onClose,
  title,
  doneLabel = "Listo",
  maxLength = 60,
}: {
  value: string;
  onChange: (v: string) => void;
  onDone: (v: string) => void;
  onClose: () => void;
  title: string;
  doneLabel?: string;
  maxLength?: number;
}) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const set = (v: string) => {
    valueRef.current = v.slice(0, maxLength);
    onChange(valueRef.current);
  };
  const [upper, setUpper] = useState(false);

  useEffect(() => {
    // setTimeout y no requestAnimationFrame: en algunos WebView de tele el rAF llega tarde y la primera flecha se pierde.
    const t = setTimeout(focusFirst, 0);
    return () => clearTimeout(t);
  }, []);
  useBackHandler(true, onClose);

  // Teclado físico o del mando con letras: también escribe aquí.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 && /[\p{L}\p{N} .,'&:!?-]/u.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        set(valueRef.current + e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        set(valueRef.current.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const type = (ch: string) => set(valueRef.current + (upper ? ch.toLocaleUpperCase("es") : ch));

  return (
    <div className="tvkb-overlay" data-nav-modal role="dialog" aria-label={title}>
      <div className="tvkb">
        <p className="tvkb-title">{title}</p>
        <div className="tvkb-display" aria-live="polite">
          {value ? <span>{value}</span> : <span className="tvkb-placeholder">Escribe con las flechas y OK</span>}
          <span className="tvkb-caret" aria-hidden="true" />
        </div>
        <div className="tvkb-grid">
          {ROWS.map((row, r) => (
            <div key={r} className="tvkb-row" data-nav-row>
              {row.map((ch, i) => (
                <button key={ch} className="tvkb-key" onClick={() => type(ch)} data-autofocus={(r === 0 && i === 0) || undefined}>
                  {upper ? ch.toLocaleUpperCase("es") : ch}
                </button>
              ))}
            </div>
          ))}
          <div className="tvkb-row tvkb-row--actions" data-nav-row>
            <button className="tvkb-key tvkb-key--wide" onClick={() => set(valueRef.current + " ")}>
              ␣ Espacio
            </button>
            <button className="tvkb-key tvkb-key--wide" onClick={() => set(valueRef.current.slice(0, -1))} aria-label="Borrar letra">
              ⌫ Borrar
            </button>
            <button className="tvkb-key tvkb-key--wide" onClick={() => setUpper((u) => !u)} aria-pressed={upper}>
              ⇧ {upper ? "abc" : "ABC"}
            </button>
            <button className="tvkb-key tvkb-key--wide" onClick={() => set("")} disabled={!value}>
              Vaciar
            </button>
            <button className="tvkb-key tvkb-key--wide tvkb-key--done" onClick={() => onDone(valueRef.current)}>
              ✓ {doneLabel}
            </button>
          </div>
        </div>
        <p className="tvkb-hint">Atrás para cerrar el teclado</p>
      </div>
    </div>
  );
}

/**
 * Campo de texto que funciona con el mando: en la tele es un botón que abre el teclado en pantalla; en el resto,
 * un `<input>` normal. `onSubmit` se llama al pulsar «Listo» (o Enter en el campo normal).
 */
export function TvTextField({
  value,
  onChange,
  onSubmit,
  placeholder,
  className,
  title,
  doneLabel,
  maxLength,
  autoFocus,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder: string;
  className?: string;
  title?: string;
  doneLabel?: string;
  maxLength?: number;
  autoFocus?: boolean;
  type?: "text" | "search";
}) {
  const tv = useIsTv();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (!tv) {
    return (
      <input
        type={type}
        className={className}
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        enterKeyHint={type === "search" ? "search" : "done"}
        autoComplete="off"
        data-autofocus={autoFocus || undefined}
      />
    );
  }

  const close = () => {
    setOpen(false);
    setTimeout(() => btnRef.current?.focus({ preventScroll: true }), 0);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${className ?? ""} tv-field`}
        onClick={() => setOpen(true)}
        aria-label={value ? `${placeholder}: ${value}` : placeholder}
        data-autofocus={autoFocus || undefined}
      >
        <span className={value ? "tv-field-value" : "tv-field-placeholder"}>{value || placeholder}</span>
        <span className="tv-field-icon" aria-hidden="true">
          ⌨
        </span>
      </button>
      {open && (
        <TvKeyboard
          value={value}
          onChange={onChange}
          title={title ?? placeholder}
          doneLabel={doneLabel}
          maxLength={maxLength}
          onClose={close}
          onDone={(v) => {
            close();
            onSubmit?.(v);
          }}
        />
      )}
    </>
  );
}
