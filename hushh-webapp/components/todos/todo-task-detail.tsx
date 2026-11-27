"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ScheduledRunActions, ScheduledRunInformation, type useScheduledTasksModel } from "@/components/scheduled-tasks/scheduled-tasks-panel";
import { ScheduledRunApprovalDialog } from "@/components/scheduled-tasks/scheduled-run-approval-dialog";
import { CalendarClock, CalendarDays, ChevronLeft, ClipboardList, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { ONE_TASK_TEMPLATE, type PodScheduledTasksClient, type ScheduledRun, type ScheduledRunResult, type ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import { resolveAppEnvironment } from "@/lib/app-env";
import { normalizeTodoDate, TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { groupByDate } from "./todo-list-presentation";
import styles from "./todo-workspace.module.css";

/** One detail view; mutations keep their existing encrypted persistence owner. */
export function TodoTaskDetail({ task, busy, error, onBack, onToggle, onRemove, onDetailBackChange }: {
  task: TodoItem; busy: boolean; onBack: () => void;
  error?: string | null;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onRemove: (task: TodoItem) => void;
  onDetailBackChange?: (handler: (() => boolean) | null) => void;
}) {
  const pathname = usePathname() ?? "/one/todos";
  const date = normalizeTodoDate(task.date) ? groupByDate([task])[0]?.label : null;
  const time = task.time ? formatLocalDateTime(`1970-01-01T${task.time}:00`, { hour: "numeric", minute: "2-digit", hour12: true }) : null;
  const back = useCallback(() => {
    if (busy) return true;
    onBack();
    return true;
  }, [busy, onBack]);
  useBackLayer(pathname, 2, back);
  useLayoutEffect(() => {
    onDetailBackChange?.(back);
    return () => onDetailBackChange?.(null);
  }, [onDetailBackChange, back]);
  return <section aria-label="Task details" className={styles.detail}>
    <header className={styles.detailHeader}><button type="button" className={styles.back} disabled={busy} onClick={onBack} aria-label="Back to tasks"><ChevronLeft aria-hidden /> To-do</button></header>
    <div className={styles.detailBody}>
      <h3 className={styles.detailTitle}>{task.title}</h3>
      {date || time ? <p className={styles.detailMeta}>{[date, time].filter(Boolean).join(" · ")}</p> : null}
      {task.sourceAgent ? <div className={styles.sourceLabels}><span>{task.sourceAgent === "calendar" ? <CalendarDays aria-hidden /> : <ClipboardList aria-hidden />}{TODO_SOURCE_LABELS[task.sourceAgent]}</span></div> : null}
      <div className={styles.divider} />
      <p role="status" className="sr-only">{task.status === "done" ? "Completed" : "To do"}</p>
      {task.notes ? <div className={styles.information}><h4>{task.sourceAgent === "calendar" ? "About the meeting" : "About this task"}</h4><p>{task.notes}</p></div> : null}
    </div>
    <footer className={styles.detailFooter}>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button type="button" className={styles.primary} disabled={busy} onClick={() => onToggle(task, task.status !== "done")}>{task.status === "done" ? "Mark as not completed" : "Mark as completed"}</button>
      <button type="button" className={styles.remove} disabled={busy} onClick={() => onRemove(task)}>Remove task</button>
    </footer>
  </section>;
}

export function TodoScheduledRunDetail({ task, model, vaultOwnerToken, onBack }: {
  task: ScheduledTask | undefined;
  model: ReturnType<typeof useScheduledTasksModel>;
  vaultOwnerToken: string | null;
  onBack: () => void;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const busy = Boolean(model.busy);
  const back = useCallback(() => {
    if (!busy) onBack();
    return true;
  }, [busy, onBack]);
  useBackLayer(ROUTES.ONE_TASKS, 2, back);
  const client = model.client;
  const canReview = task?.capability === ONE_TASK_TEMPLATE && task.state === "needs_review" &&
    task.last_run?.state === "needs_review" && task.review_available &&
    resolveAppEnvironment() === "development";
  const renderResult = task?.capability === ONE_TASK_TEMPLATE && client && resolveAppEnvironment() === "development"
    ? (run: ScheduledRun) => run.id && (run.state === "completed" || run.state === "failed") && (
      <AgentRunResult key={run.id} client={client} task={task} occurrenceId={run.id} />
    ) : undefined;

  return (
    <section aria-label="Scheduled run details" className={styles.detail}>
      <header className={styles.detailHeader}>
        <button type="button" className={styles.back} disabled={busy} onClick={onBack} aria-label="Back to tasks">
          <ChevronLeft aria-hidden /> Tasks
        </button>
        <Button
          variant="plain"
          size="icon-touch"
          className="ml-auto"
          aria-label="Refresh scheduled run"
          title="Refresh scheduled run"
          disabled={busy || model.checking}
          onClick={model.refresh}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.detailBody}>
        <h3 className={styles.detailTitle}>{task?.title ?? "Scheduled run"}</h3>
        {task ? (
          <>
            <div className={styles.sourceLabels}><span><CalendarClock aria-hidden /> Scheduled run</span></div>
            <div className={styles.divider} />
            <div className={styles.detailMeta}><ScheduledRunInformation task={task} renderResult={renderResult} /></div>
          </>
        ) : (
          <p role="status" className={styles.detailMeta}>
            {model.message || model.placementMessage || (model.status ? "This scheduled run is unavailable." : "Checking your agent…")}
          </p>
        )}
      </div>
      {task && (
        <footer className={styles.detailFooter}>
          {canReview && client && vaultOwnerToken && (
            <Button disabled={busy || model.checking} onClick={() => setReviewOpen(true)}>Review action</Button>
          )}
          <ScheduledRunActions task={task} model={model} />
        </footer>
      )}
      {reviewOpen && canReview && task && client && vaultOwnerToken && (
        <ScheduledRunApprovalDialog
          key={`${task.id}:${task.revision}`}
          task={task}
          client={client}
          vaultOwnerToken={vaultOwnerToken}
          onExit={() => { setReviewOpen(false); model.refresh(); }}
        />
      )}
    </section>
  );
}

function AgentRunResult({ client, task, occurrenceId }: {
  client: PodScheduledTasksClient;
  task: ScheduledTask;
  occurrenceId: string;
}) {
  const [result, setResult] = useState<ScheduledRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function read() {
    if (request.current) return;
    const active = new AbortController();
    request.current = active;
    setLoading(true);
    setFailed(false);
    try {
      const value = await client.readRunResult(task, active.signal, occurrenceId);
      if (!active.signal.aborted) setResult(value);
    } catch {
      if (!active.signal.aborted) setFailed(true);
    } finally {
      request.current = null;
      if (!active.signal.aborted) setLoading(false);
    }
  }

  return (
    <div className={styles.information}>
      <h4>Run result</h4>
      {result ? <p>{result.summary}</p> : (
        <>
          {failed && <p role="status">The saved result couldn’t load.</p>}
          <Button variant="outline" size="compact" disabled={loading} onClick={() => void read()}>
            {loading ? "Loading result…" : failed ? "Try again" : "View result"}
          </Button>
        </>
      )}
    </div>
  );
}
