"use client";

import { useId, useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import type { GoalPlanInput } from "@/lib/services/goals-pkm-service";
import type { TodoItem } from "@/lib/todos/todo-list-model";

/** Shared review form for a manual plan or a proposal supplied by a caller. */
export function GoalEditor({ initial, tasks, editing, saving, error, onSave, onCancel }: {
  initial: GoalPlanInput;
  tasks: readonly TodoItem[];
  editing: boolean;
  saving: boolean;
  error: string | null;
  onSave: (plan: GoalPlanInput) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [plan, setPlan] = useState(initial);
  const [query, setQuery] = useState("");
  const saved = new Map(tasks.map(task => [task.id, task]));
  const selected = new Set(plan.taskIds);
  const search = query.trim().toLocaleLowerCase();
  const options = tasks.filter(task => !selected.has(task.id) && task.title.toLocaleLowerCase().includes(search));
  const visibleIds = [...plan.taskIds, ...options.slice(0, 16).map(task => task.id)];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saving && plan.title.trim() && plan.outcome.trim()) onSave(plan);
  }

  return (
    <form onSubmit={submit} className="space-y-5 p-4 sm:p-5" aria-label={editing ? "Edit goal" : "New goal"}>
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-title`}>Goal name</Label>
          <Input id={`${id}-title`} required maxLength={240} value={plan.title}
            onChange={event => setPlan({ ...plan, title: event.target.value })} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-outcome`}>What would success look like?</Label>
          <Textarea id={`${id}-outcome`} required maxLength={4000} rows={3} value={plan.outcome}
            onChange={event => setPlan({ ...plan, outcome: event.target.value })} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-category`}>Category (optional)</Label>
          <Input id={`${id}-category`} maxLength={80} value={plan.category ?? ""}
            onChange={event => setPlan({ ...plan, category: event.target.value })} />
        </div>
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">Linked tasks</legend>
          {tasks.length === 0 && visibleIds.length === 0 ? <HelperText>No saved tasks to link yet.</HelperText> : null}
          {tasks.length > 16 ? (
            <Input type="search" value={query} onChange={event => setQuery(event.target.value)}
              aria-label="Find a saved task" placeholder="Find a saved task" />
          ) : null}
          {visibleIds.map(taskId => (
            <label key={taskId} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-muted/50">
              <input type="checkbox" checked={selected.has(taskId)} className="size-4 shrink-0 accent-primary"
                onChange={event => setPlan({ ...plan, taskIds: event.target.checked
                  ? [...plan.taskIds, taskId] : plan.taskIds.filter(id => id !== taskId) })} />
              <span className="min-w-0 break-words">{saved.get(taskId)?.title ?? "Unavailable task"}</span>
              {saved.get(taskId)?.status === "done" ? <span className="ml-auto text-muted-foreground">Done</span> : null}
            </label>
          ))}
          {options.length > 16 ? <HelperText>Search to find more tasks.</HelperText> : null}
        </fieldset>
      </fieldset>
      {error ? <HelperText as="p" role="alert">{error}</HelperText> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="none" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={saving || !plan.title.trim() || !plan.outcome.trim()}>
          {saving ? "Saving…" : "Save goal"}
        </Button>
      </div>
    </form>
  );
}
