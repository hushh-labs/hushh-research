const PKM_DOMAIN_CHANGE_CHANNEL = "hushh-pkm-domain-change-v1";
const PKM_DOMAIN_CHANGE_SOURCE_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random()}`;

export type PkmDomainChangeDetail = {
  userId: string;
  domain: string;
  dataVersion: number | null;
  updatedAt: string | null;
  operation: "stored" | "cleared" | "restored";
  /** Stable across SSE/FCM and tabs for one backend mutation. */
  eventId?: string;
};

let fallbackEventSequence = 0;

function createEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `pkm-domain-change:${crypto.randomUUID()}`;
  }
  fallbackEventSequence += 1;
  return `${PKM_DOMAIN_CHANGE_SOURCE_ID}:${Date.now()}:${fallbackEventSequence}`;
}

function normalizeDetail(value: unknown): PkmDomainChangeDetail | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PkmDomainChangeDetail>;
  const userId = String(candidate.userId || "").trim();
  const domain = String(candidate.domain || "").trim();
  if (!userId || !domain) return null;
  const operation = candidate.operation;
  const eventId = String(candidate.eventId || "").trim();
  if (
    operation !== "stored" &&
    operation !== "cleared" &&
    operation !== "restored"
  ) {
    return null;
  }
  return {
    userId,
    domain,
    dataVersion:
      typeof candidate.dataVersion === "number" &&
      Number.isFinite(candidate.dataVersion)
        ? candidate.dataVersion
        : null,
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : null,
    operation,
    ...(eventId ? { eventId } : null),
  };
}

function normalizeWireDetail(value: unknown): PkmDomainChangeDetail | null {
  if (value && typeof value === "object" && "detail" in value) {
    return normalizeDetail((value as { detail?: unknown }).detail);
  }
  return normalizeDetail(value);
}

/** Publish only encrypted-domain freshness metadata, never decrypted PKM. */
export function dispatchLocalPkmDomainChanged(
  detail: PkmDomainChangeDetail,
): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeDetail(detail);
  if (!normalized) return;
  window.dispatchEvent(
    new CustomEvent<PkmDomainChangeDetail>("pkm-domain-changed", {
      detail: normalized,
    }),
  );
}

/** Publish to this tab and relay the same metadata-only doorbell to peers. */
export function dispatchPkmDomainChanged(detail: PkmDomainChangeDetail): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeDetail(detail);
  if (!normalized) return;
  const identified = normalized.eventId
    ? normalized
    : { ...normalized, eventId: createEventId() };
  dispatchLocalPkmDomainChanged(identified);
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(PKM_DOMAIN_CHANGE_CHANNEL);
  channel.postMessage({
    sourceId: PKM_DOMAIN_CHANGE_SOURCE_ID,
    detail: identified,
  });
  channel.close();
}

export function subscribeToPkmDomainChanges(
  listener: (detail: PkmDomainChangeDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const seenEventIds = new Set<string>();
  const deliver = (value: unknown) => {
    const detail = normalizeWireDetail(value);
    if (!detail) return;
    if (detail.eventId) {
      if (seenEventIds.has(detail.eventId)) return;
      seenEventIds.add(detail.eventId);
      if (seenEventIds.size > 128) {
        const oldest = seenEventIds.values().next().value;
        if (oldest) seenEventIds.delete(oldest);
      }
    }
    listener(detail);
  };
  const onWindowEvent = (event: Event) =>
    deliver((event as CustomEvent<unknown>).detail);
  window.addEventListener("pkm-domain-changed", onWindowEvent);

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(PKM_DOMAIN_CHANGE_CHANNEL);
  const onChannelMessage = (event: MessageEvent<unknown>) =>
    deliver(event.data);
  channel?.addEventListener("message", onChannelMessage);

  return () => {
    window.removeEventListener("pkm-domain-changed", onWindowEvent);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
  };
}

/** Subscribe only to validated events emitted by a different browser tab. */
export function subscribeToRemotePkmDomainChanges(
  listener: (detail: PkmDomainChangeDetail) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => undefined;
  }
  const channel = new BroadcastChannel(PKM_DOMAIN_CHANGE_CHANNEL);
  const onChannelMessage = (event: MessageEvent<unknown>) => {
    if (
      event.data &&
      typeof event.data === "object" &&
      "sourceId" in event.data &&
      (event.data as { sourceId?: unknown }).sourceId ===
        PKM_DOMAIN_CHANGE_SOURCE_ID
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
