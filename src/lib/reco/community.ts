import "server-only";
import { listProfiles, type ProfileMeta } from "../profiles";
import { kvMGet } from "../store";
import type { ProfileData } from "../types";
import { cosine } from "./model";
import type { TasteModel } from "./types";

// «Red social» de QuéVer: filtrado colaborativo usuario-usuario (Resnick et al., «GroupLens», 1994;
// Herlocker et al., «An Algorithmic Framework for Performing Collaborative Filtering», 1999).
// La similitud entre perfiles es el coseno de sus vectores de gustos (que ya resumen géneros, temas, personas y
// aspectos de la crítica) más lo que coinciden en lo que les encantó; lo que les gustó mucho a los parecidos
// se convierte en candidatos con su explicación («A Rafa le encantó»).

const SIGNAL = { love: 1, like: 0.55 } as const;
const MIN_SIM = 0.15;

export interface Neighbor {
  meta: ProfileMeta;
  sim: number;
  /** Coincidencias en «me encanta / me gusta». */
  shared: number;
  loved: string[];
  liked: string[];
}

/** Perfiles parecidos a este (sin él mismo, sus miembros ni las parejas de las que forma parte). */
export async function neighbors(profileId: string, taste: TasteModel): Promise<Neighbor[]> {
  const all = await listProfiles();
  const me = all.find((p) => p.id === profileId);
  const related = new Set([profileId, ...(me?.members ?? []), ...all.filter((p) => p.members.includes(profileId)).map((p) => p.id)]);
  const others = all.filter((p) => !related.has(p.id));
  if (!others.length) return [];
  const [tastes, feedbacks, mine] = await Promise.all([
    kvMGet<TasteModel>(others.map((p) => `taste:${p.id}`)),
    kvMGet<ProfileData["feedback"]>(others.map((p) => `feedback:${p.id}`)),
    kvMGet<ProfileData["feedback"]>([`feedback:${profileId}`]),
  ]);
  const myPos = new Set(Object.entries(mine[0] ?? {}).filter(([, f]) => f.s === "love" || f.s === "like").map(([k]) => k));
  return others
    .map((meta, i) => {
      const fb = feedbacks[i] ?? {};
      const loved = Object.entries(fb).filter(([, f]) => f.s === "love").map(([k]) => k);
      const liked = Object.entries(fb).filter(([, f]) => f.s === "like").map(([k]) => k);
      const shared = [...loved, ...liked].filter((k) => myPos.has(k)).length;
      const t = tastes[i];
      // Coseno de gustos + un pequeño extra por cada título que os encantó a los dos (máx. +0,25).
      const sim = (t ? cosine(taste.w, t.w) : 0) + Math.min(0.25, shared * 0.04);
      return { meta, sim, shared, loved, liked };
    })
    .filter((n) => n.loved.length + n.liked.length > 0)
    .sort((a, b) => b.sim - a.sim);
}

export interface CommunityPick {
  key: string;
  score: number;
  owner: string;
  signal: "love" | "like";
}

/** Lo que les encantó a los perfiles más parecidos y este aún no ha visto ni valorado. */
export async function communityPicks(profileId: string, taste: TasteModel, limit = 40): Promise<CommunityPick[]> {
  const ns = (await neighbors(profileId, taste)).filter((n) => n.sim >= MIN_SIM).slice(0, 12);
  const blocked = new Set(taste.blocked);
  const acc = new Map<string, CommunityPick>();
  for (const n of ns)
    for (const [list, signal] of [[n.loved, "love"], [n.liked, "like"]] as const)
      for (const key of list) {
        if (blocked.has(key)) continue;
        const add = n.sim * SIGNAL[signal];
        const prev = acc.get(key);
        if (!prev) acc.set(key, { key, score: add, owner: n.meta.id, signal });
        else {
          // El dueño de la explicación es quien más aporta.
          if (add > prev.score) Object.assign(prev, { owner: n.meta.id, signal });
          prev.score += add;
        }
      }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
