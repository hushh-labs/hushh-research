"use client";

import { useCallback, useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { CalendarDays, ChevronLeft, Clock3, ClipboardList } from "@/components/icons";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { groupByDate } from "./todo-list-presentation";
import styles from "./todo-workspace.module.css";

/** One detail view; mutations keep their existing encrypted persistence owner. */
export function TodoTaskDetail({ task, busy, onBack, onToggle, onRemove, onDetailBackChange }: {
  task: TodoItem; busy: boolean; onBack: () => void;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onRemove: (task: TodoItem) => void;
  onDetailBackChange?: (handler: (() => boolean) | null) => void;
}) {
  const pathname = usePathname() ?? "/one/todos";
  const date = task.date ? groupByDate([task])[0]?.label : null;
  const time = task.time ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(`1970-01-01T${task.time}:00`)) : null;
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
      <p role="status" className={styles.status}><Clock3 aria-hidden />{task.status === "done" ? "Completed" : "To do"}</p>
      {task.notes ? <div className={styles.information}><h4>{task.sourceAgent === "calendar" ? "About the meeting" : "About this task"}</h4><p>{task.notes}</p></div> : null}
    </div>
    <footer className={styles.detailFooter}>
      <button type="button" className={styles.primary} disabled={busy} onClick={() => onToggle(task, task.status !== "done")}>{task.status === "done" ? "Mark as not completed" : "Mark as completed"}</button>
      <button type="button" className={styles.remove} disabled={busy} onClick={() => onRemove(task)}>Remove task</button>
    </footer>
  </section>;
}
