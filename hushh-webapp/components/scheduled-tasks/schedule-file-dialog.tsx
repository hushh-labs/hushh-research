"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  PodScheduledTasksClient,
  scheduledTaskHref,
  type ScheduleFileSelection,
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<ScheduledTasksStatus | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const ownerId = snapshotValidatedAuthSessionOwner()?.userId;
  const client = useMemo(() => reviewedClient ?? (ownerId ? new PodScheduledTasksClient(ownerId) : null), [ownerId, reviewedClient]);
  const pending = useRef(false);
  const approved = useRef<{ runAt: number; requestId: string; timezone: string } | null>(null);
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
    const runAt = approved.current?.runAt ?? Math.floor(new Date(when).getTime() / 1000);
    const timezone = approved.current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (pending.current) return;
    if (!owner || !client) {
      setMessage("Unlock your private agent first.");
      return;
    }
    if (!Number.isFinite(runAt) || (!unconfirmed && runAt <= Date.now() / 1000 + 60)) {
      setMessage("Choose a time at least one minute from now.");
      return;
    }
    if (
      !available ||
      !status.authorization_limit_at ||
      runAt + 86_400 > status.authorization_limit_at
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
      const terms = approved.current ?? { runAt, requestId: crypto.randomUUID(), timezone };
      approved.current = terms;
      attempted = true;
      const task = await client.organizeFile(file, terms.runAt, terms.requestId, request.signal, terms.timezone);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule organization</DialogTitle>
          <DialogDescription className="break-words">
            Run on your private Pod. Organize {file.name} once, using your current analysis permission.
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
        <p className="text-xs text-muted-foreground">
          {available && status.authorization_limit_at
            ? `Time zone: ${approved.current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}. Approved access ends ${new Date(status.authorization_limit_at * 1000).toLocaleString()}. This task expires 24 hours after its scheduled time.`
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
            disabled={busy || !when || !available}
            onClick={() => void schedule()}
          >
            {busy ? "Scheduling…" : unconfirmed ? "Retry same request" : "Confirm schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
