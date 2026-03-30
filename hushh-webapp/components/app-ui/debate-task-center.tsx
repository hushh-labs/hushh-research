"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
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
  TOP_SHELL_DROPDOWN_FOOTER_CLASSNAME,
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
} from "@/lib/services/app-background-task-service";
import { ApiService } from "@/lib/services/api-service";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { getSessionItem, removeSessionItem } from "@/lib/utils/session-storage";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";

function statusLabel(task: DebateRunTask): string {
  if (task.status === "running") return "Running";
  if (task.status === "completed") return "Completed";
  if (task.status === "failed") return "Failed";
  return "Canceled";
}

function statusIcon(task: DebateRunTask) {
  if (task.status === "running") {
    return <Icon icon={Loader2} size="sm" className="animate-spin text-sky-500" />;
  }
  if (task.status === "completed") {
    return <Icon icon={CheckCircle2} size="sm" className="text-emerald-500" />;
  }
  if (task.status === "failed") {
    return <Icon icon={XCircle} size="sm" className="text-rose-500" />;
  }
  return <Icon icon={Ban} size="sm" className="text-amber-500" />;
}

function appTaskStatusLabel(task: AppBackgroundTask): string {
  if (task.status === "running") return "Running";
  if (task.status === "completed") return "Completed";
  if (task.status === "canceled") return "Canceled";
  return "Failed";
}

function appTaskStatusIcon(task: AppBackgroundTask) {
  if (task.status === "running") {
    return <Icon icon={Loader2} size="sm" className="animate-spin text-sky-500" />;
  }
  if (task.status === "completed") {
    return <Icon icon={CheckCircle2} size="sm" className="text-emerald-500" />;
  }
  if (task.status === "canceled") {
    return <Icon icon={Ban} size="sm" className="text-amber-500" />;
  }
  return <Icon icon={XCircle} size="sm" className="text-rose-500" />;
}

interface DebateTaskCenterProps {
  triggerClassName?: string;
}

const DEFAULT_TRIGGER_CLASSNAME =
  "relative grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-background/70 shadow-sm backdrop-blur-sm transition-colors hover:bg-muted/50 active:bg-muted/80";
const IMPORT_BACKGROUND_SNAPSHOT_KEY = "kai_portfolio_import_background_v1";

interface ImportBackgroundSnapshot {
  taskId?: string | null;
  runId?: string | null;
  status?: string;
  userId?: string;
}

type NotificationItem =
  | {
      kind: "debate";
      id: string;
      sortAt: number;
      task: DebateRunTask;
    }
  | {
      kind: "app";
      id: string;
      sortAt: number;
      task: AppBackgroundTask;
    };

export function DebateTaskCenter({ triggerClassName }: DebateTaskCenterProps = {}) {
  const router = useRouter();
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [debateState, setDebateState] = useState(DebateRunManagerService.getState());
  const [appTaskState, setAppTaskState] = useState(AppBackgroundTaskService.getState());
  const [isBusy, setIsBusy] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return DebateRunManagerService.subscribe(setDebateState);
  }, []);

  useEffect(() => {
    return AppBackgroundTaskService.subscribe(setAppTaskState);
  }, []);

  const debateTasks = useMemo(() => {
    if (!userId) return [];
    return debateState.tasks.filter((task) => task.userId === userId && !task.dismissedAt);
  }, [debateState.tasks, userId]);

  const appTasks = useMemo(() => {
    if (!userId) return [];
    return appTaskState.tasks.filter((task) => task.userId === userId && !task.dismissedAt);
  }, [appTaskState.tasks, userId]);

  const notifications = useMemo<NotificationItem[]>(() => {
    const debateNotifications = debateTasks.map((task) => ({
      kind: "debate" as const,
      id: task.runId,
      sortAt: Date.parse(task.updatedAt || task.startedAt),
      task,
    }));
    const appNotifications = appTasks.map((task) => ({
      kind: "app" as const,
      id: task.taskId,
      sortAt: Date.parse(task.updatedAt || task.startedAt),
      task,
    }));
    return [...debateNotifications, ...appNotifications].sort((a, b) => b.sortAt - a.sortAt);
  }, [appTasks, debateTasks]);

  const activeCount =
    debateTasks.filter((task) => task.status === "running").length +
    appTasks.filter((task) => task.status === "running").length;
  const completedCount =
    debateTasks.filter((task) => task.status !== "running").length +
    appTasks.filter((task) => task.status !== "running").length;
  const badgeCount = activeCount + completedCount;
  const latestActiveTask = useMemo(() => {
    return debateTasks
      .filter((task) => task.status === "running")
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  }, [debateTasks]);

  const openAnalysis = (focusRunId?: string | null) => {
    const normalizedRunId = typeof focusRunId === "string" ? focusRunId.trim() : "";
    if (normalizedRunId) {
      const params = new URLSearchParams();
      params.set("focus", "active");
      params.set("run_id", normalizedRunId);
      router.push(`/kai/analysis?${params.toString()}`);
      return;
    }
    if (latestActiveTask) {
      const params = new URLSearchParams();
      params.set("focus", "active");
      params.set("run_id", latestActiveTask.runId);
      router.push(`/kai/analysis?${params.toString()}`);
      return;
    }
    router.push("/kai/analysis");
  };

  const runAction = async (taskId: string, action: () => Promise<void>) => {
    setIsBusy((prev) => ({ ...prev, [taskId]: true }));
    try {
      await action();
    } finally {
      setIsBusy((prev) => ({ ...prev, [taskId]: false }));
    }
  };

  const readImportSnapshot = (): ImportBackgroundSnapshot | null => {
    const raw = getSessionItem(IMPORT_BACKGROUND_SNAPSHOT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ImportBackgroundSnapshot;
    } catch {
      return null;
    }
  };

  const cancelPortfolioImportTask = async (task: AppBackgroundTask) => {
    const snapshot = readImportSnapshot();
    if (
      snapshot &&
      snapshot.userId === task.userId &&
      snapshot.taskId === task.taskId &&
      typeof snapshot.runId === "string" &&
      snapshot.runId.trim().length > 0 &&
      vaultOwnerToken
    ) {
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
    const metadata =
      task.metadata && typeof task.metadata === "object"
        ? (task.metadata as Record<string, unknown>)
        : null;
    const runIds = Array.isArray(metadata?.runIds)
      ? metadata.runIds
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [];
    for (const runId of runIds) {
      await PlaidPortfolioService.cancelRefreshRun({
        userId: task.userId,
        runId,
        vaultOwnerToken,
      });
    }
    AppBackgroundTaskService.cancelTask(task.taskId, "Plaid refresh canceled.");
  };

  if (!userId) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(DEFAULT_TRIGGER_CLASSNAME, triggerClassName)}
          aria-label="Notifications"
        >
          {activeCount > 0 ? (
            <Icon icon={Loader2} size="sm" className="animate-spin text-sky-500" />
          ) : (
            <Icon icon={Bell} size="sm" />
          )}
          {badgeCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-white">
              {badgeCount}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME}>
        <div className={TOP_SHELL_DROPDOWN_HEADER_CLASSNAME}>
          <p className="text-sm font-semibold text-foreground">Notifications</p>
        </div>

        <div className={TOP_SHELL_DROPDOWN_BODY_CLASSNAME}>
          {notifications.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">
              No notifications yet.
            </div>
          ) : (
            <div className="divide-y divide-border/45">
              {notifications.map((item) =>
                item.kind === "debate" ? (
                  <div key={item.id} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {statusIcon(item.task)}
                          <span className="text-sm font-semibold">{item.task.ticker}</span>
                          <span className="text-xs text-muted-foreground">
                            {statusLabel(item.task)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Started {new Date(item.task.startedAt).toLocaleTimeString()}
                        </p>
                        {item.task.persistenceState === "pending" ? (
                          <p className="mt-1 text-xs text-amber-500">Saving to history…</p>
                        ) : null}
                        {item.task.persistenceState === "failed" ? (
                          <p className="mt-1 text-xs text-rose-500">
                            {item.task.persistenceError || "History save failed."}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="none"
                          effect="fade"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openAnalysis(item.task.runId)}
                          aria-label="Open analysis"
                        >
                          <Icon icon={ExternalLink} size="xs" />
                        </Button>
                        {item.task.status === "running" ? (
                          <Button
                            variant="none"
                            effect="fade"
                            size="icon"
                            className="h-8 w-8"
                            disabled={!vaultOwnerToken || Boolean(isBusy[item.task.runId])}
                            onClick={() =>
                              runAction(item.task.runId, async () => {
                                if (!vaultOwnerToken) return;
                                await DebateRunManagerService.cancelRun({
                                  runId: item.task.runId,
                                  userId: item.task.userId,
                                  vaultOwnerToken,
                                });
                              })
                            }
                            aria-label="Cancel run"
                          >
                            <Icon icon={X} size="xs" />
                          </Button>
                        ) : item.task.persistenceState === "failed" ? (
                          <Button
                            variant="none"
                            effect="fade"
                            size="icon"
                            className="h-8 w-8"
                            disabled={Boolean(isBusy[item.task.runId])}
                            onClick={() =>
                              runAction(item.task.runId, async () => {
                                await DebateRunManagerService.retryTaskPersistence(item.task.runId);
                              })
                            }
                            aria-label="Retry save"
                          >
                            <Icon icon={RotateCw} size="xs" />
                          </Button>
                        ) : null}
                        {item.task.status !== "running" ? (
                          <Button
                            variant="none"
                            effect="fade"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => DebateRunManagerService.dismissTask(item.task.runId)}
                            aria-label="Dismiss task"
                          >
                            <Icon icon={X} size="xs" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={item.id} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {appTaskStatusIcon(item.task)}
                          <span className="text-sm font-semibold">{item.task.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {appTaskStatusLabel(item.task)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.task.description}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Started {new Date(item.task.startedAt).toLocaleTimeString()}
                        </p>
                        {item.task.error ? (
                          <p className="mt-1 text-xs text-rose-500">{item.task.error}</p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1">
                        {item.task.routeHref ? (
                          <Button
                            variant="none"
                            effect="fade"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => {
                              const routeHref = item.task.routeHref;
                              if (!routeHref) return;
                              router.push(routeHref);
                            }}
                            aria-label="Open related screen"
                          >
                            <Icon icon={ExternalLink} size="xs" />
                          </Button>
                        ) : null}
                        {item.task.status === "running" &&
                        (item.task.kind === "portfolio_import_stream" ||
                          item.task.kind === "plaid_refresh") ? (
                          <Button
                            variant="none"
                            effect="fade"
                            size="icon"
                            className="h-8 w-8"
                            disabled={!vaultOwnerToken || Boolean(isBusy[item.task.taskId])}
                            onClick={() =>
                              runAction(item.task.taskId, async () => {
                                if (item.task.kind === "portfolio_import_stream") {
                                  await cancelPortfolioImportTask(item.task);
                                  return;
                                }
                                await cancelPlaidRefreshTask(item.task);
                              })
                            }
                            aria-label={
                              item.task.kind === "plaid_refresh" ? "Cancel refresh" : "Cancel import"
                            }
                          >
                            <Icon icon={X} size="xs" />
                          </Button>
                        ) : null}
                        {item.task.status !== "running" ? (
                          <Button
                            variant="none"
                            effect="fade"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => AppBackgroundTaskService.dismissTask(item.task.taskId)}
                            aria-label="Dismiss task"
                          >
                            <Icon icon={X} size="xs" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {debateTasks.length > 0 ? (
          <div className={TOP_SHELL_DROPDOWN_FOOTER_CLASSNAME}>
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => openAnalysis(latestActiveTask?.runId)}
            >
              Open analysis workspace
            </button>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
