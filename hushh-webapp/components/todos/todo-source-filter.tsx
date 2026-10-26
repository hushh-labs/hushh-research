"use client";

import { TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";

export function todoMatchesSource(task: TodoItem, source: string) {
  return source === "all" || (source === "manual" ? task.type === "manual" : task.sourceAgent === source);
}

/** A view preference never completes, hides permanently or executes a task. */
export function TodoSourceFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="flex min-h-11 items-center justify-between gap-3" data-profile-role="description">
    Show tasks from
    <select aria-label="Task source" value={value} onChange={event => onChange(event.target.value)}
      className="min-h-11 max-w-[65%] rounded-xl border border-border bg-background px-3 text-sm text-foreground">
      <option value="all">All sources</option>
      <option value="manual">My added tasks</option>
      {Object.entries(TODO_SOURCE_LABELS).map(([key, label]) => <option key={key} value={key}>{label} tasks</option>)}
    </select>
  </label>;
}
