/** Count-only progress for an owner-authorized Drive document batch. */
export const DRIVE_BATCH_PROGRESS_ACTIVITY_TYPE = "one.drive_batch_progress.v1";

export type DriveBatchProgressPhase =
  | "searching"
  | "fetching"
  | "summarizing"
  | "finalizing"
  | "complete"
  | "partial"
  | "error";

export type DriveBatchProgress = {
  phase: DriveBatchProgressPhase;
  /** Settled file checks while fetching; finished summaries while summarizing. */
  completed: number;
  /** File checks while fetching; readable files while summarizing. */
  total: number;
  /** Cumulative unreadable or failed files, as reported by the server. */
  failed: number;
};

/** Ephemeral chat UI state; the Markdown itself stays in a memory-only ref. */
export type DriveCompilationUiState = {
  status: "running" | "ready" | "partial" | "error";
  matched?: number;
  included?: number;
  failed?: number;
  errorReason?: "connect_required" | "reconnect_required" | "input_required" |
    "source_changed" | "interrupted" | "unavailable";
};

const PHASES = new Set<DriveBatchProgressPhase>([
  "searching", "fetching", "summarizing", "finalizing", "complete", "partial", "error",
]);
const MAX_BATCH_FILES = 100;

function boundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= MAX_BATCH_FILES
    ? value
    : null;
}

/** Ignore unexpected payload fields so Drive titles, IDs and content never reach UI state. */
export function parseDriveBatchProgressActivity(
  activityType: string | null | undefined,
  content: unknown,
): DriveBatchProgress | null {
  if (activityType !== DRIVE_BATCH_PROGRESS_ACTIVITY_TYPE ||
    !content || typeof content !== "object" || Array.isArray(content)) {
    return null;
  }
  const record = content as Record<string, unknown>;
  const phase = record.phase;
  if (typeof phase !== "string" || !PHASES.has(phase as DriveBatchProgressPhase)) {
    return null;
  }
  const completed = boundedCount(record.completed);
  const total = boundedCount(record.total);
  const failed = boundedCount(record.failed);
  if (completed === null || total === null || failed === null || completed > total) {
    return null;
  }
  if (phase === "fetching" && failed > completed) return null;
  return { phase: phase as DriveBatchProgressPhase, completed, total, failed };
}

export function driveBatchProgressPercent(progress: DriveBatchProgress): number | null {
  if (progress.phase !== "fetching" || progress.total === 0) return null;
  return (progress.completed / progress.total) * 100;
}
