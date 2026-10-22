"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";

/** A metadata-only invalidation signal; message bodies never cross this boundary. */
export const DIRECT_MESSAGES_UPDATED_EVENT = "hushh:direct-messages-updated";

const DIRECT_MESSAGES_CHANNEL = "hushh-direct-messages-v1";
let lastInvalidationKey = "";

export type DirectMessagesUpdatedDetail = {
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  source: "send" | "fcm" | "sse" | "read" | "delete";
  changedAt: number;
};

function invalidateMessageSnapshot(detail: DirectMessagesUpdatedDetail): void {
  if (detail.source === "read") return;
  const key = JSON.stringify([detail.userId, detail.conversationId, detail.messageId, detail.source, detail.changedAt]);
  // Multiple consumers receive the same window/channel event. Invalidate its
  // request session once, before any consumer starts the replacement request.
  if (key === lastInvalidationKey) return;
  lastInvalidationKey = key;
  CacheSyncService.onDirectMessagesMutated(detail.userId);
}

function normalizeDetail(
  value: Partial<DirectMessagesUpdatedDetail> | null | undefined,
): DirectMessagesUpdatedDetail | null {
  const userId = String(value?.userId || "").trim();
  if (!userId) return null;
  const source = value?.source;
  if (source !== "send" && source !== "fcm" && source !== "sse" && source !== "read" && source !== "delete") {
    return null;
  }
  const changedAt = Number(value?.changedAt);
  return {
    userId,
    conversationId: String(value?.conversationId || "").trim() || null,
    messageId: String(value?.messageId || "").trim() || null,
    source,
    changedAt: Number.isFinite(changedAt) ? changedAt : Date.now(),
  };
}

/** Update current-tab consumers and other open Hushh tabs without localStorage. */
export function dispatchDirectMessagesUpdated(
  detail: Omit<DirectMessagesUpdatedDetail, "changedAt">,
): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeDetail({ ...detail, changedAt: Date.now() });
  if (!normalized) return;
  invalidateMessageSnapshot(normalized);
  window.dispatchEvent(
    new CustomEvent<DirectMessagesUpdatedDetail>(DIRECT_MESSAGES_UPDATED_EVENT, {
      detail: normalized,
    }),
  );
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(DIRECT_MESSAGES_CHANNEL);
  channel.postMessage(normalized);
  channel.close();
}

export function subscribeToDirectMessagesUpdated(
  listener: (detail: DirectMessagesUpdatedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let lastDeliveredKey = "";
  const deliver = (detail: DirectMessagesUpdatedDetail) => {
    const key = `${detail.userId}:${detail.conversationId ?? ""}:${detail.messageId ?? ""}:${detail.changedAt}`;
    if (key === lastDeliveredKey) return;
    lastDeliveredKey = key;
    invalidateMessageSnapshot(detail);
    listener(detail);
  };
  const onWindowEvent = (event: Event) => {
    const detail = normalizeDetail(
      (event as CustomEvent<Partial<DirectMessagesUpdatedDetail>>).detail,
    );
    if (detail) deliver(detail);
  };
  window.addEventListener(DIRECT_MESSAGES_UPDATED_EVENT, onWindowEvent);

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(DIRECT_MESSAGES_CHANNEL);
  const onChannelMessage = (event: MessageEvent<unknown>) => {
    const detail = normalizeDetail(
      event.data as Partial<DirectMessagesUpdatedDetail>,
    );
    if (detail) deliver(detail);
  };
  channel?.addEventListener("message", onChannelMessage);

  return () => {
    window.removeEventListener(DIRECT_MESSAGES_UPDATED_EVENT, onWindowEvent);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
  };
}
