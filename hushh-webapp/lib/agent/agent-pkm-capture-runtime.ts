import {
  describePkmSaveReceipt,
  type ExplicitPkmSaveProgress,
  type PkmSaveReceipt,
} from "@/lib/agent/pkm-save-receipt";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

/**
 * Session-only status for one memory capture. `receipt` exists only for an
 * explicit save and is built from server-acknowledged commits; its item text is
 * the owner's own words, held in memory for this session and never logged.
 */
export type AgentPkmCaptureStatus = {
  phase:
    | "preparing"
    | "saving"
    | "saved"
    | "skipped"
    | "review"
    | "partial"
    | "failed"
    | "canceled"
    | "needs_unlock";
  saved: number;
  progress?: ExplicitPkmSaveProgress;
  receipt?: PkmSaveReceipt;
  /** Why a capture failed, in plain words. Never provider text. */
  reason?: "timeout";
};

const RUNNING_PHASES: ReadonlySet<AgentPkmCaptureStatus["phase"]> = new Set(["preparing", "saving"]);

export function isAgentPkmCaptureRunning(status: AgentPkmCaptureStatus): boolean {
  return RUNNING_PHASES.has(status.phase);
}

/**
 * Progress is shown only while the capture's session is current. A terminal
 * status is always shown: it is display only, and a status that never
 * resolves ("Checking for details worth remembering…" left on screen after a
 * vault token expired by the clock, 2026-09-29) claims work that is not
 * happening.
 */
export function shouldPublishAgentPkmCapture(
  status: AgentPkmCaptureStatus,
  sessionCurrent: boolean,
): boolean {
  return sessionCurrent || !isAgentPkmCaptureRunning(status);
}

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
  // An explicit save carries its own receipt and progress; one per turn.
  const explicit = [...statuses].reverse().find((status) => status.receipt || status.progress);
  const detail = explicit
    ? {
        ...(explicit.receipt ? { receipt: explicit.receipt } : {}),
        ...(explicit.progress && isAgentPkmCaptureRunning(explicit) ? { progress: explicit.progress } : {}),
      }
    : {};
  if (phases.has("saving")) return { phase: "saving", saved, ...detail };
  if (phases.has("preparing")) return { phase: "preparing", saved, ...detail };
  if (phases.has("needs_unlock")) return { phase: "needs_unlock", saved, ...detail };
  const reason = statuses.find((status) => status.reason)?.reason;
  if (explicit?.receipt) {
    return { ...explicit, saved, ...detail, ...(reason ? { reason } : {}) };
  }
  const needsAttention = ["review", "partial", "failed", "canceled"].some(
    (phase) => phases.has(phase as AgentPkmCaptureStatus["phase"]),
  );
  if (saved > 0) return { phase: needsAttention ? "partial" : "saved", saved };
  if (phases.has("canceled")) return { phase: "canceled", saved };
  if (phases.has("failed")) return { phase: "failed", saved, ...(reason ? { reason } : {}) };
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
  const progress = status.progress;
  if (status.phase === "preparing" && progress?.stage === "reading" && progress.total > 1) {
    return `Reading section ${Math.max(1, progress.done)} of ${progress.total}…`;
  }
  if (status.phase === "saving" && progress?.stage === "saving") {
    return `Saving ${progress.total} ${progress.total === 1 ? "detail" : "details"} privately…`;
  }
  if (status.receipt && !isAgentPkmCaptureRunning(status) && status.phase !== "canceled") {
    const line = describePkmSaveReceipt(status.receipt);
    return status.reason === "timeout" ? `${line} Stopped after the time limit.` : line;
  }
  switch (status.phase) {
    case "preparing":
      return "Checking for details worth remembering…";
    case "saving":
      return "Saving eligible details privately…";
    case "needs_unlock":
      return "Unlock your vault to save this. Nothing was saved.";
    case "saved":
      return saved;
    case "partial":
      return `${saved}; some details still need attention.`;
    case "review":
      return "Some details need review before saving.";
    case "failed":
      return status.reason === "timeout"
        ? "Memory capture timed out. Nothing was saved."
        : "Memory capture couldn’t finish. You can retry in Memory.";
    case "canceled":
      return "Memory capture stopped when the session changed. Check Memory before retrying.";
    case "skipped":
      return "No new eligible details to save.";
  }
}
