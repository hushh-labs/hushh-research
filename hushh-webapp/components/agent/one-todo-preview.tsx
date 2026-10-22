"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { ClipboardList } from "@/components/icons";
import { TodoListPkmService, type TodoItem } from "@/lib/services/todo-list-pkm-service";
import { TodoRow, DueReceiptRow, extractDueReceipts, groupByDate } from "@/components/todos/todo-list-presentation";
import { useTodoLiveTasks } from "@/lib/todos/use-todo-live-tasks";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { getCachedGmailReceipts, cachedGmailReceiptDisplayItems } from "@/lib/profile/gmail-receipts-cache";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import styles from "./one-agent-profile-sheet.module.css";
import { TodoAgentSuggestions } from "@/components/todos/todo-agent-suggestions";

export function OneTodoPreview({
  user,
  vaultKey,
  vaultOwnerToken,
  isVaultUnlocked,
}: {
  user: User;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isVaultUnlocked: boolean;
}) {
  const ready = Boolean(user.uid && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const epoch = snapshotVaultSessionEpoch();
  const identity = useMemo(() => Symbol(`todo-${Boolean(user.uid)}-${Boolean(vaultKey)}-${Boolean(vaultOwnerToken)}-${ready}-${epoch}`), [user.uid, vaultKey, vaultOwnerToken, ready, epoch]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const requestRef = useRef(0);
  const [snapshot, setSnapshot] = useState({ identity, tasks: [] as TodoItem[], loading: true, error: false, savingTaskId: null as string | null });
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
      const state = await TodoListPkmService.load({ userId: user.uid, vaultKey, vaultOwnerToken });
      if (isCurrent()) setSnapshot({ identity, tasks: state.tasks, loading: false, error: false, savingTaskId: null });
    } catch {
      if (isCurrent()) setSnapshot(previous => ({ ...previous, loading: false, error: true }));
    }
  }, [ready, user.uid, vaultKey, vaultOwnerToken, identity, epoch]);

  useEffect(() => {
    void loadTasks();
    return () => { requestRef.current += 1; };
  }, [loadTasks]);

  const idTokenProvider = useCallback(
    () => user.getIdToken(),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: ready ? user.uid : null,
    idTokenProvider: ready ? idTokenProvider : null,
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  const cachedReceipts = useMemo(() => {
    if (!ready || !receiptAccountKey) return null;
    return getCachedGmailReceipts(user.uid, receiptAccountKey);
  }, [ready, receiptAccountKey, user.uid]);

  const dueReceipts = useMemo(() => {
    if (!cachedReceipts) return [];
    return extractDueReceipts(cachedGmailReceiptDisplayItems(cachedReceipts));
  }, [cachedReceipts]);

  const live = useTodoLiveTasks({ userId: user.uid, vaultOwnerToken, idTokenProvider, enabled: ready, tasks });
  const openTasks = live.pending;
  const sourceLoading = live.agentLoading || live.calendarReadLoading || live.sourceLoading;
  const sourceError = Boolean(live.agentLoadError || live.calendarReadError || live.sourceError);
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
      const params = { userId: user.uid, vaultKey, vaultOwnerToken, task };
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
  const deleteTask = (task: TodoItem) => persistTask(task, "deleted");

  return (
    <div className={`${styles.todo} profile-home-content`}>
      <div className={styles.sectionHeading}>
        <h3>To-do list</h3>
      </div>

      {ready && vaultKey && vaultOwnerToken ? <TodoAgentSuggestions
        userId={user.uid} vaultKey={vaultKey} vaultOwnerToken={vaultOwnerToken}
        evidence={live.evidence} coverage={live.coverage} loading={Boolean(sourceLoading || loading)}
        onRefresh={retry} onSaved={() => void loadTasks()}
      /> : null}

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
        <div className="space-y-4">
          {/* 1. Any time section comes FIRST */}
          {anytimeGroup ? (
            <section key={anytimeGroup.id} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                {anytimeGroup.label}
              </h4>
              <div className="space-y-2">
                {anytimeGroup.tasks.map((task) => (
                  <TodoRow
                    key={task.id}
                    task={task}
                    saving={loading || Boolean(savingTaskId)}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {/* 2. Receipts in between */}
          {dueReceipts.length > 0 ? (
            <section className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                Receipts & Due Payments
              </h4>
              <div className="space-y-2">
                {dueReceipts.map((receipt) => (
                  <DueReceiptRow key={receipt.id} receipt={receipt} />
                ))}
              </div>
            </section>
          ) : null}

          {/* 3. Dated events below */}
          {datedGroups.map((group) => (
            <section key={group.id} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                {group.label}
              </h4>
              <div className="space-y-2">
                {group.tasks.map((task) => (
                  <TodoRow
                    key={task.id}
                    task={task}
                    saving={loading || Boolean(savingTaskId)}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
