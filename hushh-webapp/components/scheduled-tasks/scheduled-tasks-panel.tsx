"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  areScheduledTasksAvailable,
  FILE_ORGANIZATION_TEMPLATE,
  MAIL_FOLLOWUP_TEMPLATE,
  ONE_TASK_TEMPLATE,
  PodScheduledTasksClient,
  SCHEDULE_WEEKDAYS,
  type ScheduleControl,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTasksStatus,
} from "@/lib/services/pod-scheduled-tasks";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { snapshotValidatedAuthSessionOwner, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { isFirebaseSessionOwnerCurrent } from "@/lib/auth/firebase-session-owner";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { MediumRowLabel, SectionLabel } from "@/components/app-ui/typography";
import { CalendarClock, ChevronRight, RefreshCw } from "@/components/icons";
import { resolveAppEnvironment } from "@/lib/app-env";
import { ScheduleAgentRunDialog } from "./schedule-agent-run-dialog";

export const scheduledTaskLabels: Record<ScheduledTask["state"], string> = {
  pending_delivery: "Scheduling",
  scheduled: "Scheduled",
  running: "Working",
  cancelling: "Stopping current work",
  paused: "Paused",
  cancelled: "Cancelled",
  completed: "Complete",
  needs_review: "Needs review",
};

const runLabels: Record<string, string> = {
  running: "Running", completed: "Completed", failed: "Failed", needs_review: "Needs review",
  cancelled: "Cancelled", outcome_uncertain: "Outcome uncertain",
};

const repeatLabels: Record<ScheduledTask["repeat"], string> = {
  once: "Once", daily: "Daily", weekly: "Weekly", monthly: "Monthly",
};

const controlLabels: Record<ScheduleControl, { pending: string; success: string }> = {
  pause: { pending: "Pausing task…", success: "Task paused" },
  resume: { pending: "Scheduling task…", success: "Task scheduled" },
  cancel: { pending: "Cancelling task…", success: "Task cancelled" },
  skip_next: { pending: "Skipping next run…", success: "Next run skipped" },
  run_now: { pending: "Requesting a run…", success: "Run requested" },
};

function runSummary(run: ScheduledRun): string {
  const when = new Date((run.finished_at ?? run.started_at) * 1000).toLocaleString();
  return `${runLabels[run.state] ?? "Unavailable"} · ${when}`;
}

export function scheduledRunSummary(task: ScheduledTask): string {
  const run = task.last_run;
  if (!run) return "No run recorded yet";
  return `Latest run: ${runSummary(run)}`;
}

export function preferredScheduledTasks(tasks: ScheduledTask[], selectedId?: string | null) {
  const selected = selectedId ? tasks.find(task => task.id === selectedId) : undefined;
  return selected ? [selected, ...tasks.filter(task => task.id !== selected.id)] : tasks;
}

/** Owner opens this view explicitly. No polling keeps a sleeping pod awake. */
export function ScheduledTasksPanel({ ownerId }: { ownerId: string }) {
  if (!areScheduledTasksAvailable()) return null;
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return <OwnerScheduledTasksPanel key={`${ownerId}:${generation}`} ownerId={ownerId} />;
}

export function useScheduledTasksModel(ownerId: string, route: string = ROUTES.ONE_HOME, inline = false) {
  const [open, setOpen] = useState(false);
  const visible = open || inline;
  const [review, setReview] = useState<{
    client: PodScheduledTasksClient;
    status: ScheduledTasksStatus;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState("");
  const [placementMessage, setPlacementMessage] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const active = useRef(false);
  const work = useRef<AbortController | null>(null);
  const close = () => {
    if (!busy) setOpen(false);
    return true;
  };
  useBackLayer(route, open ? 2 : 0, close);
  useEffect(() => {
    if (!areScheduledTasksAvailable() || !visible) return;
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (owner?.userId !== ownerId) return;
    const client = new PodScheduledTasksClient(ownerId);
    const request = new AbortController();
    work.current = request;
    setReview(null);
    setChecking(true);
    setMessage("");
    setPlacementMessage("");
    const current = () => !request.signal.aborted && isFirebaseSessionOwnerCurrent(owner);
    void ApiService.getPersonalAgentStatus({ signal: request.signal })
      .then(async (hosting) => {
        if (!current()) return null;
        if (hosting.hostingMode !== "byoc" && hosting.hostingMode !== "hussh_pods") {
          setPlacementMessage(hosting.hostingMode === "shared"
            ? "Scheduling requires a private agent."
            : "Finish setting up Agent One to schedule work.");
          return null;
        }
        return client.status(request.signal);
      })
      .then((value) => {
        if (current() && value) setReview({ client, status: value });
      })
      .catch(() => {
        if (current()) {
          setMessage(
            "Connect and unlock your cloud agent to view scheduled tasks.",
          );
        }
      })
      .finally(() => {
        if (current()) setChecking(false);
      });
    return () => {
      request.abort();
      work.current = null;
    };
  }, [visible, ownerId, readRevision]);

  const control = async (
    task: ScheduledTask,
    operation: ScheduleControl,
  ) => {
    const client = review?.client;
    const signal = work.current?.signal;
    if (!client || !signal || active.current) return;
    const owner = snapshotValidatedAuthSessionPrincipal();
    const current = () =>
      !signal.aborted &&
      owner?.userId === ownerId && isFirebaseSessionOwnerCurrent(owner);
    if (!current()) return;
    active.current = true;
    setBusy(task.id);
    let settledState: ScheduledTask["state"] | null = null;
    const request = client.control(task, operation, signal).then((updated) => {
      settledState = updated.state;
      return updated;
    });
    const notification = morphyToast.promise(request, {
      loading: controlLabels[operation].pending,
      get success() {
        return settledState === "cancelling"
          ? "Stopping current work"
          : controlLabels[operation].success;
      },
      error: "Could not confirm the change. Refresh scheduled runs to check.",
      isCurrent: current,
    });
    const retire = () => {
      if (typeof notification === "string" || typeof notification === "number")
        morphyToast.dismiss(notification);
    };
    signal.addEventListener("abort", retire, { once: true });
    try {
      const updated = await request;
      if (!current()) return;
      setReview(
        (previous) =>
          previous?.client === client ? {
            ...previous,
            status: {
              ...previous.status,
              tasks: previous.status.tasks.map((item) =>
                item.id === updated.id ? { ...item, ...updated } : item,
              ),
            },
          } : previous,
      );
    } catch {
      // The promise toast owns transient action feedback; retain the last observation.
    } finally {
      signal.removeEventListener("abort", retire);
      active.current = false;
      setBusy("");
    }
  };

  const changeOpen = (value: boolean) => { if (!busy && (!value || areScheduledTasksAvailable())) setOpen(value); };
  const refresh = () => {
    if (active.current || checking || !visible) return;
    work.current?.abort();
    setReview(null);
    setReadRevision(value => value + 1);
  };
  return { open, changeOpen, close, client: review?.client, status: review?.status ?? null, message, checking, busy, placementMessage, control, refresh };
}

function OwnerScheduledTasksPanel({ ownerId }: { ownerId: string }) {
  return <ScheduledTasksPanelBody model={useScheduledTasksModel(ownerId)} />;
}

function scheduledStateLabel(task: ScheduledTask) {
  return task.run_now_pending ? "Run requested" : scheduledTaskLabels[task.state];
}

export function ScheduledRunInformation({ task }: { task: ScheduledTask }) {
  const earlierRuns = task.recent_runs?.filter(run => run.id !== task.last_run?.id);
  const repeat = task.weekdays?.map(day => SCHEDULE_WEEKDAYS[day]).join(", ") ?? repeatLabels[task.repeat];
  return (
    <div className="space-y-1">
      <p role="status">{scheduledStateLabel(task)}</p>
      {task.state === "scheduled" && (
        <p>Next run: {new Date(task.next_run_at * 1000).toLocaleString()}</p>
      )}
      <p>{repeat}</p>
      <p>{scheduledRunSummary(task)}</p>
      {task.last_run?.state === "outcome_uncertain" && <p>Check the result before scheduling again.</p>}
      {earlierRuns?.length ? (
        <details>
          <summary className="min-h-8 w-fit cursor-pointer content-center">Run history</summary>
          <ul className="space-y-1 ps-3">
            {earlierRuns.map(run => <li key={run.id}>{runSummary(run)}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function ScheduledRunActions({ task, model }: {
  task: ScheduledTask;
  model: ReturnType<typeof useScheduledTasksModel>;
}) {
  const { busy, checking, control, status } = model;
  const disabled = checking || Boolean(busy);
  const scheduled = task.state === "scheduled" && !task.run_now_pending;
  return (
    <div className="flex max-w-full flex-wrap items-center gap-1 empty:hidden">
      {["scheduled", "pending_delivery"].includes(task.state) && (
        <Button variant="ghost" size="compact" disabled={disabled} onClick={() => void control(task, "pause")}>Pause</Button>
      )}
      {task.state === "paused" && (
        <Button variant="ghost" size="compact" disabled={disabled || !status?.available} onClick={() => void control(task, "resume")}>Resume</Button>
      )}
      {scheduled && status?.run_now_available && task.capability !== MAIL_FOLLOWUP_TEMPLATE && (
        <Button variant="ghost" size="compact" disabled={disabled || task.next_run_at < Date.now() / 1000 + 60} onClick={() => void control(task, "run_now")}>Run now</Button>
      )}
      {scheduled && task.repeat !== "once" && status?.repeat_modes?.includes("monthly") && (
        <Button variant="ghost" size="compact" disabled={disabled || !status?.available} onClick={() => void control(task, "skip_next")}>Skip next run</Button>
      )}
      {!["cancelled", "completed", "cancelling"].includes(task.state) && (
        <Button variant="ghost" size="compact" disabled={disabled} onClick={() => void control(task, "cancel")}>Cancel</Button>
      )}
    </div>
  );
}

export function ScheduledTasksPanelBody({ model, selectedId, inTasks = false, inline = false, onOpen }: {
  model: ReturnType<typeof useScheduledTasksModel>;
  selectedId?: string | null;
  inTasks?: boolean;
  inline?: boolean;
  onOpen?: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  if (!areScheduledTasksAvailable()) return null;
  const { open, changeOpen, close, client, status, message, checking, busy, placementMessage, refresh } = model;
  const title = inTasks ? "Scheduled runs" : "Scheduled tasks";
  const ordered = [...(status?.tasks ?? [])].sort((a, b) => a.next_run_at - b.next_run_at);
  const tasks = preferredScheduledTasks(ordered, selectedId);
  const canScheduleFile = inline && status?.available && status.templates.includes(FILE_ORGANIZATION_TEMPLATE);
  const canScheduleAgent = inline && resolveAppEnvironment() === "development" &&
    status?.available && status.templates.includes(ONE_TASK_TEMPLATE);

  const actions = (
    <div className="flex flex-wrap items-center gap-1">
      {canScheduleAgent && (
        <Button size="compact" disabled={checking || Boolean(busy) || !client} onClick={() => setCreating(true)}>
          Schedule a run
        </Button>
      )}
      <Button
        variant={inline ? "plain" : "outline"}
        size={inline ? "icon" : "default"}
        aria-label={inline ? "Refresh scheduled runs" : undefined}
        title={inline ? "Refresh scheduled runs" : undefined}
        disabled={checking || Boolean(busy)}
        onClick={refresh}
      >
        {inline ? <RefreshCw className="size-4" aria-hidden="true" /> : "Refresh"}
      </Button>
      <Button variant={inline ? "plain" : "outline"} size={inline ? "compact" : "default"} asChild>
        <Link
          href={placementMessage ? ROUTES.PROFILE_HOSTING : ROUTES.ONE_FILES}
          onClick={close}
          aria-disabled={Boolean(busy)}
          onClickCapture={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          {placementMessage ? "Hosting" : canScheduleFile ? "Schedule in Files" : "Open Files"}
        </Link>
      </Button>
    </div>
  );

  const rows = tasks.length > 0 && (
    <ul className="divide-y divide-border/60" aria-busy={checking}>
      {tasks.map(task => (
        <li key={task.id}>
          {onOpen ? (
            <button
              type="button"
              className="grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-2.5 text-left"
              onClick={() => onOpen(task.id)}
            >
              <span className="min-w-0">
                <MediumRowLabel as="span" className="block break-words [overflow-wrap:anywhere]">{task.title}</MediumRowLabel>
                <span className="block text-xs text-muted-foreground">Scheduled run · {scheduledStateLabel(task)}</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </button>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1 basis-48">
                <MediumRowLabel as="h3" className="break-words [overflow-wrap:anywhere]">{task.title}</MediumRowLabel>
                <div className="text-xs text-muted-foreground"><ScheduledRunInformation task={task} /></div>
              </div>
              <ScheduledRunActions task={task} model={model} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  const content = (
    <>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      {placementMessage && <p role="status" className="text-sm text-muted-foreground">{placementMessage}</p>}
      {checking && !status && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your agent…
        </p>
      )}
      {status && !status.available && (
        <p className="text-sm text-muted-foreground">
          Scheduling isn’t available on this pod yet.
        </p>
      )}
      {status?.available && status.tasks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {inTasks ? "No scheduled runs yet." : "No scheduled tasks. Choose a file in Files to schedule organization."}
        </p>
      )}
      {selectedId && status && !status.tasks.some(task => task.id === selectedId) ? (
        <p role="status" className="text-sm text-muted-foreground">This schedule wasn’t found on your current Pod.</p>
      ) : null}
      {inline && rows ? <SurfaceInset className="p-0">{rows}</SurfaceInset> : rows}
    </>
  );
  if (inline) {
    return (
      <section aria-labelledby="scheduled-runs-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <SectionLabel as="h2" id="scheduled-runs-heading" compact>{title}</SectionLabel>
          {actions}
        </div>
        {content}
        {creating && canScheduleAgent && client && status && (
          <ScheduleAgentRunDialog
            client={client}
            status={status}
            onClose={() => setCreating(false)}
            onSaved={task => {
              setCreating(false);
              refresh();
              onOpen?.(task.id);
            }}
          />
        )}
      </section>
    );
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <ShellActionSurface
          variant="pill"
          aria-label={title}
          title={title}
          className="h-11 w-11 shrink-0 p-0 min-[520px]:w-auto min-[520px]:px-3.5"
          data-voice-control-id={inTasks ? undefined : "one_scheduled_tasks"}
        >
          <CalendarClock className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="hidden min-[520px]:inline">{title}</span>
        </ShellActionSurface>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Your private agent runs approved work. Results appear here when recorded.
          </DialogDescription>
        </DialogHeader>
        {content}
        {actions}
      </DialogContent>
    </Dialog>
  );
}
