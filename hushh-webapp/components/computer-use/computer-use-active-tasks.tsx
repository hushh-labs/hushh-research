"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import {
  ComputerUseClient,
  type DiscoveredBrowserTask,
} from "@/lib/services/computer-use-client";
import { ComputerUseTaskCard } from "./computer-use-task-card";
import { sameComputerUseBinding, type ComputerUseSnapshot } from "@/lib/computer-use/contracts";

/** Rediscover existing tasks on reconnect; no default Browser launcher or idle polling. */
type ActiveTasksProps = {
  ownerId: string;
  refreshKey: number;
  route: string;
  getVaultOwnerToken?: () => string | null;
  openReviewSignal?: number;
  onReviewCountChange?: (count: number) => void;
  onActivityReceipt?: (snapshot: ComputerUseSnapshot) => void;
};

export function ComputerUseActiveTasks(props: ActiveTasksProps) {
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return <OwnerBrowserTasks key={`${props.ownerId}:${generation}`} {...props} />;
}

function OwnerBrowserTasks({
  ownerId,
  refreshKey,
  route,
  getVaultOwnerToken,
  openReviewSignal = 0,
  onReviewCountChange,
  onActivityReceipt,
}: ActiveTasksProps) {
  const [owner] = useState(snapshotValidatedAuthSessionOwner);
  const client = useMemo(() => new ComputerUseClient(ownerId, getVaultOwnerToken), [ownerId, getVaultOwnerToken]);
  const transport = useMemo(() => client.transport(), [client]);
  const [tasks, setTasks] = useState<{
    owner: string;
    rows: DiscoveredBrowserTask[];
  }>({ owner: ownerId, rows: [] });
  const tasksRef = useRef(tasks);
  useLayoutEffect(() => { tasksRef.current = tasks; }, [tasks]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const updateTaskSnapshot = useCallback((snapshot: ComputerUseSnapshot) => {
    if (owner?.userId !== ownerId || !isValidatedAuthSessionOwnerCurrent(owner)) return;
    if (snapshot.activityReceipt && tasksRef.current.rows.some(task => task.current && sameComputerUseBinding(task.binding, snapshot.binding))) onActivityReceipt?.(snapshot);
    setTasks(current => {
      if (!isValidatedAuthSessionOwnerCurrent(owner) || current.owner !== ownerId) return current;
      const index = current.rows.findIndex(task => task.current && sameComputerUseBinding(task.binding, snapshot.binding));
      if (index < 0 || current.rows[index]?.phase === snapshot.phase) return current;
      return { ...current, rows: current.rows.map((task, position) => position === index ? { ...task, phase: snapshot.phase } : task) };
    });
  }, [owner, ownerId, onActivityReceipt]);
  useEffect(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (owner?.userId !== ownerId) return;
    const request = new AbortController();
    const current = () => !request.signal.aborted && isValidatedAuthSessionOwnerCurrent(owner);
    setFailed(false);
    void client
      .tasks(request.signal)
      .then((rows) => {
        if (current()) setTasks({ owner: ownerId, rows });
      })
      .catch(() => {
        if (current()) setFailed(true);
      });
    return () => request.abort();
  }, [client, ownerId, refreshKey, retry]);
  const ownerMatches = tasks.owner === ownerId;
  const active = ownerMatches
    ? tasks.rows.filter((task) => ["running", "needs_owner", "outcome_uncertain"].includes(task.phase))
    : [];
  const terminal = ownerMatches
    ? tasks.rows.findLast(task => task.current && ["completed", "unavailable"].includes(task.phase))
    : undefined;
  const visible = active.length ? active : terminal ? [terminal] : [];
  const reviewCount = active.filter(
    (task) => task.phase === "needs_owner" || task.phase === "outcome_uncertain" || !task.current,
  ).length;
  useEffect(() => {
    onReviewCountChange?.(reviewCount);
  }, [onReviewCountChange, reviewCount]);
  useEffect(() => () => {
    onReviewCountChange?.(0);
  }, [onReviewCountChange]);
  if (!ownerMatches) return null;
  // An unavailable pilot stays quiet on ordinary chat entry. Once a task was
  // requested or observed, failed discovery must be recoverable, not disappear.
  const showFailure = failed && (refreshKey > 0 || visible.length > 0);
  if (!visible.length && !showFailure) return null;
  return (
    <div className="w-full min-w-0 space-y-3" aria-label="Browser tasks">
      {showFailure && <div className="flex flex-wrap items-center gap-2 text-sm">
        <p role="status">Couldn’t reconnect to Browser. Your task hasn’t been restarted.</p>
        <Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Try again</Button>
      </div>}
      {visible.map((task, index) =>
        task.current ? (
          <ComputerUseTaskCard
            key={task.binding.taskId}
            binding={task.binding}
            transport={transport}
            route={route}
            openReviewSignal={index === 0 ? openReviewSignal : 0}
            onSnapshotChange={updateTaskSnapshot}
          />
        ) : (
          <section
            key={task.binding.taskId}
            className="space-y-1 p-4"
            aria-label="Interrupted browser task"
          >
            <h3 className="text-sm font-semibold">Browser needs review</h3>
            <p className="text-sm text-muted-foreground">
              Agent One restarted. Check the website before starting
              again; the last action won’t be repeated.
            </p>
          </section>
        ),
      )}
    </div>
  );
}
