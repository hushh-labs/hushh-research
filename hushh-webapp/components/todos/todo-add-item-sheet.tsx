"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useState, type FormEvent } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { usePathname } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import type { NativeWorkspaceTaskDraft } from "@/lib/capacitor/native-workspace";
import styles from "./todo-add-item-sheet.module.css";

export type EditableTodoFields = {
  title: string;
  date: string | null;
  time: string | null;
  notes: string | null;
};

export const emptyTaskDraft = (): NativeWorkspaceTaskDraft => ({
  title: "",
  date: "",
  time: "",
  notes: "",
});

/**
 * Shared manual-task editor. Callers retain the encrypted write and their
 * own current-owner guard; this component supports either an external draft
 * (for native/workspace persistence) or internal draft state, in sheet or pane presentation.
 */
export function TodoAddItemSheet({
  draft,
  onDraftChange,
  open,
  saving,
  error,
  presentation = "sheet",
  onBackChange,
  onCloseAutoFocus,
  onOpenChange,
  onSave,
}: {
  draft?: NativeWorkspaceTaskDraft;
  onDraftChange?: (draft: NativeWorkspaceTaskDraft) => unknown;
  open: boolean;
  saving: boolean;
  error?: string | null;
  presentation?: "sheet" | "pane";
  onBackChange?: (handler: (() => boolean) | null) => void;
  onCloseAutoFocus?: () => void;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditableTodoFields) => Promise<unknown>;
}) {
  const id = useId();
  const titleId = useId();
  const [localDraft, setLocalDraft] = useState<NativeWorkspaceTaskDraft>(emptyTaskDraft);
  const isControlled = draft !== undefined && onDraftChange !== undefined;
  const activeDraft = isControlled ? draft : localDraft;
  const { title, date, time, notes } = activeDraft;
  const [notesOpen, setNotesOpen] = useState(() => !!activeDraft.notes);
  const pathname = usePathname() ?? "/one/todos";
  const back = useCallback(() => {
    if (!open) return false;
    if (!saving) onOpenChange(false);
    return true;
  }, [open, saving, onOpenChange]);
  useBackLayer(pathname, presentation === "pane" && open ? 4 : 0, back);
  useLayoutEffect(() => {
    if (presentation !== "pane" || !open) return;
    onBackChange?.(back);
    return () => onBackChange?.(null);
  }, [presentation, open, onBackChange, back]);

  useEffect(() => {
    if (!open) {
      setNotesOpen(false);
      if (!isControlled) setLocalDraft(emptyTaskDraft());
      return;
    }
    if (!isControlled) {
      setLocalDraft(emptyTaskDraft());
      setNotesOpen(false);
    } else if (draft.notes) {
      setNotesOpen(true);
    }
  }, [open, isControlled, draft?.notes]);

  const updateDraft = (patch: Partial<NativeWorkspaceTaskDraft>) => {
    const next = { ...activeDraft, ...patch };
    if (isControlled) {
      onDraftChange(next);
    } else {
      setLocalDraft(next);
    }
  };

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

  const form = (
    <form
      className={presentation === "pane" ? styles.form : styles.scheduleForm}
      onSubmit={(event) => void submit(event)}
    >
      {presentation === "pane" ? (
        <header className={styles.paneHeader}>
          <h3 id={titleId} className={styles.paneTitle}>Add item</h3>
        </header>
      ) : (
        <SheetHeader className="px-5 pb-3 pt-2 text-left">
          <SheetTitle className="text-xl tracking-[-0.02em]">
            Add item
          </SheetTitle>
          <SheetDescription className="sr-only">
            This stays encrypted in Agent One.
          </SheetDescription>
        </SheetHeader>
      )}
      <div className={presentation === "pane" ? styles.body : "space-y-4 px-5 pb-2"}>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-title`} className="sr-only">
            Title
          </Label>
          <Input
            id={`${id}-title`}
            autoFocus
            value={title}
            onChange={(event) => updateDraft({ title: event.target.value })}
            disabled={saving}
            placeholder="What do you want to do?"
            maxLength={240}
          />
        </div>
        <div className={styles.schedule}>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-date`}>Date</Label>
            <Input
              id={`${id}-date`}
              type="date"
              value={date}
              onChange={(event) => updateDraft({ date: event.target.value })}
              disabled={saving}
              className={styles.scheduleInput}
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-time`}>Time</Label>
            <Input
              id={`${id}-time`}
              type="time"
              value={time}
              onChange={(event) => updateDraft({ time: event.target.value })}
              disabled={saving}
              className={styles.scheduleInput}
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
              onChange={(event) => updateDraft({ notes: event.target.value })}
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
      {error ? (
        <p role="alert" className="shrink-0 px-4 pt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SheetFooter className="shrink-0 flex-row items-center justify-end gap-2 px-4 pt-4">
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
  );

  if (presentation === "pane") {
    return open ? (
      <FocusScope
        loop
        trapped
        asChild
        onUnmountAutoFocus={(event) => {
          if (onCloseAutoFocus) {
            event.preventDefault();
            onCloseAutoFocus();
          }
        }}
      >
        <section
          role="dialog"
          aria-labelledby={titleId}
          data-state="open"
          data-todo-editor-pane
          className={styles.pane}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              back();
            }
          }}
        >
          {form}
        </section>
      </FocusScope>
    ) : null;
  }

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
        className="mx-auto max-w-none gap-0 rounded-t-[var(--app-card-radius-feature)] border-0 bg-[color:var(--app-card-surface-default-solid)] p-0 sm:bottom-6 sm:max-w-lg sm:rounded-[var(--app-card-radius-feature)]"
        showCloseButton={!saving}
      >
        {form}
      </SheetContent>
    </Sheet>
  );
}
