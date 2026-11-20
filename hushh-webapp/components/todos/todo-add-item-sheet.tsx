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
import styles from "./todo-add-item-sheet.module.css";

export type EditableTodoFields = {
  title: string;
  date: string | null;
  time: string | null;
  notes: string | null;
};

/**
 * Shared manual-task editor. Callers retain the encrypted write and their
 * own current-owner guard; this component only owns the draft and layout.
 */
export function TodoAddItemSheet({
  open,
  saving,
  error,
  presentation = "sheet",
  onBackChange,
  onCloseAutoFocus,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  error?: string | null;
  presentation?: "sheet" | "pane";
  onBackChange?: (handler: (() => boolean) | null) => void;
  onCloseAutoFocus?: () => void;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditableTodoFields) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const titleId = useId();
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
    if (!open) return;
    setTitle("");
    setDate("");
    setTime("");
    setNotes("");
    setNotesOpen(false);
  }, [open]);

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
        <form className={presentation === "pane" ? styles.form : styles.scheduleForm} onSubmit={(event) => void submit(event)}>
          {presentation === "pane" ? (
            <header className={styles.paneHeader}>
              <h3 id={titleId} className={styles.paneTitle}>Add item</h3>
            </header>
          ) : <SheetHeader className="px-5 pb-3 pt-2 text-left">
            <SheetTitle className="text-xl tracking-[-0.02em]">
              Add item
            </SheetTitle>
            <SheetDescription className="sr-only">
              This stays encrypted in Agent One.
            </SheetDescription>
          </SheetHeader>}
          <div className={presentation === "pane" ? styles.body : "space-y-4 px-5 pb-2"}>
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
            <div className={styles.schedule}>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="todo-date">Date</Label>
                <Input
                  id="todo-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  disabled={saving}
                  className={styles.scheduleInput}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="todo-time">Time</Label>
                <Input
                  id="todo-time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  disabled={saving}
                  className={styles.scheduleInput}
                />
              </div>
            </div>
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
          {error ? <p role="alert" className="shrink-0 px-4 pt-3 text-sm text-destructive">{error}</p> : null}
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

  if (presentation === "pane") return open ? (
    <FocusScope loop trapped asChild onUnmountAutoFocus={event => {
      if (onCloseAutoFocus) {
        event.preventDefault();
        onCloseAutoFocus();
      }
    }}>
      <section role="dialog" aria-labelledby={titleId} data-state="open" data-todo-editor-pane className={styles.pane}
        onKeyDown={event => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            back();
          }
        }}>
        {form}
      </section>
    </FocusScope>
  ) : null;

  return (
    <Sheet modal open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <SheetContent side="bottom"
        className="mx-auto max-w-none gap-0 rounded-t-[var(--app-card-radius-feature)] border-0 bg-[color:var(--app-card-surface-default-solid)] p-0 sm:bottom-6 sm:max-w-lg sm:rounded-[var(--app-card-radius-feature)]"
        showCloseButton={!saving}>
        {form}
      </SheetContent>
    </Sheet>
  );
}
