"use client";

import { useRef, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { TodoListPkmService, type TodoWriteParams } from "@/lib/services/todo-list-pkm-service";
import { taskCapabilities, type TaskCapability, type TaskCoverage, type TaskEvidence } from "@/lib/todos/task-suggestion-model";
import { TodoAgentSuggestions } from "./todo-agent-suggestions";

export function TodoTaskSources({ persistence, selected, coverage, evidence, loading, disabled, isCurrent, onChange, onRefresh, onSaved }: {
  persistence: TodoWriteParams; selected: readonly TaskCapability[];
  coverage: TaskCoverage[]; evidence: TaskEvidence[]; loading: boolean; disabled: boolean;
  isCurrent: () => boolean; onChange: (selected: TaskCapability[]) => void;
  onRefresh: () => void; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(false);
  const pending = useRef(false);
  const save = async (capability: TaskCapability, checked: boolean) => {
    if (pending.current || disabled || !isCurrent()) return;
    pending.current = true; setSaving(true); setError(false);
    const next = checked ? [...selected, capability] : selected.filter(value => value !== capability);
    onChange(next);
    try {
      const result = await TodoListPkmService.saveSourceChoices({ ...persistence, selectedCapabilities: next });
      if (!isCurrent()) return;
      if (!result.success) throw new Error("Source choices were not saved");
    } catch { if (isCurrent()) { onChange([...selected]); setError(true); } }
    finally { pending.current = false; if (isCurrent()) setSaving(false); }
  };
  return <>
    <Button variant="none" effect="fade" size="compact" disabled={disabled} onClick={() => setOpen(true)}>Task sources</Button>
    <Sheet open={open} onOpenChange={next => { if (!saving) setOpen(next); }}>
      <SheetContent side="bottom" className="mx-auto max-h-[85dvh] max-w-lg overflow-y-auto rounded-t-3xl">
        <SheetHeader><SheetTitle>Task sources</SheetTitle><SheetDescription>Choose what contributes to your tasks.</SheetDescription></SheetHeader>
        <div className="divide-y">
          {taskCapabilities().map(source => {
            const id = source.id as TaskCapability, checked = selected.includes(id);
            const status = coverage.find(row => row.capability === id);
            return <label key={id} className="flex min-h-14 items-center justify-between gap-3 py-2">
              <span><span className="block">{source.title}</span><span className="text-xs text-muted-foreground">{!checked ? "Off" : loading ? "Checking…" : !status || status.status === "unavailable" ? "Could not check" : status.status === "not_connected" ? "Not connected" : status.status === "incomplete" ? "Limited coverage" : `${status.count} pending`}</span></span>
              <input type="checkbox" aria-label={source.title} checked={checked} disabled={saving || disabled} onChange={event => void save(id, event.target.checked)} className="size-5 accent-[var(--app-accent)]" />
            </label>;
          })}
        </div>
        {error ? <p role="status">Couldn’t save. Try again.</p> : null}
        <TodoAgentSuggestions {...persistence} selectedCapabilities={selected} coverage={coverage} evidence={evidence.filter(item => !item.pendingTitle)} loading={loading || saving} onRefresh={onRefresh} onSaved={onSaved} />
      </SheetContent>
    </Sheet>
  </>;
}
