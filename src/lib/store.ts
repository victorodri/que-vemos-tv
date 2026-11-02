import "server-only";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Redis } from "@upstash/redis";
import type { ProfileData } from "./types";

// En Vercel los datos van a Upstash Redis (variables KV_REST_API_* o UPSTASH_REDIS_REST_*).
// Sin ellas, en local se guardan en .data/store.json.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

export const storageMode: "redis" | "local" = redis ? "redis" : "local";

const NS = "quevemos:";
const PROFILE = "profile:";
// QUEVEMOS_STORE_FILE permite a scripts (p. ej. la evaluación offline) usar su propio archivo sin pisar el del servidor.
const FILE = process.env.QUEVEMOS_STORE_FILE ? path.resolve(process.env.QUEVEMOS_STORE_FILE) : process.env.VERCEL ? path.join(os.tmpdir(), "quevemos-store.json") : path.join(process.cwd(), ".data", "store.json");

// ---------- Almacén local (solo desarrollo) ----------
// Mismo formato que antes para los perfiles (claves de primer nivel = id de perfil) y un apartado `_kv`
// para el resto (caché de títulos, modelos de gustos, eventos).

interface LocalFile {
  [profileId: string]: unknown;
  _kv?: Record<string, { v: unknown; exp: number | null }>;
}

let writeChain: Promise<void> = Promise.resolve();

async function readLocal(): Promise<LocalFile> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Serializa las escrituras locales para no pisar cambios concurrentes. */
function mutateLocal(fn: (data: LocalFile) => void): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      const data = await readLocal();
      fn(data);
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      // Escritura atómica: una lectura simultánea nunca ve el archivo a medias.
      await fs.writeFile(FILE + ".tmp", JSON.stringify(data));
      await fs.rename(FILE + ".tmp", FILE);
    })
    .catch((err) => console.error("store local:", err));
  return writeChain;
}

// ---------- Perfiles ----------

export const emptyProfile = (): ProfileData => ({ watchlist: [], seen: [], platforms: [], lastFilters: null, prefs: null, feedback: {} });

// Las valoraciones viven en su propia clave y solo las escribe /api/feedback: así el guardado del
// perfil completo desde el cliente (lista, vistos, filtros…) nunca pisa valoraciones hechas en otro
// dispositivo o un instante antes.
const FEEDBACK = "feedback:";

export async function getProfile(id: string): Promise<ProfileData> {
  const [data, feedback] = await Promise.all([
    redis ? redis.get<ProfileData>(NS + PROFILE + id) : readLocal().then((all) => all[id] as ProfileData | undefined),
    kvGet<ProfileData["feedback"]>(FEEDBACK + id),
  ]);
  const base = { ...emptyProfile(), ...(data ?? {}) };
  // Compatibilidad: perfiles antiguos guardaban las valoraciones dentro del propio perfil.
  return { ...base, feedback: feedback ?? base.feedback ?? {} };
}

/** Guarda el perfil SIN las valoraciones (esas van por saveFeedback). */
export async function saveProfile(id: string, data: ProfileData): Promise<void> {
  const { feedback: _ignored, ...rest } = data;
  void _ignored;
  // Migración: si el perfil traía valoraciones de la versión anterior y aún no tienen clave propia, se mueven.
  const legacy = redis ? await redis.get<ProfileData>(NS + PROFILE + id) : ((await readLocal())[id] as ProfileData | undefined);
  if (legacy?.feedback && Object.keys(legacy.feedback).length && !(await kvGet(FEEDBACK + id))) {
    await saveFeedback(id, legacy.feedback);
  }
  if (redis) {
    await redis.set(NS + PROFILE + id, rest);
    return;
  }
  await mutateLocal((all) => {
    all[id] = rest;
  });
}

export async function saveFeedback(id: string, feedback: ProfileData["feedback"]): Promise<void> {
  await kvSet(FEEDBACK + id, feedback);
}

// ---------- Clave-valor genérico ----------

export async function kvGet<T>(key: string): Promise<T | null> {
  if (redis) return (await redis.get<T>(NS + key)) ?? null;
  const e = (await readLocal())._kv?.[key];
  if (!e || (e.exp && e.exp < Date.now())) return null;
  return e.v as T;
}

export async function kvMGet<T>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  if (redis) return redis.mget<(T | null)[]>(...keys.map((k) => NS + k));
  const kv = (await readLocal())._kv ?? {};
  return keys.map((k) => {
    const e = kv[k];
    return e && (!e.exp || e.exp >= Date.now()) ? (e.v as T) : null;
  });
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  if (redis) {
    await (ttlSeconds ? redis.set(NS + key, value, { ex: ttlSeconds }) : redis.set(NS + key, value));
    return;
  }
  await mutateLocal((all) => {
    all._kv ??= {};
    all._kv[key] = { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null };
  });
}

/** Añade al principio de una lista y la recorta a `max` elementos. */
export async function listPush(key: string, value: unknown, max: number): Promise<void> {
  if (redis) {
    await redis.lpush(NS + key, value);
    await redis.ltrim(NS + key, 0, max - 1);
    return;
  }
  await mutateLocal((all) => {
    all._kv ??= {};
    const prev = (all._kv[key]?.v as unknown[]) ?? [];
    all._kv[key] = { v: [value, ...prev].slice(0, max), exp: null };
  });
}

export async function listRange<T>(key: string, count: number): Promise<T[]> {
  if (redis) return redis.lrange<T>(NS + key, 0, count - 1);
  return (((await readLocal())._kv?.[key]?.v as T[]) ?? []).slice(0, count);
}
