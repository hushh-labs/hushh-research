"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import type { TodoEditableFields, TodoItem } from "@/lib/todos/todo-list-model";
import { todoReminderInstant, todoReminderLocalFields } from "@/lib/todos/reminder-schedule";
import { TodoNotificationControl } from "./todo-notification-control";

export function TodoItemEditor({
  open,
  task = null,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  task?: TodoItem | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: TodoEditableFields) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    const local = task?.reminderAt ? todoReminderLocalFields(task.reminderAt) : null;
    setDate(local?.date ?? task?.date ?? "");
    setTime(local?.time ?? task?.time ?? "");
    setNotes(task?.notes ?? "");
    setNotesOpen(Boolean(task?.notes));
    setError("");
  }, [open, task]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || saving || submitting.current) return;
    let reminderAt: string | null;
    const local = task?.reminderAt ? todoReminderLocalFields(task.reminderAt) : null;
    const unchanged = Boolean(local && date === local.date && time === local.time);
    try {
      reminderAt = unchanged ? task!.reminderAt! : todoReminderInstant(date || null, time || null);
      if (!unchanged && reminderAt && new Date(reminderAt).getTime() <= Date.now()) reminderAt = null;
    }
    catch { setError("Choose a valid local date and time. A time also needs a date."); return; }
    submitting.current = true;
    try { await onSave({
      title: title.trim(),
      date: unchanged ? task!.date : date || null,
      time: unchanged ? task!.time : time || null,
      notes: notes.trim() || null,
      reminderAt,
    }); } catch { setError("Your changes couldn’t be saved. Try again."); }
    finally { submitting.current = false; }
  };

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <SheetContent
        side="bottom"
        className="mx-auto max-w-xl gap-0 rounded-t-[var(--app-card-radius-feature)] border-0 bg-[color:var(--app-card-surface-default-solid)] p-0 sm:bottom-6 sm:max-w-lg sm:rounded-[var(--app-card-radius-feature)]"
        showCloseButton={!saving}
      >
        <form onSubmit={(event) => void submit(event)}>
          <SheetHeader className="px-5 pb-3 pt-2 text-left">
            <SheetTitle className="text-xl tracking-[-0.02em]">
              {task ? "Edit item" : "Add item"}
            </SheetTitle>
            <SheetDescription className="sr-only">
              This stays encrypted in your private agent.
            </SheetDescription>
          </SheetHeader>
          {task?.type === "automatic" ? <HelperText as="p" className="px-5 pb-3">Changes affect this to-do only.</HelperText> : null}
          <div className="space-y-4 px-5 pb-2">
            <div className="space-y-1.5">
              <Label htmlFor="todo-title" className="sr-only">
                Title
              </Label>
              <Input
                id="todo-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={saving}
                placeholder="What do you want to do?"
                maxLength={240}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="todo-date">Date</Label>
                <Input
                  id="todo-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="todo-time">Time</Label>
                <Input
                  id="todo-time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
            <HelperText as="p">{date && time ? "A reminder will be scheduled for this time. Past times do not send alerts." : "Add a date and time to receive a reminder."}</HelperText>
            {date && time ? <HelperText as="p">Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</HelperText> : null}
            {date && time ? <TodoNotificationControl /> : null}
            {error ? <HelperText as="p" role="alert">{error}</HelperText> : null}
            {notesOpen ? (
              <div className="space-y-1.5">
                <Label htmlFor="todo-notes">Notes</Label>
                <Textarea
                  id="todo-notes"
                  autoFocus
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={saving}
                  placeholder="Add a detail"
                  maxLength={1200}
                  className="min-h-22 resize-none"
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="compact"
                className="!px-0"
                disabled={saving}
                onClick={() => setNotesOpen(true)}
              >
                Add a note
              </Button>
            )}
          </div>
          <SheetFooter className="flex-row items-center justify-end gap-2 px-5 pt-5">
            <Button
              type="button"
              variant="none"
              effect="fill"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="prominent"
              disabled={saving || !title.trim()}
              loading={saving}
            >
              Save
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
