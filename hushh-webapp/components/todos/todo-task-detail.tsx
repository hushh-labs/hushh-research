"use client";

import { useCallback, useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { groupByDate } from "./todo-list-presentation";

/** One detail view; mutations keep their existing encrypted persistence owner. */
export function TodoTaskDetail({ task, busy, error, onBack, onToggle, onRemove, onDetailBackChange }: {
  task: TodoItem; busy: boolean; onBack: () => void;
  error?: string | null;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onRemove: (task: TodoItem) => void;
  onDetailBackChange?: (handler: (() => boolean) | null) => void;
}) {
  const pathname = usePathname() ?? ROUTES.ONE_TASKS;
  const date = task.date ? groupByDate([task])[0]?.label : null;
  const time = task.time ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(`1970-01-01T${task.time}:00`)) : null;
  const back = useCallback(() => {
    if (busy) return true;
    onBack();
    return true;
  }, [busy, onBack]);
  useBackLayer(pathname, 2, back);
  useLayoutEffect(() => {
    onDetailBackChange?.(back);
    return () => onDetailBackChange?.(null);
  }, [onDetailBackChange, back]);
  return <section aria-label="Task details" className="flex min-h-[65dvh] flex-col gap-4">
    <Button variant="none" effect="fade" size="compact" className="self-start" disabled={busy} onClick={onBack}>Back to tasks</Button>
    <div className="space-y-3">
      {task.sourceAgent ? <p data-profile-role="description" className="text-muted-foreground">{TODO_SOURCE_LABELS[task.sourceAgent]}</p> : null}
      <h3 data-profile-role="header" className="break-words text-xl font-semibold">{task.title}</h3>
      {date || time ? <p data-profile-role="description">{[date, time].filter(Boolean).join(" · ")}</p> : null}
      <p role="status" data-profile-role="description" className="text-muted-foreground">{task.status === "done" ? "Completed" : "To do"}</p>
      {task.notes ? <p data-profile-role="description" className="whitespace-pre-wrap break-words">{task.notes}</p> : null}
    </div>
    <div className="mt-auto flex flex-col gap-2 pt-5">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={busy} onClick={() => onToggle(task, task.status !== "done")}>{task.status === "done" ? "Mark as not completed" : "Mark as completed"}</Button>
      <Button variant="none" effect="fade" className="min-h-11 w-full text-destructive" disabled={busy} onClick={() => onRemove(task)}>Remove task</Button>
    </div>
  </section>;
}
