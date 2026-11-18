"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import type { NativeWorkspaceTaskDraft } from "@/lib/capacitor/native-workspace";

export type EditableTodoFields = {
  title: string;
  date: string | null;
  time: string | null;
  notes: string | null;
};

export const emptyTaskDraft = (): NativeWorkspaceTaskDraft => ({ title: "", date: "", time: "", notes: "" });

export function TodoAddItemSheet({
  draft, onDraftChange,
  open,
  saving,
  error,
  onOpenChange,
  onSave,
}: {
  draft: NativeWorkspaceTaskDraft;
  onDraftChange: (draft: NativeWorkspaceTaskDraft) => unknown;
  open: boolean;
  saving: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditableTodoFields) => Promise<unknown>;
}) {
  const id = useId();
  const { title, date, time, notes } = draft;
  const [notesOpen, setNotesOpen] = useState(() => !!draft.notes);

  useEffect(() => { if (!open) setNotesOpen(false); }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onSave({
      title: title.trim(),
      date: date || null,
      time: time || null,
      notes: notes.trim() || null,
    });
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
              Add item
            </SheetTitle>
            <SheetDescription className="sr-only">
              This stays encrypted in Agent One.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-5 pb-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-title`} className="sr-only">
                Title
              </Label>
              <Input
                id={`${id}-title`}
                autoFocus
                value={title}
                onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
                disabled={saving}
                placeholder="What do you want to do?"
                maxLength={240}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-date`}>Date</Label>
                <Input
                  id={`${id}-date`}
                  type="date"
                  value={date}
                  onChange={(event) => onDraftChange({ ...draft, date: event.target.value })}
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-time`}>Time</Label>
                <Input
                  id={`${id}-time`}
                  type="time"
                  value={time}
                  onChange={(event) => onDraftChange({ ...draft, time: event.target.value })}
                  disabled={saving}
                />
              </div>
            </div>
            {notesOpen ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-notes`}>Notes</Label>
                <Textarea
                  id={`${id}-notes`}
                  autoFocus
                  value={notes}
                  onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })}
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
          {error ? <p role="alert" className="px-5 text-sm text-destructive">{error}</p> : null}
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
