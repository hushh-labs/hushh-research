/**
 * Which One Voice results mean the signed-in person's own identity changed.
 *
 * `update_display_name` is server-owned: the tool writes at the provider and
 * re-syncs the identity shadow, so the browser holds nothing to write back --
 * it only has to stop showing the old name. That refresh must not depend on
 * the name editor being mounted (a spoken change from Home has no editor), so
 * an always-mounted bridge consumes this predicate and refreshes both identity
 * paths: the UID-keyed identity cache (avatars, Account) and the Firebase user
 * (header name/email).
 *
 * `committed_sync_pending` counts as a change: the provider holds the new name
 * even though the shadow has not caught up, and a forced refresh is exactly
 * how the shadow catches up.
 */

import { NOT_SUCCESS_STATUSES, type ToolResultPublic } from "@/lib/one-voice/protocol";

export const OWN_IDENTITY_TOOLS = new Set(["update_display_name"]);

/** Statuses that describe a committed identity change, not a no-op or a wait. */
export const OWN_IDENTITY_CHANGED_STATUSES = new Set(["updated", "committed_sync_pending"]);

export function isOwnIdentityChange(
  tool: string | null,
  result: ToolResultPublic | null | undefined,
): boolean {
  if (!result || typeof result.status !== "string") return false;
  if (NOT_SUCCESS_STATUSES.has(result.status)) return false;
  if (!OWN_IDENTITY_CHANGED_STATUSES.has(result.status)) return false;
  if (tool !== null && !OWN_IDENTITY_TOOLS.has(tool)) return false;
  if (tool === null) {
    // A `pending_action.resolved` frame names no tool; the result carries the
    // provider-held name only for identity tools, so use that as the marker.
    return typeof (result as Record<string, unknown>).display_name === "string";
  }
  return true;
}

/** The provider-held name the result names, or null when it carries none. */
export function committedDisplayName(result: ToolResultPublic | null | undefined): string | null {
  const value = (result as Record<string, unknown> | null | undefined)?.display_name;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}
