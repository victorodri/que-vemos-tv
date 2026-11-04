"use client";
import { useEffect, useRef } from "react";
import { installSoundUnlock, playMove, playSelect } from "@/lib/sound";

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

// ---------- Geometría ----------
// Una sola lectura de posiciones por pulsación (getBoundingClientRect en lote) y solo de lo que está cerca de la
// pantalla: con cientos de tarjetas, leer todo en cada flecha era lo que hacía lenta la navegación en Fire TV.

type Box = { el: HTMLElement; r: DOMRect };

/** Listas horizontales: izquierda/derecha se mueven dentro de ellas y se recuerda la última posición. */
const ROW_SEL = "[data-nav-row], .shelf-row, .spot-strip, .tabs, .chips, .feedback, .spot-rate, .actions, .profiles, .reviews-tags";
const rowOf = (el: Element) => el.closest(ROW_SEL);
const lastInRow = new WeakMap<Element, HTMLElement>();
/** Último elemento enfocado en cada vista (pestaña): al bajar desde el menú se vuelve a él. */
const lastInView = new WeakMap<Element, HTMLElement>();
/** Columna «pegajosa»: al subir y bajar por estanterías se mantiene la x de partida, como en las apps de TV. */
let stickyX: number | null = null;

function boxes(): Box[] {
  const vh = window.innerHeight;
  const out: Box[] = [];
  for (const el of scope().querySelectorAll<HTMLElement>(FOCUSABLE)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > -2 * vh && r.top < 3 * vh) out.push({ el, r });
  }
  return out;
}

const cx = (r: DOMRect) => r.left + r.width / 2;
const inHeader = (el: Element) => !!el.closest("[data-nav-header]");

function horizontal(from: Box, dir: "left" | "right", all: Box[]): HTMLElement | null {
  // 1) Dentro de su fila (orden del documento): la siguiente o la anterior, aunque esté fuera de la vista.
  const row = rowOf(from.el);
  if (row) {
    const items = focusables(row);
    const i = items.indexOf(from.el);
    const next = items[dir === "right" ? i + 1 : i - 1];
    if (next) return next;
  }
  // 2) En la misma línea de pantalla (solapamiento vertical real), lo más cercano en esa dirección; nunca en diagonal.
  const r = from.r;
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const b of all) {
    if (b.el === from.el) continue;
    const overlap = Math.min(r.bottom, b.r.bottom) - Math.max(r.top, b.r.top);
    if (overlap < Math.min(r.height, b.r.height) * 0.4) continue;
    const d = dir === "right" ? b.r.left - r.right : r.left - b.r.right;
    if (d < -r.width * 0.5) continue;
    if (d < bestD) {
      bestD = d;
      best = b.el;
    }
  }
  return best;
}

function vertical(from: Box, dir: "up" | "down", all: Box[]): HTMLElement | null {
  const r = from.r;
  let cands = all.filter((b) => b.el !== from.el && (dir === "down" ? b.r.top > r.top + r.height * 0.5 : b.r.bottom < r.bottom - r.height * 0.5));
  // La cabecera es fija: al subir (o al bajar, en el móvil, donde va abajo) «parece» lo más cercano aunque haya
  // contenido oculto más allá. Solo cuenta si no hay nada más.
  if (!inHeader(from.el)) {
    const body = cands.filter((b) => !inHeader(b.el));
    if (body.length) cands = body;
  }
  if (!cands.length) return null;
  // Al subir a la cabecera se entra siempre por la pestaña actual (no por el avatar ni por la columna).
  if (dir === "up" && cands.every((b) => inHeader(b.el))) {
    const tab = cands.find((b) => b.el.matches('.tab[aria-current="page"]'));
    if (tab) return tab.el;
  }
  // Línea más cercana en esa dirección…
  const dist = (b: Box) => Math.max(0, dir === "down" ? b.r.top - r.bottom : r.top - b.r.bottom);
  let first = cands[0];
  for (const b of cands) if (dist(b) < dist(first)) first = b;
  const tol = Math.max(12, first.r.height * 0.6);
  const line =
    dir === "down" ? cands.filter((b) => b.r.top <= first.r.top + tol) : cands.filter((b) => b.r.bottom >= first.r.bottom - tol);
  // …y dentro de ella: en la cabecera, la pestaña actual; si no, lo que quede en la misma columna, salvo que esa
  // fila recuerde dónde se quedó (volver a una estantería deja el foco en la tarjeta de antes).
  const tab = line.find((b) => b.el.matches('.tab[aria-current="page"]'));
  if (tab) return tab.el;
  const x = stickyX ?? cx(r);
  let best = line[0];
  let bestD = Infinity;
  for (const b of line) {
    const d = x >= b.r.left && x <= b.r.right ? 0 : Math.min(Math.abs(b.r.left - x), Math.abs(b.r.right - x));
    if (d < bestD || (d === bestD && Math.abs(cx(b.r) - x) < Math.abs(cx(best.r) - x))) {
      bestD = d;
      best = b;
    }
  }
  // Grupo con entrada fija (data-nav-enter): al llegar desde fuera se entra por su elemento principal
  // (data-nav-default), nunca por un botón secundario o peligroso (🚫) que quede más cerca.
  const group = best.el.closest("[data-nav-enter]");
  if (group && !group.contains(from.el)) {
    const def = group.querySelector<HTMLElement>("[data-nav-default]");
    if (def && all.some((b) => b.el === def)) return def;
  }
  const row = rowOf(best.el);
  const remembered = row ? lastInRow.get(row) : undefined;
  if (remembered && remembered !== from.el && line.some((b) => b.el === remembered)) return remembered;
  // Estantería con scroll propio a la que se entra por primera vez: por su primera tarjeta visible, como en las apps
  // de TV (cada fila empieza por la izquierda), no por la columna de la fila de partida, que dejaba el foco a media fila.
  const strip = best.el.closest(".shelf-row");
  if (strip && strip !== rowOf(from.el)) {
    const left = strip.getBoundingClientRect().left - 2;
    const first = line.find((b) => strip.contains(b.el) && b.r.left >= left);
    if (first) return first.el;
  }
  return best.el;
}

/** Elementos enfocables visibles dentro de un contenedor, en orden del documento. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

// ---------- Desplazamiento ----------
// Animación propia corta (140 ms) que se cancela con la siguiente pulsación: con el «smooth» del navegador, al
// mantener una flecha se acumulaban desplazamientos y la tele iba a tirones y con retraso.

const animations = new Map<Element | Window, number>();
const latest = new Map<Element | Window, symbol>();
/** Destino de cada desplazamiento en curso, para poder terminarlo de golpe. */
const finals = new Map<Element | Window, () => void>();

/**
 * Termina al instante los desplazamientos animados en curso. Se llama antes de medir posiciones en cada pulsación:
 * con la flecha mantenida (o una tele lenta) la siguiente pulsación llegaba a mitad de animación y medía un
 * fotograma intermedio; un elemento aún bajo la cabecera fija no tenía nada «encima» y el foco se quedaba atascado.
 */
function settleScroll() {
  for (const [key, finish] of finals) {
    const id = animations.get(key);
    if (id !== undefined) cancelAnimationFrame(id);
    animations.delete(key);
    finish();
  }
  finals.clear();
}
const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function animateScroll(target: Element | Window, axis: "x" | "y", to: number) {
  const get = () => (target === window ? (axis === "y" ? window.scrollY : window.scrollX) : axis === "y" ? (target as Element).scrollTop : (target as Element).scrollLeft);
  const set = (v: number) => {
    if (target === window) window.scrollTo(axis === "y" ? { top: v } : { left: v });
    else if (axis === "y") (target as Element).scrollTop = v;
    else (target as Element).scrollLeft = v;
  };
  const key = target;
  const prev = animations.get(key);
  if (prev) cancelAnimationFrame(prev);
  animations.delete(key);
  finals.delete(key);
  const from = get();
  if (Math.abs(to - from) < 1) return;
  if (reduceMotion()) return set(to);
  const t0 = performance.now();
  const dur = 140;
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / dur);
    set(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) animations.set(key, requestAnimationFrame(step));
    else {
      animations.delete(key);
      finals.delete(key);
    }
  };
  const token = Symbol();
  latest.set(key, token);
  finals.set(key, () => set(to));
  animations.set(key, requestAnimationFrame(step));
  // Si no hay fotogramas (pestaña en segundo plano, tele saturada), se coloca igualmente en su sitio.
  setTimeout(() => {
    if (latest.get(key) !== token || animations.get(key) === undefined) return;
    cancelAnimationFrame(animations.get(key)!);
    animations.delete(key);
    finals.delete(key);
    set(to);
  }, dur + 80);
}

/** Olvida dónde estabas en la vista visible: al volver a bajar desde el menú se entra por su elemento principal. */
export function forgetViewFocus() {
  const view = document.querySelector("main .tab-view:not([hidden])");
  if (view) lastInView.delete(view);
}

/** Sube la página al principio al instante, cancelando cualquier desplazamiento animado que la volvería a bajar. */
export function scrollPageTop() {
  const id = animations.get(window);
  if (id !== undefined) cancelAnimationFrame(id);
  animations.delete(window);
  finals.delete(window);
  latest.delete(window);
  window.scrollTo({ top: 0 });
}

/** Contenedor con scroll propio más cercano en un eje (fila de tarjetas, ficha modal…), o la ventana. */
function scroller(el: HTMLElement, axis: "x" | "y"): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const st = getComputedStyle(p);
    const ov = axis === "x" ? st.overflowX : st.overflowY;
    if (ov !== "auto" && ov !== "scroll") continue;
    // Una fila con overflow-x también computa overflow-y «auto» (regla de CSS): solo cuenta si de verdad desborda.
    if (axis === "x" ? p.scrollWidth > p.clientWidth + 2 : p.scrollHeight > p.clientHeight + 24 && getComputedStyle(p).overflowX !== "auto") return p;
  }
  return null;
}

/** Deja el elemento (y su bloque: estantería, destacado…) a la vista, por debajo de la cabecera fija. */
function reveal(el: HTMLElement) {
  // Horizontal: dentro de su fila, con un margen para el anillo de foco.
  const hs = scroller(el, "x");
  if (hs) {
    const rr = hs.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const pad = Math.min(48, rr.width * 0.06);
    let to = hs.scrollLeft;
    if (er.left < rr.left + pad) to -= rr.left + pad - er.left;
    else if (er.right > rr.right - pad) to += er.right - (rr.right - pad);
    animateScroll(hs, "x", Math.max(0, to));
  }
  // Vertical. La cabecera es fija: lo que hay en ella no necesita desplazamiento.
  if (inHeader(el)) return;
  const vs = scroller(el, "y");
  let top0: number;
  let bottom0: number;
  if (vs) {
    const vr = vs.getBoundingClientRect();
    top0 = vr.top;
    bottom0 = vr.bottom;
  } else {
    top0 = Math.max(0, document.querySelector("[data-nav-header]")?.getBoundingClientRect().bottom ?? 0);
    // En móvil las pestañas son una barra fija abajo: no debe tapar la fila enfocada.
    const bar = document.querySelector<HTMLElement>(".tabs");
    bottom0 = bar && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : window.innerHeight;
  }
  const margin = 10;
  const er = el.getBoundingClientRect();
  // Se intenta enseñar el bloque entero (estantería con su título, destacado…); si no cabe, solo el elemento.
  const block = el.closest<HTMLElement>("[data-nav-block], .shelf, .spot, section");
  const br = block && block.getBoundingClientRect().height <= (bottom0 - top0) * 0.9 ? block.getBoundingClientRect() : er;
  const current = vs ? vs.scrollTop : window.scrollY;
  let to = current;
  if (br.top < top0 + margin) to += br.top - (top0 + margin);
  else if (er.bottom > bottom0 - margin) to += Math.min(br.bottom - (bottom0 - margin), br.top - (top0 + margin));
  // Cerca del principio de la vista: arriba del todo, para que al volver a subir se vea su cabecera.
  const absTop = er.top - top0 + current;
  if (absTop < (bottom0 - top0) * 0.45) to = 0;
  animateScroll(vs ?? window, "y", Math.max(0, to));
}

export function focusEl(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const row = rowOf(el);
  if (row) lastInRow.set(row, el);
  const view = el.closest(".tab-view");
  if (view) lastInView.set(view, el);
  reveal(el);
}

/** Enfoca el elemento marcado con data-autofocus (o el primero enfocable) dentro del ámbito activo. */
/** Primer elemento visible con data-autofocus (las pestañas visitadas siguen montadas, pero ocultas). */
export function visibleAutofocus(root: ParentNode = scope()): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>("[data-autofocus]")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export function focusFirst() {
  const root = scope();
  focusEl(visibleAutofocus(root) ?? focusables(root)[0]);
}

/**
 * Devuelve el foco a lo último que se enfocó en la vista visible, sin mover el desplazamiento (que ya se ha
 * restaurado). Devuelve false si no hay nada que recordar.
 */
export function focusLastInView(): boolean {
  const view = document.querySelector("main .tab-view:not([hidden])");
  const el = view ? lastInView.get(view) : undefined;
  if (!el || !el.isConnected || el.getBoundingClientRect().height === 0) return false;
  el.focus({ preventScroll: true });
  return true;
}

/**
 * Lleva el foco al contenido de la vista visible: a donde estabas en ella o, si no, a su elemento principal.
 * Devuelve false si la vista aún no tiene nada enfocable (cargando).
 */
export function focusView(): boolean {
  const view = document.querySelector<HTMLElement>("main .tab-view:not([hidden])");
  if (!view) return false;
  const back = lastInView.get(view);
  const el = back && back.isConnected && back.getBoundingClientRect().height > 0 ? back : (visibleAutofocus(view) ?? focusables(view)[0]);
  if (!el) return false;
  focusEl(el);
  return true;
}

/**
 * Si el elemento enfocado acaba de desaparecer (el foco ha caído en <body>), lo devuelve a lo más cercano a donde
 * estaba. Para llamarlo después de quitar del DOM el botón que se acaba de pulsar.
 */
export function recoverFocus() {
  const a = document.activeElement;
  if (a && a !== document.body && (a as HTMLElement).getBoundingClientRect().height > 0) return;
  const near = nearestTo(lastRect, boxes());
  if (near) focusEl(near);
  else focusFirst();
}

/** Si la última interacción fue táctil o con ratón (no con el mando ni el teclado). */
export let lastInputPointer = false;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (lastInputPointer = true), true);
  window.addEventListener("keydown", () => (lastInputPointer = false), true);
}

// Pila de «Atrás» locales: un panel o diálogo abierto (filtros, PIN…) se cierra antes de que actúe la app.
const backStack: { current: () => void }[] = [];

/** Mientras `active` sea true, Atrás llama a `fn` en vez de a la acción general de la app. */
export function useBackHandler(active: boolean, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => ref.current() };
    backStack.push(entry);
    return () => {
      const i = backStack.indexOf(entry);
      if (i >= 0) backStack.splice(i, 1);
    };
  }, [active]);
}

/** Ejecuta Atrás: primero el panel abierto más reciente; si no hay, la acción general. */
export function runBack(general: () => void) {
  const top = backStack[backStack.length - 1];
  if (top) top.current();
  else general();
}

let lastMove = 0;
/** Posición en pantalla del último elemento enfocado, para recuperar el foco si ese elemento desaparece. */
let lastRect: DOMRect | null = null;

function nearestTo(r: DOMRect | null, all: Box[]): HTMLElement | null {
  if (!r) return null;
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const b of all) {
    if (inHeader(b.el)) continue;
    const d = Math.hypot(cx(b.r) - cx(r), b.r.top + b.r.height / 2 - (r.top + r.height / 2));
    if (d < bestD) {
      bestD = d;
      best = b.el;
    }
  }
  return best;
}

export function useSpatialNav(onBack: () => void) {
  const backRef = useRef(onBack);
  backRef.current = onBack;

  useEffect(() => {
    installSoundUnlock();
    // Sonido de «OK»: cualquier botón o enlace activado (Enter del mando, clic o toque).
    const onClick = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target.closest("button, a[href]") : null;
      if (t && !(t as HTMLButtonElement).disabled) playSelect();
    };
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      // También con OK: si ese botón desaparece al pulsarlo, la siguiente flecha recupera el foco en su sitio.
      if (active instanceof HTMLElement && active !== document.body) {
        const r = active.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) lastRect = r;
      }
      if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || (e.key === "Backspace" && !isTextInput(active))) {
        e.preventDefault();
        runBack(backRef.current);
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
      // Con la flecha mantenida, como mucho un paso cada 55 ms: así no se acumula trabajo y el foco no «se escapa».
      const now = performance.now();
      if (e.repeat && now - lastMove < 55) return;
      lastMove = now;
      settleScroll();
      const all = boxes();
      const from = active instanceof HTMLElement ? all.find((b) => b.el === active) : undefined;
      const current = from?.el ?? null;
      if (!current || !from) {
        // El elemento enfocado ha desaparecido (encuesta respondida, título descartado…): se recupera el foco en lo
        // más cercano a donde estaba, no arriba del todo.
        const near = nearestTo(lastRect, all);
        return near ? focusEl(near) : focusFirst();
      }
      // Al bajar desde la barra de pestañas se entra por el elemento principal de la vista (el de data-autofocus),
      // no por el que quede justo debajo de la pestaña: así «abajo» siempre lleva al mismo sitio.
      if (dir === "down" && current.closest("[data-nav-header]")) {
        const main = document.querySelector("main");
        // Se vuelve a donde estabas en esta vista; si no hay nada (o ya no está), a su elemento principal.
        const view = main?.querySelector(".tab-view:not([hidden])");
        const back = view ? lastInView.get(view) : undefined;
        const entry = back && back.isConnected && back.getBoundingClientRect().height > 0 ? back : main ? visibleAutofocus(main) : null;
        if (entry && all.some((b) => b.el === entry)) {
          playMove();
          return focusEl(entry);
        }
      }
      let target = dir === "left" || dir === "right" ? horizontal(from, dir, all) : vertical(from, dir, all);
      // Arriba del todo de una vista, «arriba» siempre lleva al menú (a la pestaña actual).
      if (!target && dir === "up" && !inHeader(current) && !current.closest("[data-nav-modal]")) {
        target = document.querySelector<HTMLElement>('[data-nav-header] .tab[aria-current="page"]');
      }
      if (!target) return;
      if (dir === "left" || dir === "right") stickyX = null;
      else stickyX ??= cx(from.r);
      playMove();
      focusEl(target);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}
