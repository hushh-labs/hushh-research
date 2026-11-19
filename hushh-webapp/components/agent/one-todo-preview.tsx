"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { ClipboardList, Plus } from "@/components/icons";
import { TodoListPkmService, createTodo, type TodoItem } from "@/lib/services/todo-list-pkm-service";
import { TodoAddItemSheet, type EditableTodoFields } from "@/components/todos/todo-add-item-sheet";
import { DueReceiptRow, extractDueReceipts, groupByDate } from "@/components/todos/todo-list-presentation";
import { useTodoLiveTasks } from "@/lib/todos/use-todo-live-tasks";
import { taskCapabilitySchema, type TaskCapability } from "@/lib/todos/task-suggestion-model";
import { TodoTaskSources } from "@/components/todos/todo-task-sources";
import { TodoTaskDetail } from "@/components/todos/todo-task-detail";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { getCachedGmailReceipts, cachedGmailReceiptDisplayItems } from "@/lib/profile/gmail-receipts-cache";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import styles from "./one-agent-profile-sheet.module.css";
import workspace from "@/components/todos/todo-workspace.module.css";
import { TodoCompactRow } from "@/components/todos/todo-compact-row";

export function OneTodoPreview({
  user,
  ownerId,
  vaultKey,
  vaultOwnerToken,
  isVaultUnlocked,
  onDetailBackChange,
  onDetailModeChange,
}: {
  user: User;
  /** Validated application owner (useAuth().userId); `user` supplies only the Firebase ID token. */
  ownerId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isVaultUnlocked: boolean;
  onDetailBackChange?: (handler: (() => boolean) | null) => void;
  onDetailModeChange?: (open: boolean) => void;
}) {
  const ready = Boolean(ownerId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const epoch = snapshotVaultSessionEpoch();
  const identity = useMemo(() => Symbol(`todo-${Boolean(ownerId)}-${Boolean(vaultKey)}-${Boolean(vaultOwnerToken)}-${ready}-${epoch}`), [ownerId, vaultKey, vaultOwnerToken, ready, epoch]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const requestRef = useRef(0);
  const [selected, setSelected] = useState<readonly TaskCapability[]>([]);
  const [choicesOwner, setChoicesOwner] = useState<symbol | null>(null);
  const [detail, setDetail] = useState<{ identity: symbol; task: TodoItem } | null>(null);
  const [snapshot, setSnapshot] = useState({ identity, tasks: [] as TodoItem[], loading: true, error: false, savingTaskId: null as string | null });
  const [editorOpen, setEditorOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const current = ready && snapshot.identity === identity;
  const tasks = useMemo(() => current ? snapshot.tasks : [], [current, snapshot.tasks]);
  const loading = ready && (!current || snapshot.loading);
  const error = current && snapshot.error;
  const savingTaskId = current ? snapshot.savingTaskId : null;

  const loadTasks = useCallback(async () => {
    if (!ready || !vaultKey || !vaultOwnerToken || identityRef.current !== identity || snapshotVaultSessionEpoch() !== epoch) return;
    const request = ++requestRef.current;
    const isCurrent = () => identityRef.current === identity && requestRef.current === request && snapshotVaultSessionEpoch() === epoch;
    setSnapshot(previous => ({ identity, tasks: previous.identity === identity ? previous.tasks : [], loading: true, error: false, savingTaskId: null }));
    try {
      const state = await TodoListPkmService.load({ userId: ownerId, vaultKey, vaultOwnerToken });
      if (isCurrent()) {
        setSelected(state.selectedCapabilities ?? taskCapabilitySchema.options);
        setChoicesOwner(identity);
        setSnapshot({ identity, tasks: state.tasks, loading: false, error: false, savingTaskId: null });
      }
    } catch {
      if (isCurrent()) setSnapshot(previous => ({ ...previous, loading: false, error: true }));
    }
  }, [ready, ownerId, vaultKey, vaultOwnerToken, identity, epoch]);

  useEffect(() => {
    void loadTasks();
    return () => { requestRef.current += 1; };
  }, [loadTasks]);

  const idTokenProvider = useCallback(
    () => user.getIdToken(),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: ready && current && choicesOwner === identity && selected.includes("gmail") ? ownerId : null,
    idTokenProvider: ready && current && choicesOwner === identity && selected.includes("gmail") ? idTokenProvider : null,
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  const cachedReceipts = useMemo(() => {
    if (!ready || !current || choicesOwner !== identity || !selected.includes("gmail") || !receiptAccountKey) return null;
    return getCachedGmailReceipts(ownerId, receiptAccountKey);
  }, [ready, current, choicesOwner, identity, selected, receiptAccountKey, ownerId]);

  const dueReceipts = useMemo(() => {
    if (!cachedReceipts) return [];
    return extractDueReceipts(cachedGmailReceiptDisplayItems(cachedReceipts));
  }, [cachedReceipts]);

  const live = useTodoLiveTasks({ userId: ownerId, vaultOwnerToken, idTokenProvider, enabled: ready && current && choicesOwner === identity, tasks, selectedCapabilities: selected });
  const openTasks = live.pending;
  const sourceLoading = live.agentLoading || live.calendarReadLoading || live.sourceLoading;
  const sourceError = Boolean(live.agentLoadError || live.calendarReadError || live.emailReadError);
  const retry = () => {
    void loadTasks();
    live.calendar.refresh();
    live.upcoming.refresh();
    void live.refreshSources();
    void Promise.all([live.agentFeed.retry(), live.retryKyc()]).catch(() => undefined);
  };
  const groups = useMemo(() => groupByDate(openTasks), [openTasks]);
  const anytimeGroup = useMemo(
    () => groups.find((g) => g.id === "anytime"),
    [groups],
  );
  const datedGroups = useMemo(
    () => groups.filter((g) => g.id !== "anytime"),
    [groups],
  );

  const persistTask = async (task: TodoItem, status: "done" | "pending" | "deleted") => {
    if (!ready || !vaultKey || !vaultOwnerToken || loading || savingTaskId || identityRef.current !== identity || snapshotVaultSessionEpoch() !== epoch) return;
    const request = ++requestRef.current;
    const isCurrent = () => identityRef.current === identity && requestRef.current === request && snapshotVaultSessionEpoch() === epoch;
    // Keep automatic-task tombstones so a live source cannot resurrect an item.
    const updated = { ...task, status };
    setSnapshot(previous => ({ ...previous, savingTaskId: task.id, tasks: [...previous.tasks.filter(item => item.id !== task.id), updated] }));
    try {
      const params = { userId: ownerId, vaultKey, vaultOwnerToken, task };
      const result = status === "deleted"
        ? await TodoListPkmService.remove(params)
        : await TodoListPkmService.setStatus({ ...params, status });
      if (!result.success) throw new Error("Task could not be saved");
      if (isCurrent()) setSnapshot(previous => ({ ...previous, savingTaskId: null }));
    } catch {
      if (isCurrent()) {
        setSnapshot(previous => ({ ...previous, tasks, savingTaskId: null, error: true }));
      }
    }
  };
  const toggleTask = (task: TodoItem, complete: boolean) => persistTask(task, complete ? "done" : "pending");
  const saveManualTask = async (input: EditableTodoFields) => {
    if (!ready || !vaultKey || !vaultOwnerToken || loading || savingTaskId || identityRef.current !== identity || snapshotVaultSessionEpoch() !== epoch) return;
    const request = ++requestRef.current;
    const isCurrent = () => identityRef.current === identity && requestRef.current === request && snapshotVaultSessionEpoch() === epoch;
    setSaveError(false);
    setSnapshot(previous => ({ ...previous, savingTaskId: "new-item", error: false }));
    try {
      const { task, result } = await createTodo(
        { ...input, type: "manual" },
        { userId: ownerId, vaultKey, vaultOwnerToken },
      );
      if (!result.success) throw new Error("Task could not be saved");
      if (isCurrent()) {
        setSnapshot(previous => ({ ...previous, tasks: [task, ...previous.tasks], savingTaskId: null }));
        setEditorOpen(false);
      }
    } catch {
      if (isCurrent()) {
        setSnapshot(previous => ({ ...previous, savingTaskId: null }));
        setSaveError(true);
      }
    }
  };

  const currentDetail = detail?.identity === identity && (tasks.find(item => item.id === detail.task.id) ?? live.pending.find(item => item.id === detail.task.id) ?? detail.task);
  const detailVisible = Boolean(currentDetail && current && ready && currentDetail.status !== "deleted");
  useLayoutEffect(() => { onDetailModeChange?.(detailVisible); return () => onDetailModeChange?.(false); }, [detailVisible, onDetailModeChange]);
  if (currentDetail && current && ready && currentDetail.status !== "deleted") return <TodoTaskDetail
    task={currentDetail} busy={loading || Boolean(savingTaskId)} onBack={() => setDetail(null)} onToggle={toggleTask}
    onDetailBackChange={onDetailBackChange}
    onRemove={task => { void persistTask(task, "deleted").then(() => setDetail(null)); }} />;

  return (
    <div className={workspace.workspace} data-profile-type-scale="todo" aria-busy={loading || Boolean(savingTaskId)}>
      <header className={workspace.toolbar}>
        <h3>Your tasks</h3>
        <div className={workspace.tools}>
          {ready && current && choicesOwner === identity && vaultKey && vaultOwnerToken ? <TodoTaskSources presentation="pane" onOpenChange={setSourcesOpen} onBackChange={onDetailBackChange} persistence={{ userId: ownerId, vaultKey, vaultOwnerToken }} selected={selected} coverage={live.coverage} loading={live.sourceLoading} disabled={loading || Boolean(savingTaskId) || error}
            isCurrent={() => identityRef.current === identity && snapshotVaultSessionEpoch() === epoch} onChange={setSelected} /> : null}
          <button type="button" className={workspace.add} data-todo-add-item="true" aria-label="Add item" disabled={!ready || loading || Boolean(savingTaskId) || sourcesOpen} onClick={() => setEditorOpen(true)}><Plus aria-hidden /></button>
        </div>
      </header>
      <div className={workspace.list} inert={sourcesOpen || undefined}>

      {ready && saveError ? (
        <div className={styles.notice} role="status">
          <p>Task could not be saved. Your list was not changed.</p>
        </div>
      ) : null}

      {ready && (error || sourceError) ? (
        <div className={styles.notice} role="status">
          <p>{error ? "Your saved tasks could not refresh." : "Some tasks could not refresh."}</p>
          <button type="button" onClick={retry} disabled={loading || Boolean(savingTaskId)}>Try again</button>
        </div>
      ) : null}
      {!ready ? (
        <p role="status" className={styles.notice}>
          Unlock your vault to view your to-do list.
        </p>
      ) : loading || (sourceLoading && !openTasks.length && !dueReceipts.length) ? (
        <p role="status" className={styles.notice}>
          Loading your to-do list…
        </p>
      ) : !openTasks.length && !dueReceipts.length ? error || sourceError ? null : (
        <div className={styles.empty}>
          <ClipboardList className="size-7" aria-hidden />
          <p>All clear.</p>
          <span>Tasks and due payments will appear here.</span>
        </div>
      ) : (
        <div>
          {[...datedGroups, ...(anytimeGroup ? [anytimeGroup] : [])].map(group => <section key={group.id}>
            <h4 className={workspace.groupLabel}>{group.label}</h4>
            {group.tasks.map(task => <TodoCompactRow key={task.id} task={task} saving={loading || Boolean(savingTaskId)} onToggle={toggleTask} onOpen={task => setDetail({ identity, task })} />)}
          </section>)}
          {dueReceipts.length ? <section><h4 className={workspace.groupLabel}>Receipts & Due Payments</h4>{dueReceipts.map(receipt => <DueReceiptRow key={receipt.id} receipt={receipt} />)}</section> : null}
        </div>
      )}
      </div>
      <TodoAddItemSheet
        open={editorOpen}
        saving={Boolean(savingTaskId)}
        onOpenChange={setEditorOpen}
        onSave={saveManualTask}
      />
    </div>
  );
}
