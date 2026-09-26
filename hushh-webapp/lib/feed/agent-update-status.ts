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
    "ready" | "deferred" | "scheduled" | "updating" | "blocked" | null;
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
  remindAt: null,
  operationId: null,
  verified: false,
};

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
            "ready" | "deferred" | "scheduled" | "updating" | "blocked";
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
    remindAt: res?.update?.remindAt ? String(res.update.remindAt) : null,
    operationId: res?.update?.operationId
      ? String(res.update.operationId)
      : null,
    verified: res?.updateVerified === true,
  };
}

