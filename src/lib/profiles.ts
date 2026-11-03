import "server-only";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { kvGet, kvSet } from "./store";

// Perfiles creados desde la app (antes eran fijos en src/config/profiles.ts). El registro vive en `profiles:index`.
// - Cada perfil tiene un PIN de 4 cifras (guardado con scrypt + sal). Al entrar, el servidor da un token firmado
//   (HMAC con SESSION_SECRET) que el dispositivo guarda: el PIN solo se pide una vez por tele.
// - Un perfil «pareja» puede enlazar perfiles individuales (members) para buscar lo que gusta a los dos.
// - Lo que otros perfiles ven de ti: nombre, emoji y lo que te encantó (ver /api/community).

export interface ProfileMeta {
  id: string;
  name: string;
  kind: "single" | "couple";
  /** Perfiles individuales que forman la pareja (puede estar vacío: pareja con gustos propios). */
  members: string[];
  emoji: string;
  color: string;
  /** null = perfil antiguo sin PIN (se le pide crearlo al entrar). `v` invalida los tokens al cambiar de PIN. */
  pin: { salt: string; hash: string; v: number } | null;
  createdAt: number;
}

export type PublicProfile = Omit<ProfileMeta, "pin"> & { hasPin: boolean };

const INDEX = "profiles:index";
const MAX_PROFILES = 60;
const LOCK_AFTER = 8;
const LOCK_SECONDS = 15 * 60;

// Al pasar a perfiles dinámicos solo se conserva Víctor (los de Alba y pareja estaban vacíos).
const BOOTSTRAP: ProfileMeta[] = [{ id: "victor", name: "Víctor", kind: "single", members: [], emoji: "🎬", color: "#4f8cff", pin: null, createdAt: 0 }];

export const COLORS = ["#4f8cff", "#ff5c8a", "#ffb547", "#3ddc97", "#b57bff", "#ff7a45", "#2ec5d3", "#e4e45c"];
export const EMOJIS = ["🎬", "🍿", "🦊", "🐼", "🦁", "🐙", "🚀", "🌵", "🎸", "⚽", "👾", "🌙", "💑", "👫", "👭", "👬"];

/**
 * Clave para firmar tokens y anonimizar IPs. Lo ideal es SESSION_SECRET; si no está, se deriva de otro secreto
 * que solo conoce el servidor (CRON_SECRET o la clave de TMDB). Cambiarla cierra la sesión en todas las teles.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (s) return s;
  const base = process.env.CRON_SECRET?.trim() || process.env.TMDB_API_KEY?.trim();
  if (base) return createHash("sha256").update("quevemos-session:" + base).digest("base64url");
  return "dev-only-secret";
}

export async function listProfiles(): Promise<ProfileMeta[]> {
  return (await kvGet<ProfileMeta[]>(INDEX)) ?? BOOTSTRAP;
}

export async function getMeta(id: string | null | undefined): Promise<ProfileMeta | null> {
  if (!id) return null;
  return (await listProfiles()).find((p) => p.id === id) ?? null;
}

export const toPublic = ({ pin, ...rest }: ProfileMeta): PublicProfile => ({ ...rest, hasPin: !!pin });

async function saveIndex(list: ProfileMeta[]) {
  await kvSet(INDEX, list);
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "perfil";

function hashPin(pin: string, salt: string) {
  return scryptSync(pin, salt, 32).toString("base64url");
}

export const validPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4}$/.test(pin);

export async function createProfile(input: { name: string; kind: "single" | "couple"; members: string[]; emoji: string; color: string; pin: string }): Promise<ProfileMeta> {
  const list = await listProfiles();
  if (list.length >= MAX_PROFILES) throw new Error("Se ha llegado al máximo de perfiles");
  const base = slug(input.name);
  let id = base;
  for (let i = 2; list.some((p) => p.id === id) || id === "pareja" || id === "alba"; i++) id = `${base}-${i}`;
  const singles = new Set(list.filter((p) => p.kind === "single").map((p) => p.id));
  const salt = randomBytes(12).toString("base64url");
  const meta: ProfileMeta = {
    id,
    name: input.name.trim().slice(0, 30),
    kind: input.kind,
    members: input.kind === "couple" ? [...new Set(input.members)].filter((m) => singles.has(m)).slice(0, 2) : [],
    emoji: EMOJIS.includes(input.emoji) ? input.emoji : EMOJIS[0],
    color: COLORS.includes(input.color) ? input.color : COLORS[list.length % COLORS.length],
    pin: { salt, hash: hashPin(input.pin, salt), v: 1 },
    createdAt: Date.now(),
  };
  await saveIndex([...list, meta]);
  return meta;
}

export async function updateProfile(id: string, patch: Partial<Pick<ProfileMeta, "name" | "emoji" | "color" | "members">>): Promise<ProfileMeta | null> {
  const list = await listProfiles();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const singles = new Set(list.filter((p) => p.kind === "single" && p.id !== id).map((p) => p.id));
  const cur = list[i];
  list[i] = {
    ...cur,
    name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim().slice(0, 30) : cur.name,
    emoji: patch.emoji && EMOJIS.includes(patch.emoji) ? patch.emoji : cur.emoji,
    color: patch.color && COLORS.includes(patch.color) ? patch.color : cur.color,
    members: cur.kind === "couple" && Array.isArray(patch.members) ? [...new Set(patch.members)].filter((m) => singles.has(m)).slice(0, 2) : cur.members,
  };
  await saveIndex(list);
  return list[i];
}

// ---------- PIN y sesiones ----------

const sign = (id: string, v: number) => createHmac("sha256", secret()).update(`${id}.${v}`).digest("base64url").slice(0, 32);

export const tokenFor = (m: ProfileMeta) => `${m.id}.${m.pin?.v ?? 0}.${sign(m.id, m.pin?.v ?? 0)}`;

/**
 * Comprueba el PIN (o lo crea si el perfil aún no tiene) y devuelve un token. Tras 8 fallos seguidos el perfil
 * se bloquea 15 minutos: con 4 cifras no se puede probar todo a ciegas.
 */
export async function login(id: string, pin: string): Promise<{ token: string } | { error: string; status: number }> {
  const list = await listProfiles();
  const meta = list.find((p) => p.id === id);
  if (!meta) return { error: "Perfil desconocido", status: 404 };
  const failKey = `pinfail:${id}`;
  const fails = (await kvGet<number>(failKey)) ?? 0;
  if (fails >= LOCK_AFTER) return { error: "Demasiados intentos. Prueba dentro de 15 minutos.", status: 429 };
  if (!meta.pin) {
    const salt = randomBytes(12).toString("base64url");
    meta.pin = { salt, hash: hashPin(pin, salt), v: 1 };
    await saveIndex(list);
    return { token: tokenFor(meta) };
  }
  const ok = timingSafeEqual(Buffer.from(hashPin(pin, meta.pin.salt)), Buffer.from(meta.pin.hash));
  if (!ok) {
    await kvSet(failKey, fails + 1, LOCK_SECONDS);
    return { error: `PIN incorrecto${fails + 1 >= LOCK_AFTER - 2 ? ` (quedan ${LOCK_AFTER - fails - 1} intentos)` : ""}`, status: 401 };
  }
  if (fails) await kvSet(failKey, 0, 1);
  return { token: tokenFor(meta) };
}

export function verifyToken(meta: ProfileMeta, token: string | null): boolean {
  if (!meta.pin) return true; // perfil antiguo sin PIN: abierto hasta que lo cree
  if (!token) return false;
  const [id, v, sig] = token.split(".");
  if (id !== meta.id || Number(v) !== meta.pin.v || !sig) return false;
  const expected = sign(meta.id, meta.pin.v);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** Perfil autorizado para esta petición (cabecera x-profile-token), o una respuesta de error. */
export async function authorize(req: Request, id: string | null): Promise<ProfileMeta | NextResponse> {
  const meta = await getMeta(id);
  if (!meta) return NextResponse.json({ error: "Perfil desconocido" }, { status: 404 });
  if (!verifyToken(meta, req.headers.get("x-profile-token"))) return NextResponse.json({ error: "Necesitas el PIN de este perfil" }, { status: 401 });
  return meta;
}

// ---------- Perfil por defecto según la red ----------
// Se guarda qué perfiles entran desde cada IP, pero nunca la IP: solo un HMAC de ella (no se puede revertir).

const ipKey = (req: Request) => {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  return ip ? `ipmap:${createHmac("sha256", secret()).update("ip:" + ip).digest("base64url").slice(0, 22)}` : null;
};

export async function recordNetwork(req: Request, id: string) {
  const key = ipKey(req);
  if (!key) return;
  const prev = (await kvGet<Record<string, number>>(key)) ?? {};
  await kvSet(key, { ...prev, [id]: Date.now() }, 120 * 86400);
}

/** Perfil más reciente usado desde esta red, si sigue existiendo. */
export async function suggestedFor(req: Request, list: ProfileMeta[]): Promise<string | null> {
  const key = ipKey(req);
  if (!key) return null;
  const map = (await kvGet<Record<string, number>>(key)) ?? {};
  const best = Object.entries(map)
    .filter(([id]) => list.some((p) => p.id === id))
    .sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? null;
}
