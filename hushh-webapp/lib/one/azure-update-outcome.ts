import { releaseLabel } from "@/lib/feed/agent-update-status";
import type { ApiService } from "@/lib/services/api-service";

/**
 * The outcome of an approved Azure agent update, decided one way for every
 * surface that follows it (the profile pane, the Feed card, the sign-in return
 * page).
 *
 * Two records speak about an Azure update. The setup job is the work the
 * owner's Microsoft sign-in started; the agent status is what actually runs.
 * They can disagree: on 2026-10-05 recovery confirmed an installation after
 * the setup job failed. Completion therefore requires the hub's verified
 * receipt for the exact followed operation and installed digest. Labels and
 * job completion do not prove recovery. A later offer cannot change which
 * operation is followed. Definitive provider failures remain failures.
 */

type AgentStatus = Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>;
type SetupStatus = Awaited<ReturnType<typeof ApiService.getByocSetupStatus>>;

export type AzureUpdateVerdict =
  | { kind: "updating"; confirming: boolean }
  | { kind: "updated"; version: string | null }
  | { kind: "failed"; message: string };

/** One set of words for the update's states, shared by the pane and the Feed. */
export const AZURE_UPDATE_COPY = {
  signingIn:
    "Finish signing in with Microsoft in the window that opened. Your agent keeps its current version until the update starts.",
  updating: "Updating your agent",
  running: "This runs in your Azure subscription. You can keep using Hussh while it finishes.",
  confirming: "Confirming the new version with your agent…",
  failed: "The update did not finish",
  unconfirmed: "We couldn’t confirm the update yet. Check for updates in a moment.",
  retry: "Try the update again",
} as const;

export function azureUpdatedLabel(version: string | null, releasedAt: string | null): string {
  return version ? `Updated to ${releaseLabel(version, releasedAt)}` : "Your agent is updated";
}

const SETTLING_PHASES: ReadonlyArray<string> = ["preparing", "installing", "verifying"];

/**
 * Job codes that settle an update as failed on their own: Azure reported the new
 * revision failed (`UPGRADE_REVISION_FAILED`), or a retry reconciled an earlier
 * attempt whose revision failed (`UPGRADE_FAILED`). Any other failure, including
 * `UPGRADE_UNCONFIRMED` (no verdict arrived in time), is settled by the hub.
 */
const DEFINITIVE_FAILURE_CODES: ReadonlyArray<string> = ["UPGRADE_REVISION_FAILED", "UPGRADE_FAILED"];

/** Said when the hub's recovery, not the job, recorded that the new version never ran. */
export const HUB_RECORDED_FAILURE =
  "The new version did not start. Your agent keeps running the version it had.";

/** The hub's update is still moving through its milestones. */
function hubStillMoving(status: AgentStatus): boolean {
  const update = status.update;
  if (!update || status.updateFailed) return false;
  return update.presentationState === "updating" || SETTLING_PHASES.includes(update.phase ?? "");
}

/**
 * The hub kept the update's lease and its read-only recovery is still settling
 * the outcome (`pod_update_presentation._blocked_update`: `updateFailed` with the
 * `blocked` state, "Check again while recovery continues"). That is no verdict.
 */
export function hubStillRecovering(status: AgentStatus): boolean {
  return Boolean(status.updateFailed) && status.update?.presentationState === "blocked";
}

/** Version labels and terminal jobs cannot establish installation or recovery. */
function verifiedCompletion(status: AgentStatus | null, operationId?: string | null, releaseId?: string | null) {
  const receipt = status?.completedUpdate;
  if (!operationId || !releaseId || status?.installedReleaseVerified !== true || !receipt) return null;
  if (receipt.operationId !== operationId || receipt.releaseId !== releaseId ||
      !receipt.podIncarnation?.trim() || !receipt.verifiedAt || !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest) ||
      receipt.imageDigest !== status.installedRelease?.imageDigest) return null;
  return receipt;
}

/**
 * A setup-status record holds the person's latest job, which may be an earlier
 * setup or another attempt: only a record naming this job is this update's.
 */
export function isUpdateJobRecord(
  job: SetupStatus | null,
  jobId: string | null,
): job is SetupStatus {
  return Boolean(job && jobId && job.status !== "none" && job.jobId === jobId);
}

export function updateFailureSentence(job: SetupStatus): string {
  return job.stale
    ? "The update stopped partway (our side restarted) before it was confirmed."
    : job.errorMessage || "The update stopped before it was confirmed.";
}

function failedJobVerdict(job: SetupStatus, status: AgentStatus | null): AzureUpdateVerdict {
  if (DEFINITIVE_FAILURE_CODES.includes(job.errorCode ?? "")) {
    return { kind: "failed", message: updateFailureSentence(job) };
  }
  // Without the agent's status there is no evidence either way; ask again.
  if (status === null || hubStillRecovering(status) || hubStillMoving(status)) {
    return { kind: "updating", confirming: true };
  }
  // The hub has settled with the approved release not installed. A job that only
  // knew it had no verdict yet says nothing about this, so the hub's answer speaks.
  return {
    kind: "failed",
    message: job.errorCode === "UPGRADE_UNCONFIRMED" ? HUB_RECORDED_FAILURE : updateFailureSentence(job),
  };
}

/**
 * Updated only from the verified receipt for this operation. Missing identity
 * or installation evidence remains unconfirmed. Callers bound the wait with
 * `AZURE_UPDATE_FOLLOW_CEILING_MS`.
 */
export function azureUpdateVerdict(input: {
  /** Retained for older callers; a display label never authorizes completion. */
  approvedVersion?: string | null;
  operationId?: string | null;
  releaseId?: string | null;
  status: AgentStatus | null;
  /** This update's own job record, or `null` when unread or not yet visible. */
  job: SetupStatus | null;
}): AzureUpdateVerdict {
  const { job, status } = input;
  const receipt = verifiedCompletion(status, input.operationId, input.releaseId);
  if (receipt) return { kind: "updated", version: receipt.version ?? status?.installedRelease?.version ?? null };
  const jobFailed = job !== null && (job.status === "failed" || job.stale);
  if (jobFailed) return failedJobVerdict(job, status);
  return { kind: "updating", confirming: job?.status === "recorded" };
}
