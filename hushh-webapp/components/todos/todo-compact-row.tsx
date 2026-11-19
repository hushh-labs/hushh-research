"use client";

import { TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import styles from "./todo-workspace.module.css";

export function TodoCompactRow({ task, saving, onToggle, onOpen }: {
  task: TodoItem; saving: boolean;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onOpen: (task: TodoItem) => void;
}) {
  const today = new Date();
  const isToday = task.date === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const date = task.date ? isToday ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(`${task.date}T12:00:00`)) : null;
  const time = task.time ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(`1970-01-01T${task.time}:00`)) : null;
  const subtitle = date ? [date, time].filter(Boolean).join(", ") : task.type === "manual" ? "Added by you" : task.sourceAgent ? TODO_SOURCE_LABELS[task.sourceAgent] : "To do";
  return <div className={styles.row} data-todo-item={task.id}>
    <button type="button" className={styles.rowOpen} aria-label={task.title} disabled={saving} onClick={() => onOpen(task)}><span className={styles.rowTitle}>{task.title}</span><span className={styles.rowMeta}>{subtitle}</span></button>
    <label className={styles.completeHit}><input type="checkbox" aria-label={`Mark ${task.title} as ${task.status === "done" ? "not completed" : "completed"}`} checked={task.status === "done"} disabled={saving} onChange={() => onToggle(task, task.status !== "done")} /></label>
  </div>;
}
