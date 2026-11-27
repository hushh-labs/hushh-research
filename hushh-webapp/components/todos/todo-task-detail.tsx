"use client";

import { useCallback, useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { ScheduledRunActions, ScheduledRunInformation, type useScheduledTasksModel } from "@/components/scheduled-tasks/scheduled-tasks-panel";
import { CalendarClock, CalendarDays, ChevronLeft, ClipboardList, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import type { ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import { normalizeTodoDate, TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { groupByDate } from "./todo-list-presentation";
import styles from "./todo-workspace.module.css";

/** One detail view; mutations keep their existing encrypted persistence owner. */
export function TodoTaskDetail({ task, busy, error, onBack, onToggle, onRemove, onDetailBackChange }: {
  task: TodoItem; busy: boolean; onBack: () => void;
  error?: string | null;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onRemove: (task: TodoItem) => void;
  onDetailBackChange?: (handler: (() => boolean) | null) => void;
}) {
  const pathname = usePathname() ?? "/one/todos";
  const date = normalizeTodoDate(task.date) ? groupByDate([task])[0]?.label : null;
  const time = task.time ? formatLocalDateTime(`1970-01-01T${task.time}:00`, { hour: "numeric", minute: "2-digit", hour12: true }) : null;
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
  return <section aria-label="Task details" className={styles.detail}>
    <header className={styles.detailHeader}><button type="button" className={styles.back} disabled={busy} onClick={onBack} aria-label="Back to tasks"><ChevronLeft aria-hidden /> To-do</button></header>
    <div className={styles.detailBody}>
      <h3 className={styles.detailTitle}>{task.title}</h3>
      {date || time ? <p className={styles.detailMeta}>{[date, time].filter(Boolean).join(" · ")}</p> : null}
      {task.sourceAgent ? <div className={styles.sourceLabels}><span>{task.sourceAgent === "calendar" ? <CalendarDays aria-hidden /> : <ClipboardList aria-hidden />}{TODO_SOURCE_LABELS[task.sourceAgent]}</span></div> : null}
      <div className={styles.divider} />
      <p role="status" className="sr-only">{task.status === "done" ? "Completed" : "To do"}</p>
      {task.notes ? <div className={styles.information}><h4>{task.sourceAgent === "calendar" ? "About the meeting" : "About this task"}</h4><p>{task.notes}</p></div> : null}
    </div>
    <footer className={styles.detailFooter}>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button type="button" className={styles.primary} disabled={busy} onClick={() => onToggle(task, task.status !== "done")}>{task.status === "done" ? "Mark as not completed" : "Mark as completed"}</button>
      <button type="button" className={styles.remove} disabled={busy} onClick={() => onRemove(task)}>Remove task</button>
    </footer>
  </section>;
}

export function TodoScheduledRunDetail({ task, model, onBack }: {
  task: ScheduledTask | undefined;
  model: ReturnType<typeof useScheduledTasksModel>;
  onBack: () => void;
}) {
  const busy = Boolean(model.busy);
  const back = useCallback(() => {
    if (!busy) onBack();
    return true;
  }, [busy, onBack]);
  useBackLayer(ROUTES.ONE_TASKS, 2, back);

  return (
    <section aria-label="Scheduled run details" className={styles.detail}>
      <header className={styles.detailHeader}>
        <button type="button" className={styles.back} disabled={busy} onClick={onBack} aria-label="Back to tasks">
          <ChevronLeft aria-hidden /> Tasks
        </button>
        <Button
          variant="plain"
          size="icon-touch"
          className="ml-auto"
          aria-label="Refresh scheduled run"
          title="Refresh scheduled run"
          disabled={busy || model.checking}
          onClick={model.refresh}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.detailBody}>
        <h3 className={styles.detailTitle}>{task?.title ?? "Scheduled run"}</h3>
        {task ? (
          <>
            <div className={styles.sourceLabels}><span><CalendarClock aria-hidden /> Scheduled run</span></div>
            <div className={styles.divider} />
            <div className={styles.detailMeta}><ScheduledRunInformation task={task} /></div>
          </>
        ) : (
          <p role="status" className={styles.detailMeta}>
            {model.message || model.placementMessage || (model.status ? "This scheduled run is unavailable." : "Checking your agent…")}
          </p>
        )}
      </div>
      {task && <footer className={styles.detailFooter}><ScheduledRunActions task={task} model={model} /></footer>}
    </section>
  );
}
