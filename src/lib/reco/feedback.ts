import type { FeedbackEntry, ImplicitEvent, Signal } from "./types";

export const SIGNALS: Signal[] = ["love", "like", "dislike", "not_interested"];
export const IMPLICIT: ImplicitEvent[] = ["open", "skip", "want", "unwant", "seen", "unseen"];
export const KEY_RE = /^(movie|tv):\d+$/;

export function sanitizeFeedback(raw: unknown): Record<string, FeedbackEntry> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, FeedbackEntry> = {};
  for (const [k, v] of Object.entries(raw as Record<string, Partial<FeedbackEntry>>).slice(0, 5000)) {
    if (KEY_RE.test(k) && v && SIGNALS.includes(v.s as Signal)) out[k] = { s: v.s as Signal, t: Number(v.t) || Date.now() };
  }
  return out;
}
