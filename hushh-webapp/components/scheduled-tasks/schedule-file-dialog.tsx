"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  FILE_ORGANIZATION_TEMPLATE,
  SCHEDULE_WEEKDAYS,
  PodScheduledTasksClient,
  scheduledTaskHref,
  type ScheduleFileSelection,
  type ScheduleRecurrence,
  type ScheduleRepeat,
  type ScheduledTask,
  type ScheduledTasksStatus,
} from "@/lib/services/pod-scheduled-tasks";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export function ScheduleFileDialog({
  file,
  open,
  onOpenChange,
  route = ROUTES.ONE_FILES,
  initialTime = "",
  reviewedClient,
  beforeConfirm,
  onScheduled,
}: {
  file: ScheduleFileSelection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route?: string;
  initialTime?: string;
  reviewedClient?: PodScheduledTasksClient;
  beforeConfirm?: (signal: AbortSignal) => Promise<void>;
  onScheduled?: (task: ScheduledTask) => void;
}) {
  const [when, setWhen] = useState(initialTime);
  const repeatId = useId();
  const [repeat, setRepeat] = useState<ScheduleRepeat | "selected-weekdays">("once");
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4]);
  const [ends, setEnds] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<ScheduledTasksStatus | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const ownerId = snapshotValidatedAuthSessionOwner()?.userId;
  const client = useMemo(() => reviewedClient ?? (ownerId ? new PodScheduledTasksClient(ownerId) : null), [ownerId, reviewedClient]);
  const pending = useRef(false);
  const approved = useRef<{
    runAt: number; requestId: string; timezone: string; recurrence?: ScheduleRecurrence;
  } | null>(null);
  const work = useRef<AbortController | null>(null);
  useEffect(() => () => work.current?.abort(), []);
  useEffect(() => {
    if (!open || !client) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const request = new AbortController();
    const current = () => !request.signal.aborted && owner !== null &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch);
    setStatus(null);
    setMessage("");
    void client
      .status(request.signal)
      .then((value) => {
        if (current()) setStatus(value);
      })
      .catch(() => {
        if (current()) setMessage("Couldn’t verify scheduling. Reopen to try again.");
      });
    return () => request.abort();
  }, [client, open]);
  const close = () => {
    if (!busy) onOpenChange(false);
    return true;
  };
  useBackLayer(route, open ? 3 : 0, close);
  const available = status?.available && status.templates.includes(FILE_ORGANIZATION_TEMPLATE);

  const schedule = async () => {
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const start = new Date(when);
    const runAt = approved.current?.runAt ?? Math.floor(start.getTime() / 1000);
    const timezone = approved.current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const recurrence = approved.current ? approved.current.recurrence : repeat === "once" ? undefined : {
      repeat: repeat === "selected-weekdays" ? "weekly" as const : repeat,
      ...(repeat === "selected-weekdays" ? { weekdays } : {}),
      endsAt: Math.floor(new Date(ends).getTime() / 1000),
    };
    if (pending.current) return;
    if (!owner || !client) {
      setMessage("Unlock your private agent first.");
      return;
    }
    if (!Number.isFinite(runAt) || (!unconfirmed && runAt <= Date.now() / 1000 + 60)) {
      setMessage("Choose a time at least one minute from now.");
      return;
    }
    if (recurrence?.weekdays && !recurrence.weekdays.includes((start.getDay() + 6) % 7)) {
      setMessage("Choose a first run that falls on one of the selected days.");
      return;
    }
    const expiresAt = recurrence?.endsAt ?? runAt + 86_400;
    if (!Number.isFinite(expiresAt) || expiresAt <= runAt) {
      setMessage("Choose an end time after the first run.");
      return;
    }
    if (
      !available ||
      !status.authorization_limit_at ||
      expiresAt > status.authorization_limit_at
    ) {
      setMessage("Choose an earlier time within your approved access, or renew access first.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setMessage("");
    const request = new AbortController();
    work.current = request;
    const current = () =>
      !request.signal.aborted && isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch);
    let attempted = unconfirmed;
    try {
      if (!unconfirmed) await beforeConfirm?.(request.signal);
      if (!current()) return;
      const terms = approved.current ?? { runAt, requestId: crypto.randomUUID(), timezone, recurrence };
      approved.current = terms;
      attempted = true;
      const task = await client.organizeFile(file, terms.runAt, terms.requestId, request.signal, terms.timezone, terms.recurrence);
      if (!current()) return;
      if (!["scheduled", "running", "completed"].includes(task.state)) throw new Error("SCHEDULE_UNCONFIRMED");
      onScheduled?.(task);
      if (!onScheduled) morphyToast.success("Schedule confirmed");
      onOpenChange(false);
    } catch (error) {
      if (current()) {
        const changed = error instanceof Error && error.message === "SCHEDULE_SOURCE_CHANGED";
        if (changed) approved.current = null;
        setUnconfirmed(attempted && !changed);
        setMessage(attempted && !changed
          ? "Scheduling couldn’t be confirmed. Check Tasks first. Retrying this request uses the same file and time."
          : "The selected file or its permission changed. Close this review and select the file again.");
      }
    } finally {
      work.current = null;
      pending.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule organization</DialogTitle>
          <DialogDescription className="break-words">
            Organize {file.name} on your private agent using your current analysis permission.
            {file.revision === undefined
              ? " Changes after scheduling require review."
              : " Changes to the file or permission require review."}
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-[var(--app-form-field-gap)] text-sm">
          Run at
          <Input
            type="datetime-local"
            value={when}
            disabled={busy || unconfirmed || !available}
            onChange={(event) => {
              setWhen(event.target.value);
              setMessage("");
            }}
          />
        </label>
        {available && status.repeat_modes?.includes("monthly") && (
          <div className="space-y-3">
            <div className="flex flex-col gap-[var(--app-form-field-gap)] text-sm">
              <label htmlFor={repeatId}>Repeat</label>
              <Select value={repeat} onValueChange={(value) => {
                setRepeat(value as typeof repeat);
                setMessage("");
              }} disabled={busy || unconfirmed}>
                <SelectTrigger id={repeatId}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">Once</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="selected-weekdays">Selected days</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {repeat === "selected-weekdays" && (
              <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm" disabled={busy || unconfirmed}>
                <legend className="mb-1">Days of the week</legend>
                {SCHEDULE_WEEKDAYS.map((name, day) => (
                  <label key={name} className="flex min-h-8 items-center gap-2">
                    <input type="checkbox" checked={weekdays.includes(day)} onChange={(event) => {
                      setWeekdays(event.target.checked
                        ? [...weekdays, day].sort((a, b) => a - b)
                        : weekdays.filter((selected) => selected !== day));
                      setMessage("");
                    }} />
                    {name}
                  </label>
                ))}
              </fieldset>
            )}
            {repeat !== "once" && (
              <label className="flex flex-col gap-[var(--app-form-field-gap)] text-sm">
                End at
                <Input type="datetime-local" value={ends} min={when} disabled={busy || unconfirmed}
                  onChange={(event) => { setEnds(event.target.value); setMessage(""); }} />
              </label>
            )}
            {repeat === "monthly" && <p className="text-xs text-muted-foreground">Months without the selected date are skipped.</p>}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {available && status.authorization_limit_at
            ? `Time zone: ${approved.current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}. Approved access ends ${new Date(status.authorization_limit_at * 1000).toLocaleString()}.${repeat === "once" ? " This task expires 24 hours after its scheduled time." : " Only upcoming runs are scheduled after a pause."}`
            : status
              ? "Scheduling is not available on this pod yet."
              : "Checking scheduling…"}
        </p>
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
        <DialogFooter>
          {unconfirmed ? <Button variant="outline" asChild><Link href={scheduledTaskHref()}>Check Tasks</Link></Button> : null}
          <Button variant="ghost" disabled={busy} onClick={close}>
            {unconfirmed ? "Close" : "Cancel"}
          </Button>
          <Button
            disabled={busy || !when || !available || (repeat !== "once" && !ends)}
            onClick={() => void schedule()}
          >
            {busy ? "Scheduling…" : unconfirmed ? "Retry same request" : "Confirm schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
