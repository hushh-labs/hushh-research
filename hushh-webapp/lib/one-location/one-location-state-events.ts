"use client";

export const ONE_LOCATION_STATE_CHANGED_EVENT =
  "hushh:one-location-state-changed";

const ONE_LOCATION_STATE_CHANNEL = "hushh-one-location-state-v1";

export type OneLocationStateDomain = "workspace" | "circles" | "sms_roster";

export type OneLocationStateChangedDetail = {
  userId: string;
  domains: OneLocationStateDomain[];
  changedAt: number;
};

function normalizeDetail(
  value: Partial<OneLocationStateChangedDetail> | null | undefined,
): OneLocationStateChangedDetail | null {
  const userId = String(value?.userId || "").trim();
  if (!userId) return null;
  const domains = Array.from(
    new Set(
      (Array.isArray(value?.domains) ? value.domains : ["workspace"])
        .map((domain) => String(domain || "").trim())
        .filter(
          (domain): domain is OneLocationStateDomain =>
            domain === "workspace" ||
            domain === "circles" ||
            domain === "sms_roster",
        ),
    ),
  );
  const changedAt = Number(value?.changedAt);
  return {
    userId,
    domains: domains.length > 0 ? domains : ["workspace"],
    changedAt: Number.isFinite(changedAt) ? changedAt : Date.now(),
  };
}

/**
 * Publish a One Location mutation to every mounted surface for this account.
 *
 * The DOM event updates the current tab. BroadcastChannel updates another open
 * tab without persisting private roster data in browser storage.
 */
export function dispatchOneLocationStateChanged(
  userId: string,
  domains: OneLocationStateDomain[] = ["workspace"],
): void {
  if (typeof window === "undefined") return;
  const detail = normalizeDetail({ userId, domains, changedAt: Date.now() });
  if (!detail) return;

  window.dispatchEvent(
    new CustomEvent<OneLocationStateChangedDetail>(
      ONE_LOCATION_STATE_CHANGED_EVENT,
      { detail },
    ),
  );

  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(ONE_LOCATION_STATE_CHANNEL);
  channel.postMessage(detail);
  channel.close();
}

export function subscribeToOneLocationStateChanges(
  listener: (detail: OneLocationStateChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let lastDeliveredKey = "";
  const deliver = (detail: OneLocationStateChangedDetail) => {
    const key = `${detail.userId}:${detail.changedAt}:${detail.domains.join(",")}`;
    if (key === lastDeliveredKey) return;
    lastDeliveredKey = key;
    listener(detail);
  };

  const onWindowEvent = (event: Event) => {
    const detail = normalizeDetail(
      (event as CustomEvent<Partial<OneLocationStateChangedDetail>>).detail,
    );
    if (detail) deliver(detail);
  };
  window.addEventListener(ONE_LOCATION_STATE_CHANGED_EVENT, onWindowEvent);

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(ONE_LOCATION_STATE_CHANNEL);
  const onChannelMessage = (event: MessageEvent<unknown>) => {
    const detail = normalizeDetail(
      event.data as Partial<OneLocationStateChangedDetail>,
    );
    if (detail) deliver(detail);
  };
  channel?.addEventListener("message", onChannelMessage);

  return () => {
    window.removeEventListener(ONE_LOCATION_STATE_CHANGED_EVENT, onWindowEvent);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
  };
}
