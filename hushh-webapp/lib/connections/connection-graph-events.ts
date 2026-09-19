"use client";

export const CONNECTION_GRAPH_CHANGED_EVENT =
  "hushh:connection-graph-changed";

const CONNECTION_GRAPH_CHANNEL = "hushh-connection-graph-v1";

export type ConnectionGraphChangedDetail = {
  userId: string;
  changedAt: number;
};

function normalizeDetail(
  value: Partial<ConnectionGraphChangedDetail> | null | undefined,
): ConnectionGraphChangedDetail | null {
  const userId = String(value?.userId || "").trim();
  if (!userId) return null;
  const changedAt = Number(value?.changedAt);
  return {
    userId,
    changedAt: Number.isFinite(changedAt) ? changedAt : Date.now(),
  };
}

/**
 * Announce that connection-backed projections must reconcile.
 *
 * The DOM event updates mounted consumers in this tab. BroadcastChannel covers
 * another open Hushh tab without writing relationship data to localStorage.
 */
export function dispatchConnectionGraphChanged(userId: string): void {
  if (typeof window === "undefined") return;
  const detail = normalizeDetail({ userId, changedAt: Date.now() });
  if (!detail) return;

  window.dispatchEvent(
    new CustomEvent<ConnectionGraphChangedDetail>(
      CONNECTION_GRAPH_CHANGED_EVENT,
      { detail },
    ),
  );

  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CONNECTION_GRAPH_CHANNEL);
  channel.postMessage(detail);
  channel.close();
}

export function subscribeToConnectionGraphChanges(
  listener: (detail: ConnectionGraphChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let lastDeliveredKey = "";
  const deliver = (detail: ConnectionGraphChangedDetail) => {
    const key = `${detail.userId}:${detail.changedAt}`;
    if (key === lastDeliveredKey) return;
    lastDeliveredKey = key;
    listener(detail);
  };

  const onWindowEvent = (event: Event) => {
    const detail = normalizeDetail(
      (event as CustomEvent<Partial<ConnectionGraphChangedDetail>>).detail,
    );
    if (detail) deliver(detail);
  };
  window.addEventListener(CONNECTION_GRAPH_CHANGED_EVENT, onWindowEvent);

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CONNECTION_GRAPH_CHANNEL);
  const onChannelMessage = (event: MessageEvent<unknown>) => {
    const detail = normalizeDetail(
      event.data as Partial<ConnectionGraphChangedDetail>,
    );
    if (detail) deliver(detail);
  };
  channel?.addEventListener("message", onChannelMessage);

  return () => {
    window.removeEventListener(CONNECTION_GRAPH_CHANGED_EVENT, onWindowEvent);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
  };
}
