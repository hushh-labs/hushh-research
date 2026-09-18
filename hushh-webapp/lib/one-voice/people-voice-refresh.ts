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

/** Skip the second frame the relay sends for one confirmed action. */
export class VoiceRefreshDeduper {
  private last: WeakSet<object> = new WeakSet();

  shouldRefresh(result: ToolResultPublic | null | undefined): boolean {
    if (!result || typeof result !== "object") return false;
    if (this.last.has(result)) return false;
    this.last.add(result);
    return true;
  }
}
