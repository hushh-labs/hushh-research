"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { usePathname } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { Switch } from "@/components/ui/switch";
import { X, Compass, ClipboardList } from "@/components/icons";
import styles from "./todo-workspace.module.css";
import { Button } from "@/lib/morphy-ux/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { TodoListPkmService, type TodoWriteParams } from "@/lib/services/todo-list-pkm-service";
import { taskCapabilities, type TaskCapability, type TaskCoverage } from "@/lib/todos/task-suggestion-model";

export function TodoTaskSources({ persistence, selected, coverage, loading, disabled, isCurrent, onChange, presentation = "sheet", onOpenChange, onBackChange }: {
  presentation?: "sheet" | "pane"; onOpenChange?: (open: boolean) => void; onBackChange?: (handler: (() => boolean) | null) => void;
  persistence: TodoWriteParams; selected: readonly TaskCapability[];
  coverage: TaskCoverage[]; loading: boolean; disabled: boolean;
  isCurrent: () => boolean; onChange: (selected: TaskCapability[]) => void;
}) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(false);
  const pending = useRef(false);
  const pathname = usePathname() ?? "/one/todos";
  const setVisible = useCallback((next: boolean) => { if (!pending.current) { setOpen(next); onOpenChange?.(next); } }, [onOpenChange]);
  const back = useCallback(() => { if (!open) return false; setVisible(false); return true; }, [open, setVisible]);
  useBackLayer(pathname, open ? 4 : 0, back);
  useLayoutEffect(() => { if (open) onBackChange?.(back); return () => { if (open) onBackChange?.(null); }; }, [open, onBackChange, back]);
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
  if (presentation === "pane") return <>
    <button type="button" className={styles.sourcesTrigger} disabled={disabled} aria-expanded={open} onClick={() => setVisible(!open)}><Compass aria-hidden />Task sources</button>
    {open ? <FocusScope loop trapped asChild><section role="dialog" aria-label="Task sources" data-state="open" className={styles.picker} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); back(); } }}>
      <header className={styles.pickerHeader}><div><h3>Task sources</h3><p>Choose what contributes to your tasks.</p></div><button type="button" className={styles.close} aria-label="Close task sources" disabled={saving} onClick={() => setVisible(false)}><X aria-hidden /></button></header>
      <div className={styles.pickerBody}>
        {taskCapabilities().map(source => { const id = source.id as TaskCapability; return <label className={styles.sourceRow} key={id}><span className={styles.sourceName}><ClipboardList aria-hidden />{source.title}</span><span className={styles.switchHit}><Switch aria-label={source.title} checked={selected.includes(id)} disabled={saving || disabled} onCheckedChange={checked => void save(id, checked)} /></span></label>; })}
        {error ? <p role="status">Could not save. Try again.</p> : null}
      </div>
      <footer className={styles.pickerFooter}><span>{selected.length} sources selected</span><button type="button" className={styles.done} disabled={saving} onClick={() => setVisible(false)}>Done</button></footer>
    </section></FocusScope> : null}
  </>;
  return <>
    <Button variant="none" effect="fade" size="compact" disabled={disabled} onClick={() => setVisible(true)}>Task sources</Button>
    <Sheet open={open} onOpenChange={setVisible}>
      <SheetContent side="bottom" className="mx-auto max-h-[85dvh] sm:max-w-lg overflow-y-auto rounded-t-3xl">
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
      </SheetContent>
    </Sheet>
  </>;
}
