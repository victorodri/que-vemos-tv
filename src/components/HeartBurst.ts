"use client";
// Explosión sutil de corazones al pulsar «Me encanta». DOM y CSS puros (sin React): se crea, se anima y se borra sola.

const HEARTS = 9;
const DURATION = 850;

export function burstHearts(from: Element | null) {
  if (typeof window === "undefined" || !from) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const r = from.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "heart-burst";
  layer.setAttribute("aria-hidden", "true");
  layer.style.left = `${r.left + r.width / 2}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  const n = reduced ? 1 : HEARTS;
  for (let i = 0; i < n; i++) {
    const h = document.createElement("span");
    h.className = reduced ? "heart heart--still" : "heart";
    h.textContent = "❤";
    if (!reduced) {
      // Abanico hacia arriba (de -150° a -30°) con algo de azar en distancia, tamaño y retardo.
      const angle = ((-150 + (120 * i) / (n - 1) + (Math.random() * 16 - 8)) * Math.PI) / 180;
      const dist = 2.6 + Math.random() * 1.8;
      h.style.setProperty("--dx", `${(Math.cos(angle) * dist).toFixed(2)}rem`);
      h.style.setProperty("--dy", `${(Math.sin(angle) * dist).toFixed(2)}rem`);
      h.style.setProperty("--s", (0.7 + Math.random() * 0.6).toFixed(2));
      h.style.setProperty("--rot", `${Math.round(Math.random() * 50 - 25)}deg`);
      h.style.animationDelay = `${Math.round(Math.random() * 90)}ms`;
    }
    layer.appendChild(h);
  }
  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), DURATION + 150);
}
