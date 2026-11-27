"use client";

import { useState } from "react";
import type { TodoItem } from "@/lib/services/todo-list-pkm-service";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { MailActionButton } from "./mail-action-button";

function localInputValue(instant: Date): string {
  const localTime = instant.getTime() - instant.getTimezoneOffset() * 60_000;
  return new Date(localTime).toISOString().slice(0, 16);
}

export function MailTaskReminder({
  task,
  busy,
  onSave,
  onCancel,
}: {
  task: TodoItem;
  busy: boolean;
  onSave: (dueAt: string) => void;
  onCancel: () => void;
}) {
  const reminder = task.personalReminder;
  const pending = reminder?.state === "pending";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() =>
    pending ? localInputValue(new Date(reminder.dueAt)) : "",
  );

  const lastReminder = reminder?.state === "delivered"
    ? <p>Reminder was due {formatLocalDateTime(reminder.dueAt)}</p>
    : null;
  if (task.status !== "pending") {
    return reminder?.state === "cancelled" ? <p>Reminder cancelled</p> : lastReminder;
  }
  if (!editing) {
    return (
      <div className="grid justify-items-start gap-2">
        {lastReminder}
        {pending && <p>Reminder · {formatLocalDateTime(reminder.dueAt)}</p>}
        <div className="flex flex-wrap gap-2">
          <MailActionButton disabled={busy} onClick={() => setEditing(true)}>
            {pending ? "Change reminder time" : "Remind me in One"}
          </MailActionButton>
          {pending && (
            <MailActionButton disabled={busy} onClick={onCancel}>Cancel reminder</MailActionButton>
          )}
        </div>
      </div>
    );
  }

  const chosen = new Date(value);
  const valid = Number.isFinite(chosen.getTime()) && localInputValue(chosen) === value &&
    (!pending || chosen.getTime() !== Date.parse(reminder.dueAt));
  return (
    <form className="grid justify-items-start gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (valid && chosen.getTime() > Date.now() && !busy) onSave(chosen.toISOString());
    }}>
      <label>
        Reminder time
        <input type="datetime-local" required className="block rounded border p-2"
          min={localInputValue(new Date())} value={value}
          onChange={(event) => setValue(event.target.value)} />
      </label>
      <p className="text-sm text-muted-foreground">
        One checks for the reply and reminds you while your vault is unlocked in the app.
      </p>
      <div className="flex flex-wrap gap-2">
        <MailActionButton type="submit" disabled={busy || !valid || chosen.getTime() <= Date.now()}>
          Save reminder
        </MailActionButton>
        <MailActionButton type="button" disabled={busy} onClick={() => setEditing(false)}>Back</MailActionButton>
      </div>
    </form>
  );
}
