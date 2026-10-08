/** Server-observed software update status. Missing evidence stays unknown. */
export type AgentUpdateStatus = {
  available: boolean | null;
  offerable: boolean;
  inProgress: boolean;
  failed: boolean;
  error: string | null;
  running: string | null;
  target: string | null;
  releaseId: string | null;
  summary: string | null;
  presentationState:
    "ready" | "deferred" | "scheduled" | "updating" | "verified" | "blocked" | null;
  phase: "scheduled" | "preparing" | "installing" | "verifying" | "verified" | "blocked" | null;
  remindAt: string | null;
  operationId: string | null;
  verified: boolean;
};

export const NO_UPDATE: AgentUpdateStatus = {
  available: null,
  offerable: false,
  inProgress: false,
  failed: false,
  error: null,
  running: null,
  target: null,
  releaseId: null,
  summary: null,
  presentationState: null,
  phase: null,
  remindAt: null,
  operationId: null,
  verified: false,
};

/** Use the published UTC date for people; keep the immutable build ID in the API. */
export function releaseLabel(version: string, releasedAt?: string | null): string {
  const match = /^(\d{4})\.(\d{2})-(dev|stable)\.(\d+)(?:\+.*)?$/.exec(version);
  if (!match) return version;
  const [, year, month, channel, sequence] = match;
  const published = releasedAt ? new Date(releasedAt) : null;
  const date = published && Number.isFinite(published.getTime())
    ? `${String(published.getUTCDate()).padStart(2, "0")}.${String(published.getUTCMonth() + 1).padStart(2, "0")}.${String(published.getUTCFullYear()).slice(-2)}`
    : `${new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${year}`;
  return `${date} · ${channel === "dev" ? "Dev" : "Stable"} ${sequence}`;
}

/** Activity is independent of permission to approve another installation. */
export function updateActivityLabel(update: AgentUpdateStatus): string | null {
  if (update.failed || update.presentationState === "blocked")
    return "Update needs attention";
  if (update.phase === "verifying") return "Restarting and verifying";
  if (update.phase === "installing") return "Installing update";
  if (update.phase === "preparing") return "Finishing current work";
  if (update.presentationState === "scheduled") return "Update scheduled";
  if (update.inProgress || update.presentationState === "updating")
    return "Updating your private agent";
  return null;
}

/** Segment count reflects persisted milestones, not elapsed time or byte progress. */
export function updateProgressStage(update: AgentUpdateStatus): number | null {
  if (update.failed || update.presentationState === "blocked") return null;
  if (update.verified && update.presentationState === "verified") return 4;
  if (update.phase === "verifying") return 3;
  if (update.phase === "installing") return 2;
  if (update.phase === "preparing") return 1;
  if (update.phase === "scheduled" || update.presentationState === "scheduled") return 0;
  return null;
}

export function readUpdateStatus(
  res:
    | {
        runningImage?: string | null;
        targetImage?: string | null;
        updateAvailable?: boolean;
        updateOfferable?: boolean;
        updateInProgress?: boolean;
        updateFailed?: boolean;
        updateError?: string | null;
        updateVerified?: boolean;
        update?: {
          releaseId?: string;
          summary?: string;
          presentationState?:
            "ready" | "deferred" | "scheduled" | "updating" | "verified" | "blocked";
          phase?: "scheduled" | "preparing" | "installing" | "verifying" | "verified" | "blocked";
          remindAt?: string;
          operationId?: string;
        };
      }
    | null
    | undefined,
): AgentUpdateStatus {
  return {
    available:
      typeof res?.updateAvailable === "boolean" ? res.updateAvailable : null,
    // Only explicit server authority makes an observed release actionable.
    offerable: res?.updateOfferable === true,
    inProgress: res?.updateInProgress === true,
    failed: res?.updateFailed === true,
    error: res?.updateError ? String(res.updateError) : null,
    running: res?.runningImage ? String(res.runningImage) : null,
    target: res?.targetImage ? String(res.targetImage) : null,
    releaseId: res?.update?.releaseId ? String(res.update.releaseId) : null,
    summary: res?.update?.summary ? String(res.update.summary) : null,
    presentationState: res?.update?.presentationState ?? null,
    phase: res?.update?.phase ?? null,
    remindAt: res?.update?.remindAt ? String(res.update.remindAt) : null,
    operationId: res?.update?.operationId
      ? String(res.update.operationId)
      : null,
    verified: res?.updateVerified === true,
  };
}
