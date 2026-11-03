// Aprendizaje discriminativo de gustos: regresión logística dispersa con AdaGrad y regularización L2.
//
// El vector «Rocchio» de model.ts suma los rasgos de lo que gusta y resta lo que no; es robusto con pocas
// señales pero no aprende qué rasgos DISTINGUEN lo que te gusta de lo que no. Esta regresión sí:
//  - positivos: me encanta / me gusta / lo quiero ver / visto / abierto (con su peso de confianza);
//  - negativos: no me gusta / no me interesa / saltado;
//  - negativos implícitos de baja confianza: títulos conocidos con los que no ha interactuado
//    (idea de Hu, Koren y Volinsky, «Collaborative Filtering for Implicit Feedback Datasets», 2008).
// La actualización por rasgo con tasa adaptativa es la de AdaGrad (Duchi et al., 2011), base de
// FTRL-Proximal (McMahan et al., «Ad Click Prediction: a View from the Trenches», 2013).

export type Vec = Record<string, number>;

export interface Example {
  f: Vec;
  /** 1 = le gusta, 0 = no. */
  y: 0 | 1;
  /** Confianza de la señal (p. ej. «me encanta» pesa más que «lo abrió»). */
  c: number;
}

export interface Logistic {
  w: Vec;
  b: number;
  /** Nº de ejemplos con los que se entrenó (para decidir cuánto fiarse). */
  n: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Generador pseudoaleatorio determinista (mulberry32), para que el entrenamiento sea reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function trainLogistic(examples: Example[], opts: { epochs?: number; lr?: number; l2?: number; seed?: number } = {}): Logistic {
  const { epochs = 30, lr = 0.25, l2 = 0.02, seed = 7 } = opts;
  const w: Vec = {};
  const g2: Vec = {};
  let b = 0;
  let gb2 = 1e-6;
  if (!examples.length) return { w, b, n: 0 };

  // Equilibrio de clases: los dos lados pesan lo mismo aunque haya muchos más de uno.
  const pos = examples.filter((e) => e.y === 1).reduce((s, e) => s + e.c, 0) || 1;
  const neg = examples.filter((e) => e.y === 0).reduce((s, e) => s + e.c, 0) || 1;
  const classW = { 1: (pos + neg) / (2 * pos), 0: (pos + neg) / (2 * neg) };

  const rand = rng(seed);
  const order = examples.map((_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const i of order) {
      const e = examples[i];
      let z = b;
      for (const [k, x] of Object.entries(e.f)) z += (w[k] ?? 0) * x;
      const err = (sigmoid(z) - e.y) * e.c * classW[e.y];
      for (const [k, x] of Object.entries(e.f)) {
        const g = err * x + l2 * (w[k] ?? 0);
        g2[k] = (g2[k] ?? 1e-6) + g * g;
        w[k] = (w[k] ?? 0) - (lr * g) / Math.sqrt(g2[k]);
      }
      gb2 += err * err;
      b -= (lr * err) / Math.sqrt(gb2);
    }
  }
  // Poda: los 400 rasgos con más peso absoluto bastan y mantienen pequeño el modelo guardado.
  const pruned = Object.fromEntries(
    Object.entries(w)
      .filter(([, x]) => Math.abs(x) > 1e-3)
      .sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]))
      .slice(0, 400),
  );
  return { w: pruned, b, n: examples.length };
}

/** Probabilidad de que le guste, en [-1, 1] (0 = indiferente). */
export function logisticScore(m: Logistic, f: Vec): number {
  let z = m.b;
  for (const [k, x] of Object.entries(f)) z += (m.w[k] ?? 0) * x;
  return 2 * sigmoid(z) - 1;
}
