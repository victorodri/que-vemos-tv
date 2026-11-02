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

const PREFIX = "quevemos:profile:";
const FILE = process.env.VERCEL ? path.join(os.tmpdir(), "quevemos-store.json") : path.join(process.cwd(), ".data", "store.json");

export const emptyProfile = (): ProfileData => ({ watchlist: [], seen: [], platforms: [], lastFilters: null });

async function readFile(): Promise<Record<string, ProfileData>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function getProfile(id: string): Promise<ProfileData> {
  const data = redis ? await redis.get<ProfileData>(PREFIX + id) : (await readFile())[id];
  return { ...emptyProfile(), ...(data ?? {}) };
}

export async function saveProfile(id: string, data: ProfileData): Promise<void> {
  if (redis) {
    await redis.set(PREFIX + id, data);
    return;
  }
  const all = await readFile();
  all[id] = data;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all, null, 2));
}
