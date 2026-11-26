import { resolveAppEnvironment } from "@/lib/app-env";
import { ApiService } from "./api-service";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ROUTES } from "@/lib/navigation/routes";
import { readComputerUseJson } from "@/lib/computer-use/direct-transport";

export const FILE_ORGANIZATION_TEMPLATE = "agent_files.organize_file.v1";
const ONE_TASK_TEMPLATE = "agent_one.execute_task.v1";

function isScheduledCapability(value: unknown): boolean {
  return value === FILE_ORGANIZATION_TEMPLATE || value === ONE_TASK_TEMPLATE;
}

export type ScheduleFileSelection = { id: string; name: string } & (
  { revision: number; analysisRevision: number } | { revision?: never; analysisRevision?: never }
);
export function isScheduledTaskId(id: unknown): id is string {
  return typeof id === "string" && /^schedule_[a-f0-9]{32}$/.test(id);
}

export function scheduledTaskHref(taskId?: string): string {
  return `${ROUTES.ONE_TASKS}?scheduled=${isScheduledTaskId(taskId) ? taskId : "1"}`;
}

/** Product availability only; the pod still enforces execution authority. */
export function areScheduledTasksAvailable(): boolean {
  return resolveAppEnvironment() === "development";
}

const SCHEDULE_REPEATS = ["once", "daily", "weekly", "monthly"] as const;
export const SCHEDULE_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];
export type ScheduleRecurrence = {
  repeat: Exclude<ScheduleRepeat, "once">;
  weekdays?: number[];
  endsAt: number;
};
export type ScheduledRun = { state: string; started_at: number; finished_at?: number };
type RecentScheduledRun = ScheduledRun & { id: string };
export type ScheduleControl = "pause" | "resume" | "cancel" | "skip_next" | "run_now";

export type ScheduledTask = {
  id: string;
  title: string;
  capability: string;
  revision: number;
  state:
    | "pending_delivery"
    | "scheduled"
    | "running"
    | "cancelling"
    | "paused"
    | "cancelled"
    | "completed"
    | "needs_review";
  repeat: ScheduleRepeat;
  weekdays?: number[];
  timezone: string;
  next_run_at: number;
  run_now_pending?: boolean;
  authorization_expires_at: number;
  last_run: ScheduledRun | null;
  recent_runs?: RecentScheduledRun[];
};
export type ScheduledTasksStatus = {
  available: boolean;
  code: string | null;
  templates: string[];
  repeat_modes?: ScheduleRepeat[];
  run_now_available?: boolean;
  tasks: ScheduledTask[];
  authorization_limit_at: number | null;
};

function parseRun(value: unknown): ScheduledRun {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  const run = value as ScheduledRun;
  if (
    !["running", "completed", "failed", "needs_review", "cancelled", "outcome_uncertain"].includes(run.state) ||
    !Number.isSafeInteger(run.started_at) || run.started_at < 1 ||
    (run.finished_at != null && (!Number.isSafeInteger(run.finished_at) || run.finished_at < 1))
  ) throw new Error("SCHEDULE_RESPONSE_REFUSED");
  return {
    state: run.state,
    started_at: run.started_at,
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
  };
}

function parseTask(value: unknown): ScheduledTask {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  const row = value as ScheduledTask;
  if (
    !isScheduledTaskId(row.id) ||
    typeof row.title !== "string" ||
    !row.title ||
    row.title.length > 80 ||
    !isScheduledCapability(row.capability) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    ![
      "pending_delivery",
      "scheduled",
      "running",
      "cancelling",
      "paused",
      "cancelled",
      "completed",
      "needs_review",
    ].includes(row.state) ||
    !SCHEDULE_REPEATS.includes(row.repeat) ||
    (row.weekdays !== undefined && (
      row.repeat !== "weekly" || !Array.isArray(row.weekdays) ||
      row.weekdays.length < 1 || row.weekdays.length > 7 ||
      row.weekdays.some((day, index, days) =>
        !Number.isInteger(day) || day < 0 || day > 6 || day <= (days[index - 1] ?? -1),
      )
    )) ||
    typeof row.timezone !== "string" ||
    !row.timezone ||
    row.timezone.length > 64 ||
    !Number.isSafeInteger(row.next_run_at) ||
    row.next_run_at < 1 ||
    row.next_run_at > 253_402_300_799 ||
    (row.run_now_pending !== undefined && typeof row.run_now_pending !== "boolean") ||
    !Number.isSafeInteger(row.authorization_expires_at) ||
    row.authorization_expires_at < 1 ||
    (row.recent_runs !== undefined && (!Array.isArray(row.recent_runs) || row.recent_runs.length > 5))
  )
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  const recentRuns = row.recent_runs?.map((run) => {
    const parsed = parseRun(run);
    if (typeof run.id !== "string" || !/^[a-f0-9]{32}$/.test(run.id) || parsed.state === "running")
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return { ...parsed, id: run.id };
  });
  if (recentRuns && new Set(recentRuns.map((run) => run.id)).size !== recentRuns.length)
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  // Keep only display metadata; private terms/grants are never frontend state.
  return {
    id: row.id,
    title: row.title,
    capability: row.capability,
    revision: row.revision,
    state: row.state,
    repeat: row.repeat,
    ...(row.weekdays ? { weekdays: row.weekdays } : {}),
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    ...(row.run_now_pending !== undefined ? { run_now_pending: row.run_now_pending } : {}),
    authorization_expires_at: row.authorization_expires_at,
    last_run: row.last_run === null ? null : parseRun(row.last_run),
    ...(recentRuns ? { recent_runs: recentRuns } : {}),
  };
}

async function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let listener: () => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => {
    listener = () => reject(new Error("SCHEDULE_RESPONSE_UNCONFIRMED"));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/** Direct admitted pod only. No hub task contents, local timer, or Shared fallback. */
export class PodScheduledTasksClient {
  private reviewedPodId: string | null = null;

  constructor(private readonly ownerId: string) {}

  private async request(
    path: "tasks" | "tasks/control",
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!areScheduledTasksAvailable()) throw new Error("SCHEDULE_UNAVAILABLE");
    const request = new AbortController();
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const current = () =>
      owner?.userId === this.ownerId && isValidatedAuthSessionOwnerCurrent(owner) &&
      isVaultSessionEpochCurrent(epoch) &&
      !request.signal.aborted;
    if (!current()) throw new Error("SCHEDULE_OWNER_CHANGED");
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 45_000);
    try {
      const admission = await untilAborted(
        ApiService.getComputerUseAdmission(request.signal),
        request.signal,
      );
      if (!current() || !admission || admission.ownerId !== this.ownerId)
        throw new Error("SCHEDULE_OWNER_POD_REQUIRED");
      if (this.reviewedPodId !== null && admission.podId !== this.reviewedPodId)
        throw new Error("SCHEDULE_OWNER_POD_CHANGED");
      this.reviewedPodId = admission.podId;
      const response = await untilAborted(
        ApiService.ownerPodRequest(
          path,
          { ...init, signal: request.signal, cache: "no-store" },
          false,
          undefined,
          admission.podId,
          current,
        ),
        request.signal,
      );
      const body = (await untilAborted(
        readComputerUseJson(response),
        request.signal,
      )) as {
        detail?: { code?: unknown };
      };
      if (!current() || request.signal.aborted)
        throw new Error("SCHEDULE_RESPONSE_REFUSED");
      if (!response.ok)
        throw new Error(
          typeof body?.detail?.code === "string"
            ? body.detail.code
            : "SCHEDULE_REQUEST_FAILED",
        );
      return body;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async status(signal?: AbortSignal): Promise<ScheduledTasksStatus> {
    const body = (await this.request(
      "tasks",
      { method: "GET" },
      signal,
    )) as ScheduledTasksStatus;
    if (
      !body ||
      !Array.isArray(body.tasks) ||
      body.tasks.length > 50 ||
      typeof body.available !== "boolean" ||
      (body.authorization_limit_at !== null &&
        (!Number.isSafeInteger(body.authorization_limit_at) ||
          body.authorization_limit_at < 1))
    )
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    const tasks = body.tasks.map(parseTask);
    if (
      new Set(tasks.map((row) => row.id)).size !== tasks.length ||
      !Array.isArray(body.templates) ||
      body.templates.some((value) => !isScheduledCapability(value)) ||
      (body.run_now_available !== undefined && typeof body.run_now_available !== "boolean") ||
      (body.repeat_modes !== undefined && (!Array.isArray(body.repeat_modes) ||
        body.repeat_modes.length > SCHEDULE_REPEATS.length ||
        body.repeat_modes.some(mode => !SCHEDULE_REPEATS.includes(mode)))) ||
      (body.code !== null &&
        (typeof body.code !== "string" || !/^[A-Z_]{1,128}$/.test(body.code)))
    )
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return {
      available: body.available,
      code: body.code,
      templates: body.templates,
      ...(body.repeat_modes !== undefined ? { repeat_modes: body.repeat_modes } : {}),
      ...(body.run_now_available !== undefined ? { run_now_available: body.run_now_available } : {}),
      tasks,
      authorization_limit_at: body.authorization_limit_at,
    };
  }

  async control(
    task: ScheduledTask,
    operation: ScheduleControl,
    signal?: AbortSignal,
  ): Promise<ScheduledTask> {
    const updated = parseTask(
      await this.request(
        "tasks/control",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schedule_id: task.id,
            revision: task.revision,
            operation,
            confirmed: operation === "resume" || operation === "skip_next" || operation === "run_now",
          }),
        },
        signal,
      ),
    );
    if (
      updated.id !== task.id ||
      updated.capability !== task.capability ||
      updated.revision <= task.revision
    )
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return updated;
  }

  async organizeFile(
    file: ScheduleFileSelection,
    runAt: number,
    requestId: string,
    signal?: AbortSignal,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    recurrence?: ScheduleRecurrence,
  ): Promise<ScheduledTask> {
    const task = parseTask(
      await this.request(
        "tasks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: requestId,
            title: `Organize ${file.name}`.slice(0, 80),
            capability: FILE_ORGANIZATION_TEMPLATE,
            parameters: { file_id: file.id, ...(file.revision !== undefined ? {
              expected_file_revision: file.revision, expected_analysis_revision: file.analysisRevision,
            } : {}) },
            first_run_at: runAt,
            repeat: recurrence?.repeat ?? "once",
            ...(recurrence?.weekdays ? { weekdays: recurrence.weekdays } : {}),
            timezone,
            authorization_expires_at: recurrence?.endsAt ?? runAt + 86_400,
            confirmed: true,
          }),
        },
        signal,
      ),
    );
    if (task.capability !== FILE_ORGANIZATION_TEMPLATE)
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return task;
  }
}
