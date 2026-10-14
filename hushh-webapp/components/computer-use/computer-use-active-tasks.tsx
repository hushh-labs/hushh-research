"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ComputerUseClient,
  type DiscoveredBrowserTask,
} from "@/lib/services/computer-use-client";
import { ComputerUseTaskCard } from "./computer-use-task-card";

/** Rediscover existing tasks on reconnect; no default Browser launcher or idle polling. */
export function ComputerUseActiveTasks({
  ownerId,
  refreshKey,
  route,
}: {
  ownerId: string;
  refreshKey: number;
  route: string;
}) {
  const client = useMemo(() => new ComputerUseClient(ownerId), [ownerId]);
  const transport = useMemo(() => client.transport(), [client]);
  const [tasks, setTasks] = useState<{
    owner: string;
    rows: DiscoveredBrowserTask[];
  }>({ owner: ownerId, rows: [] });
  useEffect(() => {
    const request = new AbortController();
    void client
      .tasks(request.signal)
      .then((rows) => {
        if (!request.signal.aborted) setTasks({ owner: ownerId, rows });
      })
      .catch(() => {
        /* An unavailable pilot must not replace chat with an error or controls. */
      });
    return () => request.abort();
  }, [client, ownerId, refreshKey]);
  if (tasks.owner !== ownerId) return null;
  const visible = tasks.rows.filter((task) =>
    ["running", "needs_owner", "outcome_uncertain"].includes(task.phase),
  );
  if (!visible.length) return null;
  return (
    <div className="w-full min-w-0 space-y-3" aria-label="Browser tasks">
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
              The private agent restarted. Check the website before starting
              again; the last action won’t be repeated.
            </p>
          </section>
        ),
      )}
    </div>
  );
}
