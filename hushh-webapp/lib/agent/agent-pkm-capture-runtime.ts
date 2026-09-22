import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

/** Session-only receipt: no source text, personal fields, or credentials. */
export type AgentPkmCaptureStatus = {
  phase:
    | "preparing"
    | "saving"
    | "saved"
    | "skipped"
    | "review"
    | "partial"
    | "failed"
    | "canceled";
  saved: number;
};

/** Re-evaluate at each effect: time can expire without a React render. */
export function isAgentPkmProcessingReady(state: {
  authLoading: boolean;
  sessionVerificationRequired?: boolean;
  isVaultUnlocked: boolean;
  vaultOwnerToken: string | null;
  tokenExpiresAt: number | null;
}, expectedToken: string): boolean {
  return !state.authLoading && !state.sessionVerificationRequired &&
    state.isVaultUnlocked && state.vaultOwnerToken === expectedToken &&
    state.tokenExpiresAt !== null && Date.now() < state.tokenExpiresAt;
}

/** One turn can contain several distinct capture invocations, in any order. */
export function aggregateAgentPkmCaptures(
  statuses: AgentPkmCaptureStatus[],
): AgentPkmCaptureStatus {
  const saved = statuses.reduce((total, status) => total + status.saved, 0);
  const phases = new Set(statuses.map((status) => status.phase));
  if (phases.has("saving")) return { phase: "saving", saved };
  if (phases.has("preparing")) return { phase: "preparing", saved };
  const needsAttention = ["review", "partial", "failed", "canceled"].some(
    (phase) => phases.has(phase as AgentPkmCaptureStatus["phase"]),
  );
  if (saved > 0) return { phase: needsAttention ? "partial" : "saved", saved };
  if (phases.has("canceled")) return { phase: "canceled", saved };
  if (phases.has("failed")) return { phase: "failed", saved };
  return { phase: needsAttention ? "review" : "skipped", saved };
}

/** Conversation changes/unmount abort the signal; later turns do not. */
export function createAgentPkmCaptureGuard(params: {
  userId: string;
  signal: AbortSignal;
  isEnabled: () => boolean;
}) {
  const owner = snapshotValidatedAuthSessionOwner();
  const vaultEpoch = snapshotVaultSessionEpoch();
  const isCurrent = () =>
    Boolean(
      owner &&
      owner.userId === params.userId &&
      isValidatedAuthSessionOwnerCurrent(owner) &&
      isVaultSessionEpochCurrent(vaultEpoch) &&
      !params.signal.aborted &&
      params.isEnabled(),
    );
  const assertCurrent = async () => {
    if (!isCurrent())
      throw new DOMException("Memory capture session changed.", "AbortError");
  };
  return { isCurrent, assertCurrent };
}

export function describeAgentPkmCapture(status: AgentPkmCaptureStatus): string {
  const saved = `${status.saved} ${status.saved === 1 ? "detail" : "details"} saved privately`;
  switch (status.phase) {
    case "preparing":
      return "Checking for details worth remembering…";
    case "saving":
      return "Saving eligible details privately…";
    case "saved":
      return saved;
    case "partial":
      return `${saved}; some details still need attention.`;
    case "review":
      return "Some details need review before saving.";
    case "failed":
      return "Memory capture couldn’t finish. You can retry in Memory.";
    case "canceled":
      return "Memory capture stopped when the session changed. Check Memory before retrying.";
    case "skipped":
      return "No new eligible details to save.";
  }
}
