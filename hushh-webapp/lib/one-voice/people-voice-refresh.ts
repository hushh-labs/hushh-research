/**
 * Which One Voice results mean the connection graph changed.
 *
 * Screens that show relationships (Connect, a person profile) refetch on
 * these -- and only these -- and never repeat the write. The relay mirrors a
 * confirmed action as both `tool.result` and `pending_action.resolved`, so
 * callers dedupe on the result object identity via `VoiceRefreshDeduper`.
 */

import { NOT_SUCCESS_STATUSES, type ToolResultPublic } from "@/lib/one-voice/protocol";

/** `ui_refresh` keys the people tools attach to a committed change. */
export const PEOPLE_REFRESH_KEYS = new Set(["connections", "location_people"]);

/** Statuses that describe a state change, not a no-op or a wait. */
const CHANGED_STATUSES = new Set([
  "sent",
  "accepted",
  "declined",
  "cancelled",
  "removed",
]);

export function isPeopleGraphChange(
  tool: string | null,
  result: ToolResultPublic | null | undefined,
): boolean {
  if (!result || typeof result.status !== "string") return false;
  if (NOT_SUCCESS_STATUSES.has(result.status)) return false;
  const keys = Array.isArray(result.ui_refresh) ? result.ui_refresh : [];
  if (!keys.some((key) => typeof key === "string" && PEOPLE_REFRESH_KEYS.has(key)))
    return false;
  void tool;
  return CHANGED_STATUSES.has(result.status);
}

/**
 * Skip the second frame the relay sends for one confirmed action.
 *
 * `pending_action.resolved` and `tool.result` are two separately parsed
 * frames, so identity is useless; the key is the outcome itself (status plus
 * the ids it names), and a repeat inside a short window is the mirror frame.
 */
export const VOICE_REFRESH_DEDUPE_WINDOW_MS = 5_000;

function refreshKey(result: ToolResultPublic): string {
  const pick = (key: string) => {
    const value = (result as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };
  return [result.status, pick("request_id"), pick("user_id"), pick("connection_id")].join("|");
}

export class VoiceRefreshDeduper {
  private seen = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  shouldRefresh(result: ToolResultPublic | null | undefined): boolean {
    if (!result || typeof result !== "object" || typeof result.status !== "string") return false;
    const key = refreshKey(result);
    const at = this.now();
    const last = this.seen.get(key);
    this.seen.set(key, at);
    for (const [k, t] of this.seen) if (at - t > VOICE_REFRESH_DEDUPE_WINDOW_MS) this.seen.delete(k);
    return last === undefined || at - last > VOICE_REFRESH_DEDUPE_WINDOW_MS;
  }
}
