// Análisis de texto por reglas (sin modelos externos): limpieza, tono (léxico ES/EN con negación) y aspectos.
// Basado en el enfoque de léxicos de opinión (Hu y Liu, «Mining and Summarizing Customer Reviews», KDD 2004):
// cada frase suma las palabras positivas y resta las negativas, invirtiendo las que van tras una negación.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—" };

export function cleanText(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\[(\d+|cita requerida|citation needed)\]/gi, "")
    .replace(/\*\*|__|~~|&gt;|^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minúsculas, sin tildes ni signos: para comparar títulos y buscar palabras. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"“«])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

/** Recorta en un límite de palabra. */
export function clip(s: string, max = 300): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "") + "…";
}

// ---------- Tono ----------

const POS = new Set(
  (
    "obra maestra imprescindible brillante magistral excelente extraordinaria extraordinario maravillosa maravilloso fascinante soberbia soberbio " +
    "impecable sublime notable estupenda estupendo genial gran grandiosa memorable emocionante absorbente apasionante cautivadora original " +
    "inteligente precioso preciosa redonda redondo divertidisima divertida hilarante conmovedora potente solida solido recomendable joya acierto " +
    "masterpiece brilliant excellent outstanding superb stunning gripping compelling masterful wonderful amazing great fantastic beautiful " +
    "powerful moving hilarious clever smart riveting captivating terrific perfect flawless engrossing remarkable fresh delightful essential best love loved"
  ).split(" "),
);
const NEG = new Set(
  (
    "aburrida aburrido tediosa tedioso floja flojo mediocre decepcionante decepcion previsible fallida fallido insipida insipido pesada pesado " +
    "sobrevalorada sobrevalorado mala malo peor desastre horrible ridicula ridiculo torpe vacia vacio confusa confuso olvidable irregular lenta " +
    "boring dull tedious mediocre disappointing disappointment predictable bland bad worst awful terrible mess messy overrated forgettable " +
    "weak flat lifeless pointless waste uneven tiresome clumsy cliched hate hated"
  ).split(" "),
);
const NEGATORS = new Set("no ni nunca jamas tampoco sin not never nor without isnt wasnt doesnt dont didnt cant".split(" "));

/** Tono de un texto en [-1, 1]. */
export function sentiment(text: string): number {
  const words = norm(text).split(" ");
  let s = 0;
  let hits = 0;
  words.forEach((w, i) => {
    const v = POS.has(w) ? 1 : NEG.has(w) ? -1 : 0;
    if (!v) return;
    const negated = [words[i - 1], words[i - 2]].some((x) => x && NEGATORS.has(x));
    s += negated ? -v * 0.7 : v;
    hits++;
  });
  return hits ? Math.max(-1, Math.min(1, s / Math.max(3, hits))) : 0;
}

// ---------- Aspectos ----------

const ASPECTS: Record<string, RegExp> = {
  tensa: /\b(tens[ao]|tension|suspense|trepidante|adrenalina|angustiosa|tense|gripping|nail biting|edge of (your|my) seat|thrilling|suspenseful)\b/,
  giros: /\b(giros?|giro final|sorpresa final|impredecible|twists?|twisty|unpredictable|shocking ending)\b/,
  oscura: /\b(oscur[ao]|sombri[ao]|perturbador[ao]?|inquietante|desoladora|dark|bleak|grim|disturbing|unsettling|haunting)\b/,
  lenta: /\b(lent[ao]|pausad[ao]|ritmo lento|a fuego lento|slow burn|slow paced|slow|meditative|deliberate pacing)\b/,
  divertida: /\b(divertid[ao]|hilarante|desternillante|carcajadas|humor|funny|hilarious|laugh out loud|comedic)\b/,
  emotiva: /\b(emotiv[ao]|conmovedor[ao]|lagrimas|llorar|desgarrador[ao]|moving|heartbreaking|tearjerker|emotional|touching)\b/,
  visual: /\b(fotografia|visualmente|preciosista|plano secuencia|cinematography|visually|gorgeous|stunning visuals|beautifully shot)\b/,
  actuaciones: /\b(interpretacion(es)?|actuacion(es)?|reparto|performances?|acting|cast is|tour de force)\b/,
  guion: /\b(guion|dialogos|escrita|screenplay|script|writing|dialogue|well written)\b/,
  cerebral: /\b(hace pensar|reflexion|cerebral|filosofic[ao]|inteligente|thought provoking|mind bending|cerebral|philosophical|intelligent)\b/,
  reconfortante: /\b(reconfortante|entranable|tiern[ao]|feel good|heartwarming|charming|wholesome|sweet)\b/,
  violenta: /\b(violent[ao]|violencia|sangrient[ao]|gore|brutal|violent|violence|bloody|graphic)\b/,
  epica: /\b(epic[ao]|grandios[ao]|ambicios[ao]|epic|sweeping|grand scale|ambitious)\b/,
  adictiva: /\b(adictiva|enganch\w+|maraton|addictive|bingeable|binge|binge watch|hooked)\b/,
  atmosferica: /\b(atmosfera|ambientacion|atmosferic[ao]|atmospheric|atmosphere|moody)\b/,
  realista: /\b(realista|hechos reales|verosimil|cruda|realistic|true story|raw|grounded|authentic)\b/,
  sobrevalorada: /\b(sobrevalorad[ao]|decepcion\w*|overrated|disappointing|letdown|underwhelming)\b/,
  aburrida: /\b(aburrid[ao]|tedios[ao]|pesad[ao]|soporifer[ao]|boring|dull|tedious|drags)\b/,
};

/** Aspectos que menciona un texto. */
export function aspects(text: string): string[] {
  const t = norm(text);
  return Object.entries(ASPECTS)
    .filter(([, re]) => re.test(t))
    .map(([tag]) => tag);
}

/** Frase más jugosa de un texto para enseñarla: la de más tono y aspectos, sin spoilers marcados. */
export function bestExcerpt(text: string, max = 300): string {
  const ss = sentences(text).filter((s) => !/spoiler/i.test(s));
  if (!ss.length) return clip(text, max);
  const scored = ss.map((s, i) => ({ s, v: Math.abs(sentiment(s)) * 2 + aspects(s).length - i * 0.05 - (s.length > max ? 0.5 : 0) }));
  scored.sort((a, b) => b.v - a.v);
  return clip(scored[0].s, max);
}
