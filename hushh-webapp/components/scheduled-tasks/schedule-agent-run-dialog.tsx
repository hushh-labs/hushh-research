"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { ONE_TASK_TEMPLATE, type PodScheduledTasksClient, type ScheduledTask, type ScheduledTasksStatus } from "@/lib/services/pod-scheduled-tasks";

type Terms = Parameters<PodScheduledTasksClient["scheduleOne"]>[0];

export function ScheduleAgentRunDialog({ client, status, onClose, onSaved }: {
  client: PodScheduledTasksClient;
  status: ScheduledTasksStatus;
  onClose: () => void;
  onSaved: (task: ScheduledTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [when, setWhen] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const approved = useRef<Terms | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const close = () => {
    if (!request.current) onClose();
    return true;
  };
  useBackLayer(ROUTES.ONE_TASKS, 3, close);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const available = status.available && status.templates.includes(ONE_TASK_TEMPLATE);
  const retrying = approved.current !== null;

  async function confirm() {
    if (request.current || !available) return;
    const runAt = Math.floor(new Date(when).getTime() / 1000);
    const expiresAt = runAt + 1800;
    if (!approved.current) {
      if (!title.trim() || !goal.trim()) {
        setMessage("Enter a name and instructions for the run.");
        return;
      }
      if (!Number.isFinite(runAt) || runAt < Date.now() / 1000 + 60) {
        setMessage("Choose a time at least one minute from now.");
        return;
      }
      if (!status.authorization_limit_at || expiresAt > status.authorization_limit_at) {
        setMessage("Choose an earlier time within your approved access.");
        return;
      }
      approved.current = { title: title.trim(), goal: goal.trim(), runAt, expiresAt, timezone, requestId: crypto.randomUUID() };
    }
    const active = new AbortController();
    request.current = active;
    setBusy(true);
    setMessage("");
    try {
      const task = await client.scheduleOne(approved.current, active.signal);
      if (!active.signal.aborted) onSaved(task);
    } catch {
      if (!active.signal.aborted) setMessage("Scheduling couldn’t be confirmed. Check Tasks before creating a new run. You can retry this exact request here.");
    } finally {
      request.current = null;
      if (!active.signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a run</DialogTitle>
          <DialogDescription>Your private agent will follow these instructions once at the time you approve, using its existing permissions.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void confirm(); }}>
          <label className="grid gap-1.5 text-sm">
            Name
            <Input required maxLength={80} value={title} disabled={busy || retrying} onChange={event => setTitle(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">
            What should your agent do?
            <Textarea required maxLength={2000} value={goal} disabled={busy || retrying} onChange={event => setGoal(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">
            Run at ({timezone})
            <Input required type="datetime-local" value={when} disabled={busy || retrying} onChange={event => setWhen(event.target.value)} />
          </label>
          {message && <p role="alert" className="text-sm text-muted-foreground">{message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>{retrying ? "Close" : "Cancel"}</Button>
            <Button type="submit" disabled={!available || busy}>{busy ? "Confirming…" : retrying ? "Retry confirmation" : "Confirm run"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
