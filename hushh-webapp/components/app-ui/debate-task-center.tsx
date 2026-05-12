"use client";

import { type ReactElement, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  ExternalLink,
  X,
  RotateCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/button";
import {
  TOP_SHELL_DROPDOWN_BODY_CLASSNAME,
  TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME,
  TOP_SHELL_DROPDOWN_HEADER_CLASSNAME,
} from "@/components/app-ui/top-shell-dropdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DebateRunManagerService,
  type DebateRunTask,
} from "@/lib/services/debate-run-manager";
import {
  AppBackgroundTaskService,
  type AppBackgroundTask,
  isAppBackgroundTaskVisible,
} from "@/lib/services/app-background-task-service";
import { ApiService } from "@/lib/services/api-service";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { getSessionItem, removeSessionItem } from "@/lib/utils/session-storage";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";

// --- Helpers ---
const IMPORT_BACKGROUND_SNAPSHOT_KEY = "kai_portfolio_import_background_v1";

interface ImportBackgroundSnapshot {
  taskId?: string | null;
  runId?: string | null;
  status?: string;
  userId?: string;
}

function readImportSnapshot(): ImportBackgroundSnapshot | null {
  const raw = getSessionItem(IMPORT_BACKGROUND_SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImportBackgroundSnapshot;
  } catch {
    return null;
  }
}

// --- Status Formatters ---
function statusLabel(status: string): string {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Canceled";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <Icon icon={Loader2} size="sm" className="animate-spin text-sky-500" />;
  if (status === "completed") return <Icon icon={CheckCircle2} size="sm" className="text-emerald-500" />;
  if (status === "failed") return <Icon icon={XCircle} size="sm" className="text-rose-500" />;
  return <Icon icon={Ban} size="sm" className="text-amber-500" />;
}

// --- Extracted Sub-Components for Performance ---

function AppTaskItem({
  task,
  isBusy,
  vaultOwnerToken,
  onCancelImport,
  onCancelPlaid,
  onAction,
}: {
  task: AppBackgroundTask;
  isBusy: boolean;
  vaultOwnerToken: string | null;
  onCancelImport: (task: AppBackgroundTask) => Promise<void>;
  onCancelPlaid: (task: AppBackgroundTask) => Promise<void>;
  onAction: (taskId: string, action: () => Promise<void>) => void;
}) {
  const router = useRouter();

  const metadata = task.metadata as Record<string, unknown> | null;
  const statusItems = Array.isArray(metadata?.statusItems)
    ? metadata.statusItems.map(String).filter(Boolean).slice(0, 5)
    : [];

  const timings = metadata?.timings as Record<string, number> | null;
  const timingParts = timings
    ? [
      timings.totalMs ? `Total ${Math.round(timings.totalMs)}ms` : null,
      timings.manifestReadMs ? `manifest ${Math.round(timings.manifestReadMs)}ms` : null,
      timings.decryptLoadMs ? `unlock ${Math.round(timings.decryptLoadMs)}ms` : null,
      timings.transformMs ? `rebuild ${Math.round(timings.transformMs)}ms` : null,
      timings.validationMs ? `dummy save ${Math.round(timings.validationMs)}ms` : null,
    ].filter(Boolean)
    : [];

  return (
    <div className="px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon status={task.status} />
            <span className="text-sm font-semibold">{task.title}</span>
            <span className="text-xs text-muted-foreground">{statusLabel(task.status)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>

          {statusItems.length > 0 && (
            <div className="mt-2 space-y-1">
              {statusItems.map((item) => (
                <p key={item} className="text-[11px] text-muted-foreground">{item}</p>
              ))}
            </div>
          )}

          {timingParts.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">{timingParts.join(" • ")}</p>
          )}

          <p className="mt-1 text-xs text-muted-foreground">
            Started {new Date(task.startedAt).toLocaleTimeString()}
          </p>

          {task.error && <p className="mt-1 text-xs text-rose-500">{task.error}</p>}
        </div>

        <div className="flex items-center gap-1">
          {task.routeHref && (
            <Button
              variant="none"
              effect="fade"
              size="icon"
              className="h-8 w-8"
              onClick={() => router.push(task.routeHref as string)}
              aria-label="Open related screen"
            >
              <Icon icon={ExternalLink} size="xs" />
            </Button>
          )}

          {task.status === "running" && (task.kind === "portfolio_import_stream" || task.kind === "plaid_refresh") && (
            <Button
              variant="none"
              effect="fade"
              size="icon"
              className="h-8 w-8"
              disabled={!vaultOwnerToken || isBusy}
              onClick={() =>
                onAction(task.taskId, async () => {
                  if (task.kind === "portfolio_import_stream") await onCancelImport(task);
                  else await onCancelPlaid(task);
                })
              }
              aria-label={task.kind === "plaid_refresh" ? "Cancel refresh" : "Cancel import"}
            >
              <Icon icon={X} size="xs" />
            </Button>
          )}

          {task.status !== "running" && (
            <Button
              variant="none"
              effect="fade"
              size="icon"
              className="h-8 w-8"
              onClick={() => AppBackgroundTaskService.dismissTask(task.taskId)}
              aria-label="Dismiss task"
            >
              <Icon icon={X} size="xs" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function DebateTaskItem({
  task,
  isBusy,
  vaultOwnerToken,
  onOpenAnalysis,
  onAction,
}: {
  task: DebateRunTask;
  isBusy: boolean;
  vaultOwnerToken: string | null;
  onOpenAnalysis: (runId: string) => void;
  onAction: (taskId: string, action: () => Promise<void>) => void;
}) {
  return (
    <div className="px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon status={task.status} />
            <span className="text-sm font-semibold">{task.ticker}</span>
            <span className="text-xs text-muted-foreground">{statusLabel(task.status)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Started {new Date(task.startedAt).toLocaleTimeString()}
          </p>

          {task.persistenceState === "pending" && (
            <p className="mt-1 text-xs text-amber-500">Saving to history…</p>
          )}
          {task.persistenceState === "failed" && (
            <p className="mt-1 text-xs text-rose-500">
              {task.persistenceError || "History save failed."}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="none"
            effect="fade"
            size="icon"
            className="h-8 w-8"
            onClick={() => onOpenAnalysis(task.runId)}
            aria-label="Open analysis"
          >
            <Icon icon={ExternalLink} size="xs" />
          </Button>

          {task.status === "running" ? (
            <Button
              variant="none"
              effect="fade"
              size="icon"
              className="h-8 w-8"
              disabled={!vaultOwnerToken || isBusy}
              onClick={() =>
                onAction(task.runId, async () => {
                  if (vaultOwnerToken) {
                    await DebateRunManagerService.cancelRun({
                      runId: task.runId,
                      userId: task.userId,
                      vaultOwnerToken,
                    });
                  }
                })
              }
              aria-label="Cancel run"
            >
              <Icon icon={X} size="xs" />
            </Button>
          ) : task.persistenceState === "failed" ? (
            <Button
              variant="none"
              effect="fade"
              size="icon"
              className="h-8 w-8"
              disabled={isBusy}
              onClick={() =>
                onAction(task.runId, () => DebateRunManagerService.retryTaskPersistence(task.runId))
              }
              aria-label="Retry save"
            >
              <Icon icon={RotateCw} size="xs" />
            </Button>
          ) : null}

          {task.status !== "running" && (
            <Button
              variant="none"
              effect="fade"
              size="icon"
              className="h-8 w-8"
              onClick={() => DebateRunManagerService.dismissTask(task.runId)}
              aria-label="Dismiss task"
            >
              <Icon icon={X} size="xs" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main Component ---

type NotificationItem =
  | { kind: "debate"; id: string; sortAt: number; task: DebateRunTask }
  | { kind: "app"; id: string; sortAt: number; task: AppBackgroundTask };

interface DebateTaskCenterProps {
  triggerClassName?: string;
  renderTrigger?: (state: { activeCount: number; badgeCount: number }) => ReactElement;
}

export function DebateTaskCenter({ triggerClassName, renderTrigger }: DebateTaskCenterProps = {}) {
  const router = useRouter();
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();

  const [debateState, setDebateState] = useState(DebateRunManagerService.getState());
  const [appTaskState, setAppTaskState] = useState(AppBackgroundTaskService.getState());
  const [isBusy, setIsBusy] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [showPassiveActivity, setShowPassiveActivity] = useState(false);

  useEffect(() => DebateRunManagerService.subscribe(setDebateState), []);
  useEffect(() => AppBackgroundTaskService.subscribe(setAppTaskState), []);

  const debateTasks = useMemo(() => {
    if (!userId) return [];
    return debateState.tasks.filter((task) => task.userId === userId && !task.dismissedAt);
  }, [debateState.tasks, userId]);

  // Consolidate array iterations to prevent memory churn
  const { primaryAppTasks, passiveAppTasks, runningAppCount, completedAppCount } = useMemo(() => {
    if (!userId) return { primaryAppTasks: [], passiveAppTasks: [], runningAppCount: 0, completedAppCount: 0 };

    const primary: AppBackgroundTask[] = [];
    const passive: AppBackgroundTask[] = [];
    let running = 0;
    let completed = 0;

    appTaskState.tasks.forEach((task) => {
      if (task.userId === userId && !task.dismissedAt && isAppBackgroundTaskVisible(task)) {
        if (task.status === "running") running++;
        else completed++;

        if (task.visibility === "passive") passive.push(task);
        else primary.push(task);
      }
    });

    return { primaryAppTasks: primary, passiveAppTasks: passive, runningAppCount: running, completedAppCount: completed };
  }, [appTaskState.tasks, userId]);

  const notifications = useMemo<NotificationItem[]>(() => {
    const items: NotificationItem[] = [
      ...debateTasks.map((task) => ({
        kind: "debate" as const,
        id: task.runId,
        sortAt: Date.parse(task.updatedAt || task.startedAt),
        task,
      })),
      ...primaryAppTasks.map((task) => ({
        kind: "app" as const,
        id: task.taskId,
        sortAt: Date.parse(task.updatedAt || task.startedAt),
        task,
      })),
    ];
    return items.sort((a, b) => b.sortAt - a.sortAt);
  }, [primaryAppTasks, debateTasks]);

  const runningDebateCount = debateTasks.filter((t) => t.status === "running").length;
  const activeCount = runningDebateCount + runningAppCount;
  const badgeCount = activeCount + (debateTasks.length - runningDebateCount) + completedAppCount;

  const openAnalysis = (focusRunId?: string | null) => {
    const runId = focusRunId?.trim() || debateTasks.find((t) => t.status === "running")?.runId;
    if (runId) {
      router.push(`/kai/analysis?focus=active&run_id=${runId}`);
    } else {
      router.push("/kai/analysis");
    }
  };

  const runAction = async (taskId: string, action: () => Promise<void>) => {
    setIsBusy((prev) => ({ ...prev, [taskId]: true }));
    try {
      await action();
    } finally {
      setIsBusy((prev) => ({ ...prev, [taskId]: false }));
    }
  };

  const cancelPortfolioImportTask = async (task: AppBackgroundTask) => {
    const snapshot = readImportSnapshot();
    if (snapshot?.runId && snapshot.userId === task.userId && vaultOwnerToken) {
      await ApiService.cancelPortfolioImportRun({
        runId: snapshot.runId.trim(),
        userId: task.userId,
        vaultOwnerToken,
      });
    }
    removeSessionItem(IMPORT_BACKGROUND_SNAPSHOT_KEY);
    AppBackgroundTaskService.dismissTask(task.taskId);
  };

  const cancelPlaidRefreshTask = async (task: AppBackgroundTask) => {
    if (!vaultOwnerToken) return;
    const metadata = task.metadata as Record<string, unknown> | null;
    const runIds = Array.isArray(metadata?.runIds) ? metadata.runIds.map(String).filter(Boolean) : [];

    await Promise.all(
      runIds.map((runId) =>
        PlaidPortfolioService.cancelRefreshRun({ userId: task.userId, runId, vaultOwnerToken })
      )
    );
    AppBackgroundTaskService.cancelTask(task.taskId, "Plaid refresh canceled.");
  };

  if (!userId) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        {renderTrigger ? (
          renderTrigger({ activeCount, badgeCount })
        ) : (
          <button
            className={cn("relative grid h-10 w-10 place-items-center rounded-full", triggerClassName)}
            aria-label="Notifications"
          >
            {activeCount > 0 ? (
              <Loader2 className="h-5 w-5 animate-spin text-sky-500" />
            ) : (
              <Bell className="h-5 w-5" />
            )}
            {badgeCount > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-white">
                {badgeCount}
              </span>
            )}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME}>
        <div className={TOP_SHELL_DROPDOWN_HEADER_CLASSNAME}>
          <p className="text-sm font-semibold text-foreground">Notifications</p>
        </div>

        <div className={TOP_SHELL_DROPDOWN_BODY_CLASSNAME}>
          {notifications.length === 0 && passiveAppTasks.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">No notifications yet.</div>
          ) : (
            <div className="divide-y divide-border/45">
              {notifications.map((item) =>
                item.kind === "debate" ? (
                  <DebateTaskItem
                    key={item.id}
                    task={item.task}
                    isBusy={!!isBusy[item.task.runId]}
                    vaultOwnerToken={vaultOwnerToken}
                    onOpenAnalysis={openAnalysis}
                    onAction={runAction}
                  />
                ) : (
                  <AppTaskItem
                    key={item.id}
                    task={item.task}
                    isBusy={!!isBusy[item.task.taskId]}
                    vaultOwnerToken={vaultOwnerToken}
                    onCancelImport={cancelPortfolioImportTask}
                    onCancelPlaid={cancelPlaidRefreshTask}
                    onAction={runAction}
                  />
                )
              )}

              {passiveAppTasks.length > 0 && (
                <div className="px-3 py-2.5">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border/50 bg-muted/24 px-3 py-2 text-left"
                    onClick={() => setShowPassiveActivity((prev) => !prev)}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">Background activity</p>
                      <p className="text-xs text-muted-foreground">Small refreshes stay here unless something needs your attention.</p>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium">
                        {passiveAppTasks.length}
                      </span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform", showPassiveActivity && "rotate-180")} />
                    </div>
                  </button>
                  {showPassiveActivity && (
                    <div className="mt-2 divide-y divide-border/45 rounded-2xl border border-border/45 bg-background/55">
                      {passiveAppTasks.map((task) => (
                        <AppTaskItem
                          key={task.taskId}
                          task={task}
                          isBusy={!!isBusy[task.taskId]}
                          vaultOwnerToken={vaultOwnerToken}
                          onCancelImport={cancelPortfolioImportTask}
                          onCancelPlaid={cancelPlaidRefreshTask}
                          onAction={runAction}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}