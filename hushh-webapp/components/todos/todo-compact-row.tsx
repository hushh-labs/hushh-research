"use client";

import { normalizeTodoDate, TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import styles from "./todo-workspace.module.css";

export function TodoCompactRow({ task, saving, onToggle, onOpen }: {
  task: TodoItem; saving: boolean;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onOpen: (task: TodoItem) => void;
}) {
  const today = new Date();
  const dateKey = normalizeTodoDate(task.date);
  const isToday = dateKey === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const date = dateKey ? isToday ? "Today" : formatLocalDateTime(`${dateKey}T12:00:00`, { weekday: "short" }) : null;
  const time = task.time ? formatLocalDateTime(`1970-01-01T${task.time}:00`, { hour: "numeric", minute: "2-digit", hour12: true }) : null;
  const subtitle = date ? [date, time].filter(Boolean).join(", ") : task.type === "manual" ? "Added by you" : task.sourceAgent ? TODO_SOURCE_LABELS[task.sourceAgent] : "To do";
  return <div className={styles.row} data-todo-item={task.id}>
    <button type="button" className={styles.rowOpen} aria-label={task.title} disabled={saving} onClick={() => onOpen(task)}><span className={styles.rowTitle}>{task.title}</span><span className={styles.rowMeta}>{subtitle}</span></button>
    <label className={styles.completeHit}><input type="checkbox" aria-label={`Mark ${task.title} as ${task.status === "done" ? "not completed" : "completed"}`} checked={task.status === "done"} disabled={saving} onChange={() => onToggle(task, task.status !== "done")} /></label>
  </div>;
}
