"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import {
  ComputerUseClient,
  type DiscoveredBrowserTask,
} from "@/lib/services/computer-use-client";
import { ComputerUseTaskCard } from "./computer-use-task-card";

/** Rediscover existing tasks on reconnect; no default Browser launcher or idle polling. */
type ActiveTasksProps = {
  ownerId: string;
  refreshKey: number;
  route: string;
  getVaultOwnerToken?: () => string | null;
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
}: ActiveTasksProps) {
  const client = useMemo(() => new ComputerUseClient(ownerId, getVaultOwnerToken), [ownerId, getVaultOwnerToken]);
  const transport = useMemo(() => client.transport(), [client]);
  const [tasks, setTasks] = useState<{
    owner: string;
    rows: DiscoveredBrowserTask[];
  }>({ owner: ownerId, rows: [] });
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
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
  if (tasks.owner !== ownerId) return null;
  const active = tasks.rows.filter((task) =>
    ["running", "needs_owner", "outcome_uncertain"].includes(task.phase),
  );
  const terminal = tasks.rows.findLast(task => task.current && ["completed", "unavailable"].includes(task.phase));
  const visible = active.length ? active : terminal ? [terminal] : [];
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
      {visible.map((task) =>
        task.current ? (
          <ComputerUseTaskCard
            key={task.binding.taskId}
            binding={task.binding}
            transport={transport}
            route={route}
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
