"use client";

import { type ReactElement, useEffect, useMemo, useState, memo } from "react";
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
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/button";
import {
  TOP_SHELL_DROPDOWN_BODY_CLASSNAME,
  TOP_SHELL_DROPDOWN_HEADER_CLASSNAME,
  TopShellDropdownContent,
} from "@/components/app-ui/top-shell-dropdown";
import {
  DropdownMenu,
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

// =============================================================================
// TYPE DEFINITIONS & LOGIC INTERFACES (Placed at top to resolve type errors)
// =============================================================================

export interface DebateTaskCenterProps {
  triggerClassName?: string;
  renderTrigger?: (state: { activeCount: number; badgeCount: number }) => ReactElement;
}

interface ImportBackgroundSnapshot {
  taskId?: string | null;
  runId?: string | null;
  status?: string;
  userId?: string;
}

type NotificationItem =
  | { kind: "debate"; id: string; sortAt: number; task: DebateRunTask }
  | { kind: "app"; id: string; sortAt: number; task: AppBackgroundTask };

// =============================================================================
// GLOBAL CORE UTILS & CONSTANT KEYS
// =============================================================================

const DEFAULT_TRIGGER_CLASSNAME = "relative grid h-10 w-10 place-items-center rounded-full";
const IMPORT_BACKGROUND_SNAPSHOT_KEY = "kai_portfolio_import_background_v1";
const BACKGROUND_TASK_DEBUG_KEY = "debug_app_background_tasks";

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

// =============================================================================
// SUB-COMPONENT MODULE: HOVER ROW ITEM (Memoized to isolate render performance)
// =============================================================================

const AppTaskRowItem = memo(function AppTaskRowItem({
  task,
  showDiagnostics,
  vaultOwnerToken,
  isBusy,
  onCancelImport,
  onCancelPlaid,
}: {
  task: AppBackgroundTask;
  showDiagnostics: boolean;
  vaultOwnerToken: string | null;
  isBusy: boolean;
  onCancelImport: (task: AppBackgroundTask) => Promise<void>;
  onCancelPlaid: (task: AppBackgroundTask) => Promise<void>;
}) {
  const router = useRouter();
  
  const progressPct = useMemo(() => {
    const metadata = task.metadata && typeof task.metadata === "object" ? (task.metadata as Record<string, any>) : null;
    if (typeof metadata?.progress === "number") {
      return Math.min(100, Math.max(0, metadata.progress));
    }
    return task.status === "completed" ? 100 : null;
  }, [task.metadata, task.status]);

  const statusItems = useMemo(() => {
    const metadata = task.metadata && typeof task.metadata === "object" ? (task.metadata as Record<string, any>) : null;
    if (!Array.isArray(metadata?.statusItems)) return [];
    return metadata.statusItems.map((item: any) => String(item || "").trim()).filter(Boolean).slice(0, 5);
  }, [task.metadata]);

  const timingSummary = useMemo(() => {
    const metadata = task.metadata && typeof task.metadata === "object" ? (task.metadata as Record<string, any>) : null;
    const timings = metadata?.timings && typeof metadata.timings === "object" ? metadata.timings : null;
    if (!timings) return null;
    
    const parts = [
      typeof timings.totalMs === "number" ? `Total ${Math.round(timings.totalMs)}ms` : null,
      typeof timings.manifestReadMs === "number" ? `manifest ${Math.round(timings.manifestReadMs)}ms` : null,
      typeof timings.decryptLoadMs === "number" ? `unlock ${Math.round(timings.decryptLoadMs)}ms` : null,
      typeof timings.transformMs === "number" ? `rebuild ${Math.round(timings.transformMs)}ms` : null,
    ].filter((item): item is string => typeof item === "string");
    
    return parts.join(" • ");
  }, [task.metadata]);

  return (
    <div className="px-3 py-3 transition-colors hover:bg-muted/10" role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
            {task.status === "running" ? (
              <Icon icon={Loader2} size="sm" className="animate-spin text-sky-500 shrink-0" />
            ) : task.status === "completed" ? (
              <Icon icon={CheckCircle2} size="sm" className="text-emerald-500 shrink-0" />
            ) : task.status === "canceled" ? (
              <Icon icon={Ban} size="sm" className="text-amber-500 shrink-0" />
            ) : (
              <Icon icon={XCircle} size="sm" className="text-rose-500 shrink-0" />
            )}
            <span className="text-sm font-semibold truncate text-foreground">{task.title}</span>
            <span className="text-xs text-muted-foreground capitalize">{task.status}</span>
          </div>
          
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{task.description}</p>
          
          {task.status === "running" && progressPct !== null && (
            <div className="mt-2 w-full max-w-xs bg-muted rounded-full h-1 overflow-hidden">
              <div className="bg-sky-500 h-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
            </div>
          )}

          {showDiagnostics && (
            <div className="mt-1.5 space-y-0.5">
              {statusItems.map((item: string) => (
                <p key={item} className="text-[11px] text-muted-foreground/80 font-mono select-all">› {item}</p>
              ))}
              {timingSummary && <p className="text-[11px] text-slate-500 font-mono">{timingSummary}</p>}
              {task.error && <p className="text-xs text-rose-500 font-medium select-all mt-1">{task.error}</p>}
            </div>
          )}
          
          <p className="mt-1.5 text-[10px] text-muted-foreground/70">
            Started {new Date(task.startedAt).toLocaleTimeString()}
          </p>
        </div>

        <div className="flex items-center gap-0.5 shrink-0 ml-1">
          {task.routeHref && (
            <Button
              variant="none" effect="fade" size="icon" className="h-8 w-8"
              onClick={() => router.push(task.routeHref!)} aria-label="Open related layout screen view"
            >
              <Icon icon={ExternalLink} size="xs" />
            </Button>
          )}
          {task.status === "running" && (task.kind === "portfolio_import_stream" || task.kind === "plaid_refresh") ? (
            <Button
              variant="none" effect="fade" size="icon" className="h-8 w-8 text-muted-foreground hover:text-rose-400"
              disabled={!vaultOwnerToken || isBusy}
              onClick={() => task.kind === "portfolio_import_stream" ? onCancelImport(task) : onCancelPlaid(task)}
              aria-label="Terminate execution background container thread"
            >
              <Icon icon={X} size="xs" />
            </Button>
          ) : task.status !== "running" ? (
            <Button
              variant="none" effect="fade" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => AppBackgroundTaskService.dismissTask(task.taskId)} aria-label="Dismiss completed task item metadata node"
            >
              <Icon icon={X} size="xs" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

// =============================================================================
// MAIN NOTIFICATION HUB DRAWER CONTAINER EXPORT
// =============================================================================

export function DebateTaskCenter({ triggerClassName, renderTrigger }: DebateTaskCenterProps = {}) {
  const router = useRouter();
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  
  const [debateState, setDebateState] = useState(DebateRunManagerService.getState());
  const [appTaskState, setAppTaskState] = useState(AppBackgroundTaskService.getState());
  const [isBusy, setIsBusy] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [showPassiveActivity, setShowPassiveActivity] = useState(false);

  const showDiagnostics = useMemo(() => getSessionItem(BACKGROUND_TASK_DEBUG_KEY) === "true", []);

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

  const visibleAppTasks = useMemo(() => appTasks.filter(isAppBackgroundTaskVisible), [appTasks]);
  const primaryAppTasks = useMemo(() => visibleAppTasks.filter((t) => t.visibility !== "passive"), [visibleAppTasks]);
  const passiveAppTasks = useMemo(() => visibleAppTasks.filter((t) => t.visibility === "passive"), [visibleAppTasks]);

  const notifications = useMemo<NotificationItem[]>(() => {
    const debateNotifications = debateTasks.map((task) => ({
      kind: "debate" as const,
      id: task.runId,
      sortAt: Date.parse(task.updatedAt || task.startedAt),
      task,
    }));
    const appNotifications = primaryAppTasks.map((task) => ({
      kind: "app" as const,
      id: task.taskId,
      sortAt: Date.parse(task.updatedAt || task.startedAt),
      task,
    }));
    return [...debateNotifications, ...appNotifications].sort((a, b) => b.sortAt - a.sortAt);
  }, [primaryAppTasks, debateTasks]);

  const activeCount =
    debateTasks.filter((task) => task.status === "running").length +
    visibleAppTasks.filter((task) => task.status === "running").length;

  const completedCount =
    debateTasks.filter((task) => task.status !== "running").length +
    visibleAppTasks.filter((task) => task.status !== "running").length;

  const badgeCount = activeCount + completedCount;

  const latestActiveTask = useMemo(() => {
    return debateTasks
      .filter((task) => task.status === "running")
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  }, [debateTasks]);

  const openAnalysis = (focusRunId?: string | null) => {
    const normalizedRunId = typeof focusRunId === "string" ? focusRunId.trim() : "";
    const params = new URLSearchParams();
    params.set("focus", "active");
    
    if (normalizedRunId) {
      params.set("run_id", normalizedRunId);
      router.push(`/kai/analysis?${params.toString()}`);
    } else if (latestActiveTask) {
      params.set("run_id", latestActiveTask.runId);
      router.push(`/kai/analysis?${params.toString()}`);
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
    const raw = getSessionItem(IMPORT_BACKGROUND_SNAPSHOT_KEY);
    if (raw && vaultOwnerToken) {
      try {
        const snapshot = JSON.parse(raw) as ImportBackgroundSnapshot;
        if (snapshot?.userId === task.userId && snapshot?.taskId === task.taskId && snapshot?.runId) {
          await ApiService.cancelPortfolioImportRun({
            runId: snapshot.runId.trim(),
            userId: task.userId,
            vaultOwnerToken,
          });
        }
      } catch (e) {
        console.error("Failed to map background processing state parameter keys", e);
      }
    }
    removeSessionItem(IMPORT_BACKGROUND_SNAPSHOT_KEY);
    AppBackgroundTaskService.dismissTask(task.taskId);
  };

  const cancelPlaidRefreshTask = async (task: AppBackgroundTask) => {
    if (!vaultOwnerToken) return;
    const metadata = task.metadata && typeof task.metadata === "object" ? (task.metadata as Record<string, any>) : null;
    const runIds = Array.isArray(metadata?.runIds) ? metadata.runIds.map((v: any) => String(v || "").trim()).filter(Boolean) : [];
    
    for (const runId of runIds) {
      await PlaidPortfolioService.cancelRefreshRun({ userId: task.userId, runId, vaultOwnerToken });
    }
    AppBackgroundTaskService.cancelTask(task.taskId, "Plaid refresh canceled.");
  };

  const handleDismissAllCompleted = () => {
    debateTasks.forEach((t) => {
      if (t.status !== "running") DebateRunManagerService.dismissTask(t.runId);
    });
    visibleAppTasks.forEach((t) => {
      if (t.status !== "running") AppBackgroundTaskService.dismissTask(t.taskId);
    });
  };

  if (!userId) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        {renderTrigger ? (
          renderTrigger({ activeCount, badgeCount })
        ) : (
          <button className={cn(DEFAULT_TRIGGER_CLASSNAME, triggerClassName)} aria-label="Open activity logs dashboard">
            {activeCount > 0 ? (
              <Loader2 className="h-5 w-5 animate-spin text-sky-500" />
            ) : (
              <Bell className="h-5 w-5" />
            )}
            {badgeCount > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-white shadow">
                {badgeCount}
              </span>
            )}
          </button>
        )}
      </DropdownMenuTrigger>
      
      <TopShellDropdownContent align="end">
        <div className={cn(TOP_SHELL_DROPDOWN_HEADER_CLASSNAME, "flex items-center justify-between gap-4")}>
          <p className="text-sm font-bold text-foreground">Activity Notifications</p>
          {completedCount > 0 && (
            <Button
              variant="none" effect="fade" size="sm" 
              className="text-xs h-7 text-muted-foreground hover:text-rose-400 gap-1 px-1.5 font-medium cursor-pointer"
              onClick={handleDismissAllCompleted}
            >
              <Trash2 className="h-3 w-3" /> Clear Finished
            </Button>
          )}
        </div>

        <div className={TOP_SHELL_DROPDOWN_BODY_CLASSNAME}>
          {notifications.length === 0 && passiveAppTasks.length === 0 ? (
            <div className="px-4 py-8 text-sm text-center text-muted-foreground">
              No active notification lines or tasks found.
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {notifications.map((item) =>
                item.kind === "debate" ? (
                  <div key={item.id} className="px-3 py-3 transition-colors hover:bg-muted/10">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
                          {statusIcon(item.task)}
                          <span className="text-sm font-semibold text-foreground truncate">{item.task.ticker}</span>
                          <span className="text-xs text-muted-foreground lowercase">
                            {statusLabel(item.task)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Started {new Date(item.task.startedAt).toLocaleTimeString()}
                        </p>
                        {item.task.persistenceState === "pending" && <p className="mt-1 text-xs text-amber-500 animate-pulse">Saving metrics context to history core...</p>}
                        {item.task.persistenceState === "failed" && (
                          <p className="mt-1 text-xs text-rose-500 font-medium select-all">{item.task.persistenceError || "History synchronization error logs."}</p>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-0.5 shrink-0 ml-1">
                        <Button
                          variant="none" effect="fade" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => openAnalysis(item.task.runId)} aria-label="Open analytical tracking view pane"
                        >
                          <Icon icon={ExternalLink} size="xs" />
                        </Button>
                        {item.task.status === "running" ? (
                          <Button
                            variant="none" effect="fade" size="icon" className="h-8 w-8 text-muted-foreground hover:text-rose-500"
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
                            aria-label="Terminate processing calculation link"
                          >
                            <Icon icon={X} size="xs" />
                          </Button>
                        ) : item.task.persistenceState === "failed" ? (
                          <Button
                            variant="none" effect="fade" size="icon" className="h-8 w-8 text-muted-foreground hover:text-cyan-400"
                            disabled={Boolean(isBusy[item.task.runId])}
                            onClick={() =>
                              runAction(item.task.runId, async () => {
                                await DebateRunManagerService.retryTaskPersistence(item.task.runId);
                              })
                            }
                            aria-label="Re-execute file saving parameters handshakes"
                          >
                            <Icon icon={RotateCw} size="xs" />
                          </Button>
                        ) : (
                          <Button
                            variant="none" effect="fade" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={() => DebateRunManagerService.dismissTask(item.task.runId)} aria-label="Dismiss row entry notification"
                          >
                            <Icon icon={X} size="xs" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <AppTaskRowItem
                    key={item.id}
                    task={item.task}
                    showDiagnostics={showDiagnostics}
                    vaultOwnerToken={vaultOwnerToken}
                    isBusy={Boolean(isBusy[item.task.taskId])}
                    onCancelImport={cancelPortfolioImportTask}
                    onCancelPlaid={cancelPlaidRefreshTask}
                  />
                )
              )}
              
              {passiveAppTasks.length > 0 && (
                <div className="px-3 py-2.5 bg-muted/5">
                  <button
                    type="button" aria-expanded={showPassiveActivity}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border/40 bg-muted/10 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
                    onClick={() => setShowPassiveActivity((v) => !v)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-foreground uppercase tracking-wider">Routine Background Activity</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-normal">System micro-actions and database synchronization threads processing cleanly.</p>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground shrink-0 ml-1">
                      <span className="rounded-full bg-slate-800 border border-border/50 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                        {passiveAppTasks.length}
                      </span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", showPassiveActivity && "rotate-180")} />
                    </div>
                  </button>
                  {showPassiveActivity && (
                    <div className="mt-2 divide-y divide-border/40 rounded-2xl border border-border/40 bg-background/50 overflow-hidden animate-fade-in">
                      {passiveAppTasks.map((task) => (
                        <AppTaskRowItem
                          key={task.taskId}
                          task={task}
                          showDiagnostics={showDiagnostics}
                          vaultOwnerToken={vaultOwnerToken}
                          isBusy={Boolean(isBusy[task.taskId])}
                          onCancelImport={cancelPortfolioImportTask}
                          onCancelPlaid={cancelPlaidRefreshTask}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </TopShellDropdownContent>
    </DropdownMenu>
  );
}