import { resolveAppEnvironment } from "@/lib/app-env";
import { ApiService } from "./api-service";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ROUTES } from "@/lib/navigation/routes";
import { readComputerUseJson } from "@/lib/computer-use/direct-transport";
import { parseMcpCallPreview, parseMcpCallReviewReference, type McpCallApproval, type McpCallPreview } from "@/lib/agent/mcp-call-review";
import { observeServerDate } from "@/lib/agent/server-clock";

import type { FollowupMailbox, MailFollowup } from "@/lib/mail/mail-followup-model";

export const MAIL_FOLLOWUP_TEMPLATE = "agent_email.send_followup.v1";
export const FILE_ORGANIZATION_TEMPLATE = "agent_files.organize_file.v1";
export const ONE_TASK_TEMPLATE = "agent_one.execute_task.v1";

function isScheduledCapability(value: unknown): boolean {
  return value === FILE_ORGANIZATION_TEMPLATE || value === ONE_TASK_TEMPLATE || value === MAIL_FOLLOWUP_TEMPLATE;
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
  return resolveAppEnvironment() !== "production";
}

const SCHEDULE_REPEATS = ["once", "daily", "weekly", "monthly"] as const;
export const SCHEDULE_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];
export type ScheduleRecurrence = {
  repeat: Exclude<ScheduleRepeat, "once">;
  weekdays?: number[];
  endsAt: number;
};
export type ScheduledRun = { id?: string; state: string; started_at: number; finished_at?: number };
export type ScheduledRunResult = { outcome: "completed" | "blocked"; summary: string };
export type ScheduledApprovalReview = {
  scheduleId: string;
  occurrenceId: string;
  revision: number;
  confirmationId: string;
  preview: McpCallPreview;
};
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
  review_available?: boolean;
  authorization_expires_at: number;
  last_run: (ScheduledRun & { sent_source?: string }) | null;
  recent_runs?: RecentScheduledRun[];
};
export type ScheduledTasksStatus = {
  available: boolean;
  code: string | null;
  templates: string[];
  repeat_modes?: ScheduleRepeat[];
  run_now_available?: boolean;
  files_via_schedule?: boolean;
  tasks: ScheduledTask[];
  authorization_limit_at: number | null;
};

function parseRun(value: unknown): ScheduledRun {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCHEDULE_RESPONSE_REFUSED");
  const run = value as ScheduledRun;
  if (
    (run.id !== undefined && (typeof run.id !== "string" || !/^[a-f0-9]{32}$/.test(run.id))) ||
    !["running", "completed", "failed", "needs_review", "cancelled", "outcome_uncertain"].includes(run.state) ||
    !Number.isSafeInteger(run.started_at) || run.started_at < 1 ||
    (run.finished_at != null && (!Number.isSafeInteger(run.finished_at) || run.finished_at < 1))
  ) throw new Error("SCHEDULE_RESPONSE_REFUSED");
  return {
    ...(run.id ? { id: run.id } : {}),
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
    (row.review_available !== undefined && typeof row.review_available !== "boolean") ||
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
    ...(row.review_available === true ? { review_available: true } : {}),
    authorization_expires_at: row.authorization_expires_at,
    last_run: row.last_run === null ? null : {
      ...parseRun(row.last_run),
      ...(row.capability === MAIL_FOLLOWUP_TEMPLATE && row.state === "completed" &&
          row.last_run.state === "completed" && typeof row.last_run.sent_source === "string" &&
          /^ms1\.[A-Za-z0-9_-]{16,2044}$/.test(row.last_run.sent_source)
        ? { sent_source: row.last_run.sent_source } : {}),
    },
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
    path: "tasks" | "tasks/control" | "tasks/review" | "tasks/continue" | `tasks?${string}`,
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
      if (path === "tasks/review") observeServerDate(response.headers.get("date"));
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
      (body.files_via_schedule !== undefined && typeof body.files_via_schedule !== "boolean") ||
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
      ...(body.files_via_schedule !== undefined ? { files_via_schedule: body.files_via_schedule } : {}),
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

  async sendMailFollowup(box: FollowupMailbox, item: MailFollowup, draft: NonNullable<MailFollowup["draft"]>,
    due: number, signal: AbortSignal): Promise<ScheduledTask> {
    if (box.account !== item.account || box.connection !== item.connection) throw new Error("Mailbox changed.");
    const task = parseTask(await this.request("tasks", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({request_id:item.key, title:"Approved Mail follow-up", capability:MAIL_FOLLOWUP_TEMPLATE,
        parameters:{account:box.account,connection:box.connection,address:box.address,source:item.source,quote:item.quote,
          fulfilment:item.fulfilment,debtor:item.debtor,document:item.document,draft,due},
        first_run_at:due,repeat:"once",timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
        authorization_expires_at:due+300,confirmed:true})},signal));
    if (task.capability !== MAIL_FOLLOWUP_TEMPLATE) throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return task;
  }

  async scheduleOne(
    terms: {
      title: string; goal: string; runAt: number; expiresAt: number; requestId: string; timezone: string;
      recurrence?: Omit<ScheduleRecurrence, "endsAt">;
    },
    signal: AbortSignal,
  ): Promise<ScheduledTask> {
    const task = parseTask(await this.request("tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: terms.requestId,
        title: terms.title,
        capability: ONE_TASK_TEMPLATE,
        parameters: { goal: terms.goal },
        first_run_at: terms.runAt,
        repeat: terms.recurrence?.repeat ?? "once",
        ...(terms.recurrence?.weekdays ? { weekdays: terms.recurrence.weekdays } : {}),
        timezone: terms.timezone,
        authorization_expires_at: terms.expiresAt,
        confirmed: true,
      }),
    }, signal));
    if (task.capability !== ONE_TASK_TEMPLATE) throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return task;
  }

  async readRunResult(task: ScheduledTask, signal: AbortSignal, occurrenceId = task.last_run?.id): Promise<ScheduledRunResult> {
    const run = occurrenceId === task.last_run?.id ? task.last_run :
      task.recent_runs?.find(entry => entry.id === occurrenceId);
    if (task.capability !== ONE_TASK_TEMPLATE || !isScheduledTaskId(task.id) ||
        !occurrenceId || !/^[a-f0-9]{32}$/.test(occurrenceId) ||
        !run || (run.state !== "completed" && run.state !== "failed")) {
      throw new Error("SCHEDULE_RESULT_UNAVAILABLE");
    }
    const query = new URLSearchParams({ result_for: task.id, occurrence_id: occurrenceId });
    const body = await this.request(`tasks?${query}`, { method: "GET" }, signal) as { result?: ScheduledRunResult };
    const result = body?.result;
    if (!result || !["completed", "blocked"].includes(result.outcome) ||
        typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 2000) {
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    }
    return { outcome: result.outcome, summary: result.summary };
  }

  async reviewParkedRun(task: ScheduledTask, signal: AbortSignal): Promise<ScheduledApprovalReview> {
    const occurrenceId = task.last_run?.id;
    if (resolveAppEnvironment() !== "development" || task.capability !== ONE_TASK_TEMPLATE ||
        task.state !== "needs_review" || task.last_run?.state !== "needs_review" ||
        !task.review_available || !isScheduledTaskId(task.id) ||
        !occurrenceId || !/^[a-f0-9]{32}$/.test(occurrenceId)) {
      throw new Error("SCHEDULE_REVIEW_UNAVAILABLE");
    }
    const body = await this.request("tasks/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule_id: task.id, revision: task.revision, occurrence_id: occurrenceId }),
    }, signal) as { review?: Record<string, unknown>; revision?: number; confirmation_id?: string } | null;
    const reference = parseMcpCallReviewReference({ ...body?.review, kind: "mcp_call_review", version: 1 });
    const preview = reference && parseMcpCallPreview(body?.review, reference);
    if (!body || typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) ||
        body.revision < task.revision || typeof body.confirmation_id !== "string" ||
        !body.confirmation_id || body.confirmation_id.length > 256 || !preview?.podReview ||
        preview.podReview.ownerId !== this.ownerId || preview.podReview.hushhId !== this.reviewedPodId ||
        preview.podReview.conversationId !== `scheduled_${occurrenceId}`) {
      throw new Error("SCHEDULE_RESPONSE_REFUSED");
    }
    return { scheduleId: task.id, occurrenceId, revision: body.revision, confirmationId: body.confirmation_id, preview };
  }

  async continueParkedRun(review: ScheduledApprovalReview, approval: McpCallApproval, signal: AbortSignal): Promise<ScheduledTask> {
    const { preview } = review;
    if (resolveAppEnvironment() !== "development" || approval.directiveId !== preview.directiveId ||
        approval.pendingHandle !== preview.pendingHandle || approval.connectorId !== preview.connectorId ||
        approval.toolName !== preview.toolName || !/^[A-Za-z0-9_-]{32,128}$/.test(approval.receipt)) {
      throw new Error("SCHEDULE_REVIEW_UNAVAILABLE");
    }
    const task = parseTask(await this.request("tasks/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedule_id: review.scheduleId, revision: review.revision, occurrence_id: review.occurrenceId,
        pending_handle: approval.pendingHandle, confirmation_id: review.confirmationId,
        approval: {
          directiveId: approval.directiveId, pendingHandle: approval.pendingHandle,
          connectorId: approval.connectorId, toolName: approval.toolName, receipt: approval.receipt,
        },
      }),
    }, signal));
    if (task.id !== review.scheduleId || task.capability !== ONE_TASK_TEMPLATE ||
        task.revision <= review.revision) throw new Error("SCHEDULE_RESPONSE_REFUSED");
    return task;
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
