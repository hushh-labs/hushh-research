"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { ONE_TASK_TEMPLATE, SCHEDULE_WEEKDAYS, type PodScheduledTasksClient, type ScheduleRepeat, type ScheduledTask, type ScheduledTasksStatus } from "@/lib/services/pod-scheduled-tasks";

type Terms = Parameters<PodScheduledTasksClient["scheduleOne"]>[0];
type RepeatChoice = ScheduleRepeat | "selected-weekdays";

export function ScheduleAgentRunDialog({ client, status, onClose, onSaved }: {
  client: PodScheduledTasksClient;
  status: ScheduledTasksStatus;
  onClose: () => void;
  onSaved: (task: ScheduledTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [when, setWhen] = useState("");
  const repeatId = useId();
  const [repeat, setRepeat] = useState<RepeatChoice>("once");
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4]);
  const [ends, setEnds] = useState("");
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
  const repeats = status.repeat_modes ?? [];
  const repeating = repeat !== "once";
  const selectedWeekdays = repeat === "selected-weekdays";
  const retrying = approved.current !== null;

  async function confirm() {
    if (request.current || !available) return;
    if (!approved.current) {
      const start = new Date(when);
      const runAt = Math.floor(start.getTime() / 1000);
      const expiresAt = repeating ? Math.floor(new Date(ends).getTime() / 1000) : runAt + 1800;
      if (!title.trim() || !goal.trim()) {
        setMessage("Enter a name and instructions for the run.");
        return;
      }
      if (!Number.isFinite(runAt) || runAt < Date.now() / 1000 + 60) {
        setMessage("Choose a time at least one minute from now.");
        return;
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= runAt) {
        setMessage("Choose an end time after the first run.");
        return;
      }
      if (selectedWeekdays && !weekdays.includes((start.getDay() + 6) % 7)) {
        setMessage("Choose a first run on one of the selected days.");
        return;
      }
      if (!status.authorization_limit_at || expiresAt > status.authorization_limit_at) {
        setMessage("Choose an earlier time within your approved access.");
        return;
      }
      const cadence = selectedWeekdays ? "weekly" : repeat;
      if (cadence !== "once" && !repeats.includes(cadence)) {
        setMessage("Your private agent no longer supports this schedule.");
        return;
      }
      approved.current = {
        title: title.trim(), goal: goal.trim(), runAt, expiresAt, timezone, requestId: crypto.randomUUID(),
        ...(cadence !== "once" ? {
          recurrence: { repeat: cadence, ...(selectedWeekdays ? { weekdays } : {}) },
        } : {}),
      };
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
          <DialogDescription>Your private agent will follow these instructions on the schedule you approve, using its existing permissions.</DialogDescription>
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
            {repeating ? "First run" : "Run at"} ({timezone})
            <Input required type="datetime-local" value={when} disabled={busy || retrying} onChange={event => setWhen(event.target.value)} />
          </label>
          {repeats.some(mode => mode !== "once") && (
            <div className="grid gap-1.5 text-sm">
              <label htmlFor={repeatId}>Repeat</label>
              <Select value={repeat} disabled={busy || retrying} onValueChange={value => setRepeat(value as RepeatChoice)}>
                <SelectTrigger id={repeatId}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">Once</SelectItem>
                  {repeats.includes("daily") && <SelectItem value="daily">Daily</SelectItem>}
                  {repeats.includes("weekly") && <SelectItem value="weekly">Weekly</SelectItem>}
                  {repeats.includes("weekly") && <SelectItem value="selected-weekdays">Selected weekdays</SelectItem>}
                  {repeats.includes("monthly") && <SelectItem value="monthly">Monthly</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}
          {selectedWeekdays && (
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm" disabled={busy || retrying}>
              <legend>Days of the week</legend>
              {SCHEDULE_WEEKDAYS.map((day, index) => (
                <label key={day} className="flex min-h-8 items-center gap-2">
                  <input type="checkbox" checked={weekdays.includes(index)} onChange={event => {
                    const { checked } = event.target;
                    setWeekdays(previous => checked ? [...previous, index].sort((a, b) => a - b) : previous.filter(value => value !== index));
                  }} />
                  {day}
                </label>
              ))}
            </fieldset>
          )}
          {repeating && (
            <label className="grid gap-1.5 text-sm">
              End at ({timezone})
              <Input required type="datetime-local" value={ends} min={when} disabled={busy || retrying} onChange={event => setEnds(event.target.value)} />
              {status.authorization_limit_at ? (
                <span className="text-xs text-muted-foreground">Approved access ends {new Date(status.authorization_limit_at * 1000).toLocaleString()}.</span>
              ) : null}
            </label>
          )}
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
