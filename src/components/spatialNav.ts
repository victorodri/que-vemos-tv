"use client";
import { useEffect, useRef } from "react";

// Navegación con las flechas del mando (Fire TV / Android TV envían ArrowUp…, Enter y Back).
// Busca el elemento enfocable más cercano en la dirección pulsada según su posición en pantalla.

type Dir = "up" | "down" | "left" | "right";
const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), a[href]";

const isTextInput = (el: Element | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && ["text", "search"].includes(el.type);

function scope(): ParentNode {
  const modals = document.querySelectorAll("[data-nav-modal]");
  return modals[modals.length - 1] ?? document;
}

function candidates(): HTMLElement[] {
  return focusables(scope());
}

/** Distancia entre dos intervalos (0 si se solapan). */
const gap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, b1 - a2, a1 - b2);

function nearest(from: HTMLElement, dir: Dir, items: HTMLElement[]): HTMLElement | null {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    let primary: number;
    let ortho: number;
    if (dir === "right" || dir === "left") {
      if (dir === "right" ? bx <= cx + 1 : bx >= cx - 1) continue;
      primary = dir === "right" ? Math.max(0, b.left - r.right) : Math.max(0, r.left - b.right);
      ortho = gap(r.top, r.bottom, b.top, b.bottom);
    } else {
      if (dir === "down" ? by <= cy + 1 : by >= cy - 1) continue;
      primary = dir === "down" ? Math.max(0, b.top - r.bottom) : Math.max(0, r.top - b.bottom);
      ortho = gap(r.left, r.right, b.left, b.right);
    }
    // Penaliza mucho salirse de la fila/columna; desempata por cercanía de centros.
    const score = primary + ortho * 4 + Math.hypot(bx - cx, by - cy) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Elementos enfocables visibles dentro de un contenedor, en orden del documento. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

export function focusEl(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

/** Enfoca el elemento marcado con data-autofocus (o el primero enfocable) dentro del ámbito activo. */
export function focusFirst() {
  const root = scope();
  focusEl(root.querySelector<HTMLElement>("[data-autofocus]") ?? candidates()[0]);
}

export function useSpatialNav(onBack: () => void) {
  const backRef = useRef(onBack);
  backRef.current = onBack;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || (e.key === "Backspace" && !isTextInput(active))) {
        e.preventDefault();
        backRef.current();
        return;
      }
      const dir = KEY_DIR[e.key];
      if (!dir) return;
      // Dentro de un campo de texto, izquierda/derecha mueven el cursor hasta llegar al borde.
      if (isTextInput(active) && (dir === "left" || dir === "right")) {
        const start = active.selectionStart ?? 0;
        const end = active.selectionEnd ?? 0;
        if (dir === "left" && (start > 0 || end > 0)) return;
        if (dir === "right" && end < active.value.length) return;
      }
      e.preventDefault();
      const items = candidates();
      const current = active instanceof HTMLElement && items.includes(active) ? active : null;
      if (!current) return focusFirst();
      // Al bajar desde la barra de pestañas se entra por el elemento principal de la vista (el de data-autofocus),
      // no por el que quede justo debajo de la pestaña: así «abajo» siempre lleva al mismo sitio.
      if (dir === "down" && current.closest("[data-nav-header]")) {
        const entry = document.querySelector<HTMLElement>("main [data-autofocus]");
        if (entry && items.includes(entry)) return focusEl(entry);
      }
      focusEl(nearest(current, dir, items));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
