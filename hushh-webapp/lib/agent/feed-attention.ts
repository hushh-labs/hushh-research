/**
 * "One has something for you": the push, the tap, and the turn it starts.
 *
 * The push is a bare wake-up (type plus an opaque feed row id). Tapping it
 * opens `/?feedAttention=<id>`; after unlock the app shell arms one pending
 * request here (memory only, ids only), and the chat consumes it by starting a
 * fresh conversation whose first turn is this fixed label plus the id. The
 * server admits that turn only for an item it actually pushed, and One writes
 * its message there, with the person's chat key present, sealed like any
 * reply. Nothing is written to browser storage.
 */

import { ROUTES } from "@/lib/navigation/routes";

/** Must equal `FEED_ATTENTION_LABEL` in `hushh_mcp/one_adk/feed_attention.py`. */
export const FEED_ATTENTION_LABEL = "Opened an update from your feed";
export const FEED_ATTENTION_NOTIFICATION_TYPE = "one_feed_attention";
export const FEED_ATTENTION_QUERY = "feedAttention";

const FEED_ITEM_ID = /^[1-9][0-9]{0,18}$/;

export function isFeedAttentionItemId(value: unknown): value is string {
  return typeof value === "string" && FEED_ITEM_ID.test(value);
}

/** Tap target for the push; `deep_link` is never trusted. Null for other types. */
export function feedAttentionTapTarget(
  data: Record<string, unknown> | undefined,
): string | null {
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  if (type !== FEED_ATTENTION_NOTIFICATION_TYPE) return null;
  const itemId = String(data?.feed_item_id || "").trim();
  // Without a usable id the durable Feed row is still the honest place to land.
  if (!isFeedAttentionItemId(itemId)) return ROUTES.ONE_FEED;
  return `${ROUTES.HOME}?${new URLSearchParams({ [FEED_ATTENTION_QUERY]: itemId }).toString()}`;
}

type Listener = () => void;
const pending = new Map<string, string>();
const listeners = new Set<Listener>();

/** Remember one tapped update for this owner until the chat takes it. */
export function armFeedAttention(ownerId: string, itemId: string): boolean {
  if (!ownerId || !isFeedAttentionItemId(itemId)) return false;
  pending.set(ownerId, itemId);
  for (const listener of [...listeners]) listener();
  return true;
}

/** Take the pending update for this owner, at most once. */
export function takeFeedAttention(ownerId: string): string | null {
  const itemId = pending.get(ownerId) ?? null;
  pending.delete(ownerId);
  return itemId;
}

export function subscribeFeedAttention(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop everything held for any owner (sign-out or owner change). */
export function clearFeedAttention(): void {
  pending.clear();
}
