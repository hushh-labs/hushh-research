"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";

/** One detail view; mutations keep their existing encrypted persistence owner. */
export function TodoTaskDetail({ task, busy, onBack, onToggle, onRemove }: {
  task: TodoItem; busy: boolean; onBack: () => void;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onRemove: (task: TodoItem) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const pathname = usePathname() ?? "/one/todos";
  useBackLayer(pathname, confirm ? 3 : 2, () => {
    if (busy) return true;
    if (confirm) setConfirm(false); else onBack();
    return true;
  });
  return <section aria-label="Task details" className="flex min-h-[65dvh] flex-col gap-4">
    <Button variant="none" effect="fade" size="compact" className="self-start" disabled={busy} onClick={onBack}>Back to tasks</Button>
    <div className="space-y-3">
      {task.sourceAgent ? <p data-profile-role="description" className="text-muted-foreground">{TODO_SOURCE_LABELS[task.sourceAgent]}</p> : null}
      <h3 data-profile-role="header" className="break-words text-xl font-semibold">{task.title}</h3>
      {task.date || task.time ? <p data-profile-role="description">{[task.date, task.time].filter(Boolean).join(" · ")}</p> : null}
      <p role="status" data-profile-role="description" className="text-muted-foreground">{task.status === "done" ? "Completed" : "To do"}</p>
      {task.notes ? <p data-profile-role="description" className="whitespace-pre-wrap break-words">{task.notes}</p> : null}
    </div>
    <div className="mt-auto flex flex-col gap-2 pt-5">
      {confirm ? <><p>Remove this task?</p><Button disabled={busy} onClick={() => onRemove(task)}>Remove task</Button><Button variant="none" effect="fade" disabled={busy} onClick={() => setConfirm(false)}>Keep task</Button></> : <>
        <Button disabled={busy} onClick={() => onToggle(task, task.status !== "done")}>{task.status === "done" ? "Mark as not completed" : "Mark as completed"}</Button>
        <Button variant="none" effect="fade" className="min-h-11 w-full text-destructive" disabled={busy} onClick={() => setConfirm(true)}>Remove task</Button>
      </>}
    </div>
  </section>;
}
