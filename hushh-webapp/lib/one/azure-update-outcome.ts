import { releaseLabel } from "@/lib/feed/agent-update-status";
import type { ApiService } from "@/lib/services/api-service";

/**
 * The outcome of an approved Azure agent update, decided one way for every
 * surface that follows it (the profile pane, the Feed card, the sign-in return
 * page).
 *
 * Two records speak about an Azure update. The setup job is the work the
 * owner's Microsoft sign-in started; the agent status is what actually runs.
 * They can disagree: on 2026-10-05 the replace succeeded, the job failed
 * because the new revision was not ready yet, and the hub's read-only recovery
 * recorded the new release about 40 seconds later. The app then said the
 * update did not finish while the agent ran the new version. So the agent
 * status wins: the approved release installed means updated, whatever the job
 * says. A failed job is a failure only when its code is definitive, or once the
 * hub has stopped recovering without the release installed.
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

/** The hub verified the approved operation it projects (its receipt binds release and digest). */
function hubVerified(status: AgentStatus | null): boolean {
  return status?.update?.presentationState === "verified";
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
 * Updated once the agent reports the approved release installed. A failed job
 * is final only with a definitive code; otherwise it stays "confirming" while
 * the hub still moves or recovers, and fails only once the hub has settled
 * without the release. Callers bound the wait (`AZURE_UPDATE_FOLLOW_CEILING_MS`).
 */
export function azureUpdateVerdict(input: {
  approvedVersion: string | null;
  status: AgentStatus | null;
  /** This update's own job record, or `null` when unread or not yet visible. */
  job: SetupStatus | null;
}): AzureUpdateVerdict {
  const { job, status } = input;
  const installed = status?.installedRelease?.version ?? null;
  if (installed !== null && installed === input.approvedVersion) {
    return { kind: "updated", version: installed };
  }
  const jobFailed = job !== null && (job.status === "failed" || job.stale);
  // A settled job whose release the status has not named yet is a status
  // lagging by a read, unless the hub already calls this update verified.
  if ((job?.status === "recorded" || jobFailed) && hubVerified(status)) {
    return { kind: "updated", version: installed };
  }
  if (job?.status === "recorded" && input.approvedVersion === null) {
    return { kind: "updated", version: installed };
  }
  if (jobFailed) return failedJobVerdict(job, status);
  return { kind: "updating", confirming: false };
}
