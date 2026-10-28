"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  PodScheduledTasksClient,
  type ScheduledTask,
  type ScheduledTasksStatus,
} from "@/lib/services/pod-scheduled-tasks";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { firebaseUidForOwner, snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { CalendarClock } from "@/components/icons";

const labels: Record<ScheduledTask["state"], string> = {
  pending_delivery: "Scheduling",
  scheduled: "Scheduled",
  running: "Working",
  cancelling: "Stopping current work",
  paused: "Paused",
  cancelled: "Cancelled",
  completed: "Complete",
  needs_review: "Needs review",
};

/** Owner opens this view explicitly. No polling keeps a sleeping pod awake. */
export function ScheduledTasksPanel({ ownerId }: { ownerId: string }) {
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return <OwnerScheduledTasksPanel key={`${ownerId}:${generation}`} ownerId={ownerId} />;
}

function OwnerScheduledTasksPanel({ ownerId }: { ownerId: string }) {
  const client = useMemo(() => new PodScheduledTasksClient(ownerId), [ownerId]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ScheduledTasksStatus | null>(null);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState("");
  const [placementMessage, setPlacementMessage] = useState("");
  const active = useRef(false);
  const work = useRef<AbortController | null>(null);
  const close = () => {
    if (!busy) setOpen(false);
    return true;
  };
  useBackLayer(ROUTES.ONE_HOME, open ? 2 : 0, close);
  useEffect(() => {
    if (!open) return;
    const owner = snapshotValidatedAuthSessionOwner();
    if (owner?.userId !== ownerId) return;
    const request = new AbortController();
    work.current = request;
    setChecking(true);
    setMessage("");
    setPlacementMessage("");
    const current = () => !request.signal.aborted && AuthService.getCurrentUser()?.uid === firebaseUidForOwner(ownerId) &&
      isValidatedAuthSessionOwnerCurrent(owner);
    void ApiService.getPersonalAgentStatus({ signal: request.signal })
      .then(async (hosting) => {
        if (!current()) return null;
        if (hosting.hostingMode !== "byoc" && hosting.hostingMode !== "hussh_pods") {
          setStatus(null);
          setPlacementMessage(hosting.hostingMode === "shared"
            ? "Scheduled tasks need a private agent."
            : "Finish setting up your private agent to schedule work.");
          return null;
        }
        return client.status(request.signal);
      })
      .then((value) => {
        if (current() && value) setStatus(value);
      })
      .catch(() => {
        if (current()) {
          setStatus(null);
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
  }, [client, open, ownerId]);

  const control = async (
    task: ScheduledTask,
    operation: "pause" | "resume" | "cancel",
  ) => {
    if (active.current) return;
    active.current = true;
    setBusy(task.id);
    const signal = work.current?.signal;
    const owner = snapshotValidatedAuthSessionOwner();
    const current = () =>
      Boolean(signal && !signal.aborted) &&
      owner?.userId === ownerId && isValidatedAuthSessionOwnerCurrent(owner) &&
      AuthService.getCurrentUser()?.uid === firebaseUidForOwner(ownerId);
    if (!current()) { active.current = false; setBusy(""); return; }
    let settledState: ScheduledTask["state"] | null = null;
    const request = client.control(task, operation, signal).then((updated) => {
      settledState = updated.state;
      return updated;
    });
    const notification = morphyToast.promise(request, {
      loading:
        operation === "pause"
          ? "Pausing task…"
          : operation === "resume"
            ? "Scheduling task…"
            : "Cancelling task…",
      get success() {
        return settledState === "cancelling"
          ? "Stopping current work"
          : operation === "pause"
            ? "Task paused"
            : operation === "resume"
              ? "Task scheduled"
              : "Task cancelled";
      },
      error: "Could not confirm the change. Reopen Scheduled tasks to check.",
      isCurrent: current,
    });
    const retire = () => {
      if (typeof notification === "string" || typeof notification === "number")
        morphyToast.dismiss(notification);
    };
    signal?.addEventListener("abort", retire, { once: true });
    try {
      const updated = await request;
      if (!current()) return;
      setStatus(
        (previous) =>
          previous && {
            ...previous,
            tasks: previous.tasks.map((item) =>
              item.id === updated.id ? updated : item,
            ),
          },
      );
    } catch {
      // The promise toast owns transient action feedback; retain the last observation.
    } finally {
      signal?.removeEventListener("abort", retire);
      active.current = false;
      setBusy("");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <ShellActionSurface
          variant="pill"
          aria-label="Scheduled tasks"
          title="Scheduled tasks"
          className="h-11 w-11 shrink-0 p-0 min-[520px]:w-auto min-[520px]:px-3.5"
          data-voice-control-id="one_scheduled_tasks"
        >
          <CalendarClock className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="hidden min-[520px]:inline">Scheduled tasks</span>
        </ShellActionSurface>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Scheduled tasks</DialogTitle>
          <DialogDescription>
            Your private agent wakes for approved work.
          </DialogDescription>
        </DialogHeader>
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
        {status?.tasks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No scheduled tasks. Choose a file in Files to schedule organization.
          </p>
        )}
        <ul className="divide-y divide-border" aria-busy={checking}>
          {status?.tasks.map((task) => (
            <li
              key={task.id}
              className="flex min-w-0 flex-wrap items-center gap-3 py-3"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words text-sm font-medium">{task.title}</p>
                <p className="text-xs text-muted-foreground">
                  {labels[task.state]} ·{" "}
                  {new Date(task.next_run_at * 1000).toLocaleString()}
                </p>
                {task.last_run?.state === "outcome_uncertain" && (
                  <p className="text-xs text-muted-foreground">
                    Check the result before scheduling again.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {["scheduled", "pending_delivery"].includes(task.state) && (
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={checking || Boolean(busy)}
                    onClick={() => void control(task, "pause")}
                  >
                    Pause
                  </Button>
                )}
                {task.state === "paused" && (
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={checking || Boolean(busy) || !status?.available}
                    onClick={() => void control(task, "resume")}
                  >
                    Resume
                  </Button>
                )}
                {!["cancelled", "completed", "cancelling"].includes(
                  task.state,
                ) && (
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={checking || Boolean(busy)}
                    onClick={() => void control(task, "cancel")}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" asChild>
          <Link
            href={placementMessage ? ROUTES.PROFILE_HOSTING : ROUTES.ONE_FILES}
            onClick={close}
            aria-disabled={Boolean(busy)}
            onClickCapture={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            {placementMessage ? "Hosting" : "Open Files"}
          </Link>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
