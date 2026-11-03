// Simulación de la capa de interacción (engagement.ts) sin red: sesiones en las que el perfil abre solo una tira.
// Uso: QUEVEMOS_STORE_FILE=.data/sim-engage.json npx tsx --conditions=react-server scripts/sim-engage.mts
import { arrangeShelves, getEngage, markAsked, recordEngagement, rememberFirst, nextSurvey } from "../src/lib/reco/engagement.ts";
import type { Shelf } from "../src/lib/reco/types.ts";

const P = "sim";
const mk = (id: string, key: string, title: string, n: number, base: number): Shelf => ({
  id: id as Shelf["id"],
  key,
  title,
  items: Array.from({ length: n }, (_, i) => ({ id: base + i, type: "movie", title: `${title} ${i}`, year: 2000, rating: 7, overview: "", poster: null, backdrop: null, genreIds: [18], score: 1 - i * 0.02, reason: "" })),
});
const base: Shelf[] = [
  mk("top", "top", "Lo mejor para ti", 32, 1000),
  mk("because", "because:movie:98", "Porque te gustó Gladiator", 24, 2000),
  mk("because", "because:movie:155", "Porque te gustó El caballero oscuro", 24, 3000),
  mk("because", "because:movie:27205", "Porque te gustó Origen", 24, 4000),
  mk("discover", "discover", "Descubrimientos", 24, 5000),
  mk("trending", "trending", "Tendencias", 24, 6000),
];
const firsts: string[] = [];
let now = Date.now();
for (let s = 0; s < 9; s++) {
  const sid = `s${s}`;
  const st = await getEngage(P);
  const shelves = arrangeShelves(base, st, sid, now);
  const top = shelves.find((x) => x.id === "top")!.items[0];
  await rememberFirst(P, st, `${top.type}:${top.id}`, sid);
  firsts.push(top.title);
  const survey = nextSurvey(await getEngage(P), sid, { plural: false, unratedSeen: [] }, now);
  if (survey) await markAsked(P, sid, survey, now);
  console.log(`sesión ${s}: ${shelves.map((x) => `${x.title}(${x.items.length})`).join(" · ")}${survey ? `\n   encuesta: ${survey.question}` : ""}`);
  // Ve todas las tiras; solo abre (y guarda) en «Descubrimientos».
  await recordEngagement(P, { session: sid, views: shelves.map((x) => ({ shelf: x.key!, title: x.title, keys: x.items.slice(0, 6).map((i) => `movie:${i.id}`) })) }, now);
  const d = shelves.find((x) => x.key === "discover")!.items[0];
  await recordEngagement(P, { session: sid, actions: [{ key: `movie:${d.id}`, a: "open", from: "discover", t: now + 20_000 }, { key: `movie:${d.id}`, a: "want", from: "discover", t: now + 40_000 }] }, now + 40_000);
  now += 26 * 3600_000;
}
console.log("\nprimeras portadas:", firsts.join(" | "));
console.log("insights:", (await getEngage(P)).insights.map((i) => i.text));
