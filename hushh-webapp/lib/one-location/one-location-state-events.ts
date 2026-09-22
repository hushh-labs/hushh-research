"use client";

export const ONE_LOCATION_STATE_CHANGED_EVENT =
  "hushh:one-location-state-changed";

const ONE_LOCATION_STATE_CHANNEL = "hushh-one-location-state-v1";
const ONE_LOCATION_STATE_SOURCE_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random()}`;

export type OneLocationStateDomain =
  "workspace" | "circles" | "sms_roster" | "map_preferences";

export type OneLocationStateChangedDetail = {
  userId: string;
  domains: OneLocationStateDomain[];
  changedAt: number;
  /** Optional, non-sensitive mutation identity for consumers that must react
   *  differently to a terminal transition (for example, closing a Circle
   *  detail after that Circle was deleted). */
  notificationType?: string;
  circleId?: string;
  /** Account whose membership was removed. Kept as one opaque identifier so
   *  an open detail can distinguish "you lost access" from "your roster
   *  changed" without broadcasting any roster contents. */
  memberUserId?: string;
  /** Stable across SSE/FCM and tabs for one backend transition. */
  eventId?: string;
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
            domain === "sms_roster" ||
            domain === "map_preferences",
        ),
    ),
  );
  const changedAt = Number(value?.changedAt);
  const notificationType = String(value?.notificationType || "").trim();
  const circleId = String(value?.circleId || "").trim();
  const memberUserId = String(value?.memberUserId || "").trim();
  const eventId = String(value?.eventId || "").trim();
  return {
    userId,
    domains: domains.length > 0 ? domains : ["workspace"],
    changedAt: Number.isFinite(changedAt) ? changedAt : Date.now(),
    ...(notificationType ? { notificationType } : null),
    ...(circleId ? { circleId } : null),
    ...(memberUserId ? { memberUserId } : null),
    ...(eventId ? { eventId } : null),
  };
}

function normalizeWireDetail(
  value: unknown,
): OneLocationStateChangedDetail | null {
  if (value && typeof value === "object" && "detail" in value) {
    return normalizeDetail(
      (value as { detail?: Partial<OneLocationStateChangedDetail> }).detail,
    );
  }
  return normalizeDetail(value as Partial<OneLocationStateChangedDetail>);
}

export function circleStateChangeClosesDetail(
  detail: Pick<
    OneLocationStateChangedDetail,
    "notificationType" | "circleId" | "memberUserId"
  >,
  viewerUserId: string,
  openCircleId: string,
): boolean {
  const sameCircle =
    Boolean(detail.circleId) &&
    detail.circleId === String(openCircleId || "").trim();
  if (!sameCircle) return false;
  if (detail.notificationType === "location_circle_deleted") return true;
  return (
    (detail.notificationType === "location_circle_member_removed" ||
      detail.notificationType === "location_circle_member_left") &&
    Boolean(detail.memberUserId) &&
    detail.memberUserId === String(viewerUserId || "").trim()
  );
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
  context: Pick<
    OneLocationStateChangedDetail,
    "notificationType" | "circleId" | "memberUserId" | "eventId"
  > = {},
): void {
  if (typeof window === "undefined") return;
  const detail = normalizeDetail({
    userId,
    domains,
    changedAt: Date.now(),
    ...context,
  });
  if (!detail) return;

  window.dispatchEvent(
    new CustomEvent<OneLocationStateChangedDetail>(
      ONE_LOCATION_STATE_CHANGED_EVENT,
      { detail },
    ),
  );

  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(ONE_LOCATION_STATE_CHANNEL);
  channel.postMessage({ sourceId: ONE_LOCATION_STATE_SOURCE_ID, detail });
  channel.close();
}

export function subscribeToOneLocationStateChanges(
  listener: (detail: OneLocationStateChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let lastDeliveredKey = "";
  const seenEventIds = new Set<string>();
  const deliver = (detail: OneLocationStateChangedDetail) => {
    if (detail.eventId) {
      const eventKey = `${detail.userId}:event:${detail.eventId}`;
      if (seenEventIds.has(eventKey)) return;
      seenEventIds.add(eventKey);
      // A tab can remain open for days. Bound transport-only replay memory;
      // backend transition ids are unique, so FIFO eviction is sufficient.
      if (seenEventIds.size > 128) {
        const oldest = seenEventIds.values().next().value;
        if (oldest) seenEventIds.delete(oldest);
      }
    }
    const key = `${detail.userId}:${detail.changedAt}:${detail.domains.join(",")}:${detail.notificationType || ""}:${detail.circleId || ""}:${detail.memberUserId || ""}`;
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
    const detail = normalizeWireDetail(event.data);
    if (detail) deliver(detail);
  };
  channel?.addEventListener("message", onChannelMessage);

  return () => {
    window.removeEventListener(ONE_LOCATION_STATE_CHANGED_EVENT, onWindowEvent);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
  };
}

/** Subscribe only to validated state events emitted by another browser tab. */
export function subscribeToRemoteOneLocationStateChanges(
  listener: (detail: OneLocationStateChangedDetail) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => undefined;
  }
  const channel = new BroadcastChannel(ONE_LOCATION_STATE_CHANNEL);
  const onChannelMessage = (event: MessageEvent<unknown>) => {
    if (
      event.data &&
      typeof event.data === "object" &&
      "sourceId" in event.data &&
      (event.data as { sourceId?: unknown }).sourceId ===
        ONE_LOCATION_STATE_SOURCE_ID
    ) {
      return;
    }
    const detail = normalizeWireDetail(event.data);
    if (detail) listener(detail);
  };
  channel.addEventListener("message", onChannelMessage);
  return () => {
    channel.removeEventListener("message", onChannelMessage);
    channel.close();
  };
}
