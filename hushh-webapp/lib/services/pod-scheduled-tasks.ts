import { resolveAppEnvironment } from "@/lib/app-env";
import { ApiService } from "./api-service";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ROUTES } from "@/lib/navigation/routes";
import { readComputerUseJson } from "@/lib/computer-use/direct-transport";

export const FILE_ORGANIZATION_TEMPLATE = "agent_files.organize_file.v1";
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
  return resolveAppEnvironment() !== "production";
}

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
  repeat: "once" | "daily" | "weekly";
  timezone: string;
  next_run_at: number;
  authorization_expires_at: number;
  last_run: { state: string; started_at: number; finished_at?: number } | null;
};
export type ScheduledTasksStatus = {
  available: boolean;
  code: string | null;
  templates: string[];
  tasks: ScheduledTask[];
  authorization_limit_at: number | null;
};

function parseTask(value: unknown): ScheduledTask {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  const row = value as ScheduledTask;
  if (
    !isScheduledTaskId(row.id) ||
    typeof row.title !== "string" ||
    !row.title ||
    row.title.length > 80 ||
    row.capability !== FILE_ORGANIZATION_TEMPLATE ||
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
    !["once", "daily", "weekly"].includes(row.repeat) ||
    typeof row.timezone !== "string" ||
    !row.timezone ||
    row.timezone.length > 64 ||
    !Number.isSafeInteger(row.next_run_at) ||
    row.next_run_at < 1 ||
    !Number.isSafeInteger(row.authorization_expires_at) ||
    row.authorization_expires_at < 1 ||
    (row.last_run !== null &&
      (!row.last_run ||
        ![
          "running",
          "completed",
          "failed",
          "needs_review",
          "cancelled",
          "outcome_uncertain",
        ].includes(row.last_run.state) ||
        !Number.isSafeInteger(row.last_run.started_at) ||
        row.last_run.started_at < 1 ||
        (row.last_run.finished_at !== undefined &&
          row.last_run.finished_at !== null &&
          (!Number.isSafeInteger(row.last_run.finished_at) ||
            row.last_run.finished_at < 1))))
  )
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  // Keep only display metadata; private terms/grants are never frontend state.
  return {
    id: row.id,
    title: row.title,
    capability: row.capability,
    revision: row.revision,
    state: row.state,
    repeat: row.repeat,
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    authorization_expires_at: row.authorization_expires_at,
    last_run: row.last_run && {
      state: row.last_run.state,
      started_at: row.last_run.started_at,
      ...(row.last_run.finished_at
        ? { finished_at: row.last_run.finished_at }
        : {}),
    },
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
      body.templates.some(
        (value) => value !== FILE_ORGANIZATION_TEMPLATE,
      ) ||
      (body.code !== null &&
        (typeof body.code !== "string" || !/^[A-Z_]{1,128}$/.test(body.code)))
    )
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return {
      available: body.available,
      code: body.code,
      templates: body.templates,
      tasks,
      authorization_limit_at: body.authorization_limit_at,
    };
  }

  async control(
    task: ScheduledTask,
    operation: "pause" | "resume" | "cancel",
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
            confirmed: operation === "resume",
          }),
        },
        signal,
      ),
    );
    if (updated.id !== task.id || updated.revision <= task.revision)
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return updated;
  }

  async organizeFile(
    file: ScheduleFileSelection,
    runAt: number,
    requestId: string,
    signal?: AbortSignal,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ): Promise<ScheduledTask> {
    return parseTask(
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
            repeat: "once",
            timezone,
            authorization_expires_at: runAt + 86_400,
            confirmed: true,
          }),
        },
        signal,
      ),
    );
  }
}
