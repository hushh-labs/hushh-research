/**
 * `metadata.consentAccess` on an answer that used another person's shared
 * information (contract C3). Names and human labels only, never values.
 */
export type AgentChatConsentAccess = {
  bundleId: string;
  state: "live" | "ended";
  /** Why access ended; null while it is live. */
  outcome: "revoked" | "expired" | null;
  personName: string | null;
  labels: string[];
};

function endedReason(value: unknown): "revoked" | "expired" | null {
  return value === "revoked" || value === "expired" ? value : null;
}

/**
 * Read `metadata.consentAccess`, falling back to the response's
 * `consentAccessEnded` map for the reason. Anything malformed reads as absent.
 */
export function parseConsentAccess(
  value: unknown,
  endedByBundle: Readonly<Record<string, unknown>> = {},
): AgentChatConsentAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const bundleId = typeof record.bundleId === "string" ? record.bundleId.trim() : "";
  if (!bundleId) return undefined;
  const outcome = endedReason(record.outcome) ?? endedReason(endedByBundle[bundleId]);
  const labels = Array.isArray(record.labels)
    ? record.labels.filter((label): label is string => typeof label === "string" && Boolean(label.trim()))
      .map((label) => label.trim().slice(0, 120)).slice(0, 20)
    : [];
  const personName = typeof record.personName === "string" && record.personName.trim()
    ? record.personName.trim().slice(0, 120) : null;
  return {
    bundleId,
    state: record.state === "ended" || outcome ? "ended" : "live",
    outcome,
    personName,
    labels,
  };
}
