const PKM_DOMAIN_CHANGE_CHANNEL = "hushh-pkm-domain-change-v1";

export type PkmDomainChangeDetail = {
  userId: string;
  domain: string;
  dataVersion: number | null;
  updatedAt: string | null;
  operation: "stored" | "cleared" | "restored";
};

function normalizeDetail(value: unknown): PkmDomainChangeDetail | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PkmDomainChangeDetail>;
  const userId = String(candidate.userId || "").trim();
  const domain = String(candidate.domain || "").trim();
  if (!userId || !domain) return null;
  const operation = candidate.operation;
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
  };
}

/** Publish only encrypted-domain freshness metadata, never decrypted PKM. */
export function dispatchPkmDomainChanged(
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
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(PKM_DOMAIN_CHANGE_CHANNEL);
  channel.postMessage(normalized);
  channel.close();
}

export function subscribeToPkmDomainChanges(
  listener: (detail: PkmDomainChangeDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  let lastDeliveredKey = "";
  const deliver = (value: unknown) => {
    const detail = normalizeDetail(value);
    if (!detail) return;
    const key = `${detail.userId}:${detail.domain}:${detail.dataVersion ?? ""}:${detail.updatedAt ?? ""}:${detail.operation}`;
    if (key === lastDeliveredKey) return;
    lastDeliveredKey = key;
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
