"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText, MediumRowLabel } from "@/components/app-ui/typography";
import { suggestTodoTasks, todoSuggestionsAvailable } from "@/lib/services/todo-suggestion-service";
import { taskSuggestionInput } from "@/lib/todos/task-suggestion-input";
import { createTodo } from "@/lib/services/todo-list-pkm-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { taskCapabilities, type TaskCoverage, type TaskEvidence, type TaskSuggestion } from "@/lib/todos/task-suggestion-model";

type Props = {
  userId: string; vaultKey: string; vaultOwnerToken: string;
  evidence: TaskEvidence[]; coverage: TaskCoverage[]; loading: boolean;
  onRefresh: () => void; onSaved: () => void;
};

function Coverage({ coverage, loading }: Pick<Props, "coverage" | "loading">) {
  const sources = new Map(coverage.map(row => [row.capability, row]));
  return <details>
    <summary data-profile-role="name" className="min-h-11 cursor-pointer content-center">{loading ? "Checking task sources…" : "Task sources"}</summary>
    <ul className="space-y-2 pb-2">
      {taskCapabilities().map(capability => {
        const source = sources.get(capability.id as TaskCoverage["capability"]);
        const status = loading ? "Checking…" : !source ? "Not checked yet" : source.status === "not_connected" ? "Not connected" : source.status === "unavailable" ? "Could not check" : source.status === "incomplete" ? `${source.count} found · Limited coverage` : source.count ? `${source.count} awaiting attention` : "No pending work";
        return <li key={capability.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1"><span data-profile-role="name">{capability.title}</span><span data-profile-role="description" className="text-muted-foreground">{status}</span></li>;
      })}
    </ul>
  </details>;
}

export function TodoAgentSuggestions({ userId, vaultKey, vaultOwnerToken, evidence, coverage, loading, onRefresh, onSaved }: Props) {
  const epoch = snapshotVaultSessionEpoch();
  const signature = JSON.stringify(evidence);
  const identity = useMemo(() => Symbol(`todo-suggestions-${Boolean(userId)}-${Boolean(vaultKey)}-${Boolean(vaultOwnerToken)}-${epoch}-${signature.length}`), [userId, vaultKey, vaultOwnerToken, epoch, signature]);
  const current = useRef(identity);
  current.current = identity;
  const [state, setState] = useState({ identity, approved: false, busy: false, saving: null as string | null, error: "", items: [] as TaskSuggestion[], checked: false });
  const abort = useRef<AbortController | null>(null);
  const operation = useRef<symbol | null>(null);
  const [availability, setAvailability] = useState<{ userId: string; epoch: number; enabled: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const done = (enabled: boolean) => { if (active && isVaultSessionEpochCurrent(epoch)) setAvailability({ userId, epoch, enabled }); };
    void todoSuggestionsAvailable(vaultOwnerToken, controller.signal).then(done).catch(() => done(false));
    return () => { active = false; controller.abort(); };
  }, [userId, vaultOwnerToken, epoch]);
  const available = availability?.userId === userId && availability.epoch === epoch && availability.enabled;
  useEffect(() => () => { abort.current?.abort(); }, [identity]);
  const visible = state.identity === identity;
  const approved = visible && state.approved;
  const busy = visible && (state.busy || Boolean(state.saving));
  const find = async () => {
    if (!available || !approved || busy || loading || !evidence.length || operation.current === identity) return;
    operation.current = identity;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const isCurrent = () => current.current === identity && !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    setState(previous => ({ ...previous, busy: true, error: "" }));
    try {
      const items = await suggestTodoTasks({ vaultOwnerToken, sources: evidence, allowModelProcessing: true, signal: controller.signal, isCurrent });
      if (isCurrent()) setState(previous => ({ ...previous, items, busy: false, checked: true }));
    } catch {
      if (isCurrent()) setState(previous => ({ ...previous, busy: false, error: "Suggestions could not load. Try again." }));
    } finally {
      if (operation.current === identity) operation.current = null;
    }
  };
  const save = async (item: TaskSuggestion) => {
    if (busy || operation.current === identity || current.current !== identity || !isVaultSessionEpochCurrent(epoch)) return;
    operation.current = identity;
    setState(previous => ({ ...previous, saving: item.key, error: "" }));
    try {
      const input = await taskSuggestionInput(item);
      if (current.current !== identity || !isVaultSessionEpochCurrent(epoch)) return;
      const saved = await createTodo(input, { userId, vaultKey, vaultOwnerToken });
      if (current.current !== identity || !isVaultSessionEpochCurrent(epoch)) return;
      if (!saved.result.success) throw new Error("Task was not saved");
      setState(previous => ({ ...previous, saving: null, items: previous.items.filter(row => row.key !== item.key) }));
      onSaved();
    } catch {
      if (current.current === identity && isVaultSessionEpochCurrent(epoch)) setState(previous => ({ ...previous, saving: null, error: "Task could not be saved. Try again." }));
    } finally {
      if (operation.current === identity) operation.current = null;
    }
  };
  return <section aria-label="One task suggestions" className="space-y-1">
    <Coverage coverage={coverage} loading={loading} />
    {coverage.some(source => source.status === "unavailable" || source.status === "incomplete") ? <HelperText as="p" data-profile-role="description" role="status">Some sources couldn’t be fully checked.</HelperText> : null}
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" className="size-4 shrink-0 accent-[var(--app-accent)]" checked={approved} disabled={!available || busy} onChange={event => setState({ identity, approved: event.target.checked, busy: false, saving: null, error: "", items: [], checked: false })} />
      <span data-profile-role="name">Let One suggest tasks from summaries.</span>
    </label>
    {!available ? <HelperText as="p" data-profile-role="description">Suggestions aren’t available for this agent.</HelperText> : null}
    <HelperText as="p" data-profile-role="description">Up to 100 loaded summaries; no message content, card details or Memory content. Review before adding.</HelperText>
    <div className="flex flex-wrap gap-1">
      <Button variant="none" effect="fade" size="compact" data-profile-role="action" className="min-h-11" disabled={!available || !approved || busy || loading || !evidence.length} onClick={() => void find()}>{busy ? "Working…" : "Suggest tasks"}</Button>
      <Button variant="none" effect="fade" size="compact" data-profile-role="action" className="min-h-11" disabled={busy || loading} onClick={onRefresh}>Refresh sources</Button>
    </div>
    {available && !loading && !evidence.length ? <HelperText as="p" data-profile-role="description" role="status">No task summaries yet.</HelperText> : null}
    {visible && state.error ? <HelperText as="p" data-profile-role="description" role="status">{state.error}</HelperText> : null}
    {visible && state.checked && !state.items.length ? <HelperText as="p" data-profile-role="description" role="status">No new suggestions.</HelperText> : null}
    {visible ? state.items.map(item => <div key={item.key} className="space-y-1 border-b py-2"><MediumRowLabel as="h4" data-profile-role="name">{item.title}</MediumRowLabel><HelperText as="p" data-profile-role="description">{item.reason}</HelperText><Button variant="none" effect="fade" size="compact" data-profile-role="action" className="min-h-11" disabled={busy} onClick={() => void save(item)}>Add task</Button></div>) : null}
  </section>;
}
