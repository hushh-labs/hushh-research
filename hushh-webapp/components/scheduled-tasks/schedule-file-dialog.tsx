"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AuthService } from "@/lib/services/auth-service";
import {
  PodScheduledTasksClient,
  type ScheduledTasksStatus,
} from "@/lib/services/pod-scheduled-tasks";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { morphyToast } from "@/lib/morphy-ux/morphy";

export function ScheduleFileDialog({
  file,
  open,
  onOpenChange,
}: {
  file: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<ScheduledTasksStatus | null>(null);
  const selection = useMemo(
    () => ({ fileId: file.id, fileName: file.name, when, requestId: crypto.randomUUID() }),
    [file.id, file.name, when],
  );
  const pending = useRef(false);
  const work = useRef<AbortController | null>(null);
  useEffect(() => () => work.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    const owner = AuthService.getCurrentUser()?.uid;
    if (!owner) return;
    const request = new AbortController();
    setStatus(null);
    setMessage("");
    void new PodScheduledTasksClient(owner)
      .status(request.signal)
      .then((value) => {
        if (
          !request.signal.aborted &&
          AuthService.getCurrentUser()?.uid === owner
        )
          setStatus(value);
      })
      .catch(() => {
        if (
          !request.signal.aborted &&
          AuthService.getCurrentUser()?.uid === owner
        )
          setMessage("Could not verify scheduling. Reopen to try again.");
      });
    return () => request.abort();
  }, [open]);
  const close = () => {
    if (!busy) onOpenChange(false);
    return true;
  };
  useBackLayer(ROUTES.ONE_FILES, open ? 2 : 0, close);

  const schedule = async () => {
    const owner = AuthService.getCurrentUser()?.uid;
    const runAt = Math.floor(new Date(when).getTime() / 1000);
    if (pending.current) return;
    if (!owner) {
      morphyToast.error("Sign in and unlock your cloud agent first");
      return;
    }
    if (!Number.isFinite(runAt) || runAt <= Date.now() / 1000 + 60) {
      morphyToast.error("Choose a time at least one minute from now");
      return;
    }
    if (
      !status?.available ||
      !status.authorization_limit_at ||
      runAt + 86_400 > status.authorization_limit_at
    ) {
      morphyToast.error(
        "Choose an earlier time within your approved access, or renew access first",
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    setMessage("");
    const request = new AbortController();
    work.current = request;
    const current = () =>
      !request.signal.aborted && AuthService.getCurrentUser()?.uid === owner;
    const operation = new PodScheduledTasksClient(owner)
      .organizeFile(file, runAt, selection.requestId, request.signal)
      .then((task) => {
        if (!current()) throw new Error("SCHEDULE_OWNER_CHANGED");
        if (task.state !== "scheduled") throw new Error("SCHEDULE_UNCONFIRMED");
        return task;
      });
    const notification = morphyToast.promise(operation, {
      loading: "Scheduling organization…",
      success: "Organization scheduled",
      error:
        "Could not confirm scheduling. Check Scheduled tasks before trying again.",
      isCurrent: current,
    });
    const retire = () => {
      if (typeof notification === "string" || typeof notification === "number")
        morphyToast.dismiss(notification);
    };
    request.signal.addEventListener("abort", retire, { once: true });
    try {
      await operation;
      if (!current()) return;
      onOpenChange(false);
    } catch {
      // Preserve the request ID for an idempotent retry; the toast owns action feedback.
    } finally {
      request.signal.removeEventListener("abort", retire);
      work.current = null;
      pending.current = false;
      setBusy(false);
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
            Organize {file.name} once, using your current analysis permission.
            Changes to the file or permission require review.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-[var(--app-form-field-gap)] text-sm">
          Run at
          <Input
            type="datetime-local"
            value={when}
            disabled={busy || !status?.available}
            onChange={(event) => {
              setWhen(event.target.value);
              setMessage("");
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {status?.available && status.authorization_limit_at
            ? `Your local time. Approved access ends ${new Date(status.authorization_limit_at * 1000).toLocaleString()}; this task expires 24 hours after its scheduled time.`
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
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || !when || !status?.available}
            onClick={() => void schedule()}
          >
            {busy ? "Scheduling…" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
