"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PortfolioData } from "@/components/kai/types/portfolio";
import { ROUTES } from "@/lib/navigation/routes";
import {
  hasPortfolioHoldings,
  resolveAvailableSources,
  resolvePortfolioFreshness,
  type PlaidPortfolioStatusResponse,
  type PortfolioFreshness,
  type PortfolioSource,
  type StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";
import {
  buildFinancialDomainSummary,
  getActiveSource as getStoredActiveSource,
  getActiveStatementSnapshotId,
  setActivePlaidSource,
  setActiveStatementSnapshot,
} from "@/lib/kai/brokerage/financial-sources";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

interface UsePortfolioSourcesParams {
  userId: string | null | undefined;
  vaultOwnerToken?: string | null;
  vaultKey?: string | null;
  initialStatementPortfolio?: PortfolioData | null;
}

interface RefreshTracking {
  taskId: string;
  runIds: string[];
}

const PLAID_STATUS_POLL_BASE_MS = 4_000;
const PLAID_STATUS_POLL_MAX_MS = 30_000;
const PLAID_STATUS_MAX_ATTEMPTS = 18;

interface PlaidRefreshActionResult {
  status: "started" | "already_running" | "canceled" | "noop";
  runIds: string[];
  taskId?: string | null;
}

export interface UsePortfolioSourcesResult {
  isLoading: boolean;
  error: string | null;
  plaidStatus: PlaidPortfolioStatusResponse | null;
  statementPortfolio: PortfolioData | null;
  plaidPortfolio: PortfolioData | null;
  statementSnapshots: StatementSnapshotOption[];
  activeStatementSnapshotId: string | null;
  activeSource: PortfolioSource;
  availableSources: PortfolioSource[];
  activePortfolio: PortfolioData | null;
  freshness: PortfolioFreshness | null;
  isPlaidRefreshing: boolean;
  changeActiveSource: (nextSource: PortfolioSource) => Promise<void>;
  changeActiveStatementSnapshot: (snapshotId: string) => Promise<void>;
  refreshPlaid: (itemId?: string) => Promise<PlaidRefreshActionResult>;
  cancelPlaidRefresh: (params?: {
    itemId?: string;
    runIds?: string[];
  }) => Promise<PlaidRefreshActionResult>;
  reload: (options?: { force?: boolean }) => Promise<void>;
}

function pickPreferredSource(params: {
  preferred: PortfolioSource | string | null | undefined;
  availableSources: PortfolioSource[];
}): PortfolioSource {
  const preferred = params.preferred;
  if (
    (preferred === "statement" || preferred === "plaid") &&
    params.availableSources.includes(preferred)
  ) {
    return preferred;
  }
  if (params.availableSources.includes("statement")) return "statement";
  if (params.availableSources.includes("plaid")) return "plaid";
  return "statement";
}

function toFinancialDomain(
  value: unknown
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isActiveRunStatus(value: unknown): boolean {
  const status = String(value || "").trim();
  return status === "queued" || status === "running";
}

function collectRunningRunIds(
  plaidStatus: PlaidPortfolioStatusResponse | null,
  itemId?: string
): string[] {
  return (plaidStatus?.items || [])
    .filter((item) => !itemId || item.item_id === itemId)
    .map((item) => item.latest_refresh_run)
    .filter((run) => run && isActiveRunStatus(run.status))
    .map((run) => String(run?.run_id || "").trim())
    .filter(Boolean);
}

function readRefreshTrackingFromTask(
  userId: string | null | undefined
): RefreshTracking | null {
  if (!userId) return null;
  const runningTask = AppBackgroundTaskService.getState().tasks.find((task) => {
    if (task.userId !== userId) return false;
    if (task.kind !== "plaid_refresh") return false;
    if (task.status !== "running") return false;
    if (task.dismissedAt) return false;
    return true;
  });
  if (!runningTask) return null;
  const metadata =
    runningTask.metadata && typeof runningTask.metadata === "object"
      ? (runningTask.metadata as Record<string, unknown>)
      : null;
  const runIds = Array.isArray(metadata?.runIds)
    ? metadata.runIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];
  if (!runIds.length) return null;
  return {
    taskId: runningTask.taskId,
    runIds,
  };
}

function nextPlaidStatusPollDelay(attempt: number): number {
  return Math.min(
    PLAID_STATUS_POLL_MAX_MS,
    PLAID_STATUS_POLL_BASE_MS * Math.max(1, attempt)
  );
}

function isTerminalPlaidRunStatus(value: unknown): boolean {
  const status = String(value || "").trim();
  return status === "completed" || status === "failed" || status === "canceled";
}

export function usePortfolioSources({
  userId,
  vaultOwnerToken,
  vaultKey,
  initialStatementPortfolio = null,
}: UsePortfolioSourcesParams): UsePortfolioSourcesResult {
  const backgroundRefreshTimeoutRef = useRef<number | null>(null);
  const [statementPortfolio, setStatementPortfolio] = useState<PortfolioData | null>(
    initialStatementPortfolio
  );
  const [plaidStatus, setPlaidStatus] = useState<PlaidPortfolioStatusResponse | null>(null);
  const [plaidPortfolio, setPlaidPortfolio] = useState<PortfolioData | null>(null);
  const [statementSnapshots, setStatementSnapshots] = useState<StatementSnapshotOption[]>([]);
  const [activeStatementSnapshotId, setActiveStatementSnapshotId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<PortfolioSource>("statement");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshTracking, setRefreshTracking] = useState<RefreshTracking | null>(null);

  useEffect(() => {
    if (initialStatementPortfolio && hasPortfolioHoldings(initialStatementPortfolio)) {
      setStatementPortfolio(initialStatementPortfolio);
    }
  }, [initialStatementPortfolio]);

  const applyResource = useCallback(
    (resource: Awaited<ReturnType<typeof KaiFinancialResourceService.getStaleFirst>>) => {
      if (!resource) {
        startTransition(() => {
          setStatementPortfolio(null);
          setStatementSnapshots([]);
          setActiveStatementSnapshotId(null);
          setPlaidStatus(null);
          setPlaidPortfolio(null);
          setActiveSource("statement");
        });
        return;
      }

      startTransition(() => {
        setStatementPortfolio(resource.statementPortfolio);
        setStatementSnapshots(resource.statementSnapshots);
        setActiveStatementSnapshotId(resource.activeStatementSnapshotId);
        setPlaidStatus(resource.plaidStatus);
        setPlaidPortfolio(resource.plaidPortfolio);
        setActiveSource(resource.activeSource);
      });
    },
    []
  );

  const refreshDerivedMarketCaches = useCallback(async () => {
    if (!userId) return;
    CacheSyncService.onPlaidSourceProjected(userId);
    if (!vaultKey || !vaultOwnerToken) return;
    await UnlockWarmOrchestrator.run({
      userId,
      vaultKey,
      vaultOwnerToken,
      routePath:
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : undefined,
    }).catch(() => undefined);
  }, [userId, vaultKey, vaultOwnerToken]);

  const hydrateCachedResource = useCallback(async () => {
    if (!userId) return null;

    const memory = KaiFinancialResourceService.peek(userId)?.data ?? null;
    if (memory) {
      applyResource(memory);
      return memory;
    }

    const secure = await KaiFinancialResourceService.hydrateFromSecureCache({
      userId,
      vaultKey,
    });
    if (secure) {
      applyResource(secure);
      return secure;
    }

    return null;
  }, [applyResource, userId, vaultKey]);

  const reload = useCallback(async (options?: { force?: boolean }) => {
    if (!userId || !vaultOwnerToken) {
      startTransition(() => {
        setPlaidStatus(null);
        setPlaidPortfolio(null);
        setStatementSnapshots([]);
        setActiveStatementSnapshotId(null);
        setIsLoading(false);
      });
      return;
    }

    setError(null);
    const cached = options?.force ? null : await hydrateCachedResource();
    setIsLoading(!cached);
    try {
      const resource = options?.force
        ? await KaiFinancialResourceService.refresh({
            userId,
            vaultOwnerToken,
            vaultKey,
            initialStatementPortfolio,
          })
        : await KaiFinancialResourceService.getStaleFirst({
            userId,
            vaultOwnerToken,
            vaultKey,
            initialStatementPortfolio,
            backgroundRefresh: false,
          });
      applyResource(resource);

      if (!options?.force && cached) {
        if (backgroundRefreshTimeoutRef.current) {
          window.clearTimeout(backgroundRefreshTimeoutRef.current);
        }
        backgroundRefreshTimeoutRef.current = window.setTimeout(() => {
          void KaiFinancialResourceService.refresh({
            userId,
            vaultOwnerToken,
            vaultKey,
            initialStatementPortfolio,
          })
            .then((nextResource) => {
              applyResource(nextResource);
            })
            .catch(() => undefined);
        }, 1800);
      }
    } catch (loadError) {
      startTransition(() => {
        setError(loadError instanceof Error ? loadError.message : "Failed to load portfolio sources.");
      });
    } finally {
      startTransition(() => {
        setIsLoading(false);
      });
    }
  }, [applyResource, hydrateCachedResource, initialStatementPortfolio, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimeoutRef.current) {
        window.clearTimeout(backgroundRefreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (refreshTracking || !userId) return;
    const snapshot = readRefreshTrackingFromTask(userId);
    if (!snapshot) return;
    setRefreshTracking(snapshot);
  }, [refreshTracking, userId]);

  const availableSources = useMemo(
    () =>
      resolveAvailableSources({
        statementPortfolio,
        plaidPortfolio,
      }),
    [plaidPortfolio, statementPortfolio]
  );

  useEffect(() => {
    setActiveSource((current) => pickPreferredSource({ preferred: current, availableSources }));
  }, [availableSources]);

  const freshness = useMemo(
    () => resolvePortfolioFreshness(plaidStatus),
    [plaidStatus]
  );
  const trackedRefreshRunIds = useMemo(() => {
    const explicitRunIds = (refreshTracking?.runIds || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (explicitRunIds.length > 0) {
      return explicitRunIds;
    }
    return collectRunningRunIds(plaidStatus);
  }, [plaidStatus, refreshTracking?.runIds]);
  const trackedRefreshRunSignature = useMemo(
    () => trackedRefreshRunIds.join(","),
    [trackedRefreshRunIds]
  );

  const activePortfolio = useMemo(() => {
    if (activeSource === "statement") return statementPortfolio;
    return plaidPortfolio;
  }, [activeSource, plaidPortfolio, statementPortfolio]);

  const changeActiveSource = useCallback(
    async (nextSource: PortfolioSource) => {
      setActiveSource(nextSource);
      if (!userId || !vaultOwnerToken) return;
      await PlaidPortfolioService.setActiveSource({
        userId,
        activeSource: nextSource,
        vaultOwnerToken,
      });
      if (vaultKey) {
        const nowIso = new Date().toISOString();
        const result = await PkmWriteCoordinator.saveMergedDomain({
          userId,
          domain: "financial",
          vaultKey,
          vaultOwnerToken,
          build: (context) => {
            const financial = toFinancialDomain(context.currentDomainData) ?? {};
            const nextFinancial =
              nextSource === "statement"
                ? (() => {
                    const snapshotId = getActiveStatementSnapshotId(financial);
                    return snapshotId
                      ? setActiveStatementSnapshot(financial, snapshotId, nowIso)
                      : null;
                  })()
                : setActivePlaidSource(financial, plaidStatus, nowIso);
            if (!nextFinancial) {
              throw new Error("Unable to switch portfolio source.");
            }
            return {
              domainData: nextFinancial,
              summary: buildFinancialDomainSummary(nextFinancial),
            };
          },
        });
        if (!result.success) {
          throw new Error(result.message || "Unable to switch portfolio source.");
        }
        if (result.success) {
          await refreshDerivedMarketCaches();
        }
      }
      await reload({ force: true });
    },
    [
      plaidStatus,
      refreshDerivedMarketCaches,
      reload,
      userId,
      vaultKey,
      vaultOwnerToken,
    ]
  );

  const changeActiveStatementSnapshot = useCallback(
    async (snapshotId: string) => {
      if (!userId || !vaultOwnerToken || !vaultKey) {
        throw new Error("Unlock your Vault to switch statements.");
      }
      const nowIso = new Date().toISOString();
      await PlaidPortfolioService.setActiveSource({
        userId,
        activeSource: "statement",
        vaultOwnerToken,
      });
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
        build: (context) => {
          const financial = toFinancialDomain(context.currentDomainData) ?? {};
          const nextFinancial = setActiveStatementSnapshot(financial, snapshotId, nowIso);
          if (!nextFinancial) {
            throw new Error("That statement snapshot is no longer available.");
          }
          return {
            domainData: nextFinancial,
            summary: buildFinancialDomainSummary(nextFinancial),
          };
        },
      });
      if (!result.success) {
        throw new Error(result.message || "Unable to switch statement snapshot.");
      }
      await refreshDerivedMarketCaches();
      await reload({ force: true });
    },
    [refreshDerivedMarketCaches, reload, userId, vaultKey, vaultOwnerToken]
  );

  const refreshPlaid = useCallback(
    async (itemId?: string) => {
      if (!userId || !vaultOwnerToken) {
        throw new Error("Vault owner token missing.");
      }
      const runningRunIds = collectRunningRunIds(plaidStatus, itemId);
      if (runningRunIds.length > 0) {
        return {
          status: "already_running",
          runIds: runningRunIds,
          taskId: refreshTracking?.taskId ?? null,
        } satisfies PlaidRefreshActionResult;
      }
      const response = await PlaidPortfolioService.refresh({
        userId,
        vaultOwnerToken,
        itemId,
      });
      const runIds = (response.runs || [])
        .map((run) => String(run.run_id || "").trim())
        .filter(Boolean);
      if (!runIds.length) {
        await reload({ force: true });
        return {
          status: "noop",
          runIds: [],
          taskId: null,
        } satisfies PlaidRefreshActionResult;
      }
      const taskId = AppBackgroundTaskService.startTask({
        userId,
        kind: "plaid_refresh",
        title: "Refreshing Plaid portfolio",
        description: "Kai is syncing the latest brokerage data from Plaid.",
        routeHref: ROUTES.KAI_PORTFOLIO,
        metadata: {
          runIds,
          itemId: itemId || null,
        },
      });
      setRefreshTracking({ taskId, runIds });
      await reload({ force: true });
      return {
        status: "started",
        runIds,
        taskId,
      } satisfies PlaidRefreshActionResult;
    },
    [plaidStatus, refreshTracking?.taskId, reload, userId, vaultOwnerToken]
  );

  const cancelPlaidRefresh = useCallback(
    async (params?: { itemId?: string; runIds?: string[] }) => {
      if (!userId || !vaultOwnerToken) {
        throw new Error("Vault owner token missing.");
      }
      const targetRunIds = (
        params?.runIds?.length
          ? params.runIds
          : collectRunningRunIds(plaidStatus, params?.itemId)
      )
        .map((value) => String(value || "").trim())
        .filter(Boolean);

      if (!targetRunIds.length) {
        return {
          status: "noop",
          runIds: [],
          taskId: refreshTracking?.taskId ?? null,
        } satisfies PlaidRefreshActionResult;
      }

      for (const runId of targetRunIds) {
        await PlaidPortfolioService.cancelRefreshRun({
          userId,
          runId,
          vaultOwnerToken,
        });
      }

      const activeTracking = refreshTracking ?? readRefreshTrackingFromTask(userId);
      if (activeTracking) {
        const remainingRunIds = activeTracking.runIds.filter((runId) => !targetRunIds.includes(runId));
        if (remainingRunIds.length > 0) {
          AppBackgroundTaskService.updateTask(activeTracking.taskId, {
            metadata: {
              runIds: remainingRunIds,
              itemId: params?.itemId || null,
            },
          });
          setRefreshTracking({
            taskId: activeTracking.taskId,
            runIds: remainingRunIds,
          });
        } else {
          AppBackgroundTaskService.cancelTask(
            activeTracking.taskId,
            "Plaid refresh canceled."
          );
          setRefreshTracking(null);
        }
      }

      await reload({ force: true });
      return {
        status: "canceled",
        runIds: targetRunIds,
        taskId: activeTracking?.taskId ?? null,
      } satisfies PlaidRefreshActionResult;
    },
    [plaidStatus, refreshTracking, reload, userId, vaultOwnerToken]
  );

  useEffect(() => {
    const trackedRunIds = trackedRefreshRunSignature
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!userId || !vaultOwnerToken || trackedRunIds.length === 0) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let attempts = 0;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;

      try {
        const nextStatus = await PlaidPortfolioService.getStatus({
          userId,
          vaultOwnerToken,
        });
        if (cancelled) return;

        startTransition(() => {
          setPlaidStatus(nextStatus);
          setPlaidPortfolio(
            hasPortfolioHoldings(nextStatus.aggregate?.portfolio_data)
              ? (nextStatus.aggregate.portfolio_data as PortfolioData)
              : null
          );
        });

        const runLookup = new Map(
          (nextStatus.items || [])
            .map((item) => item.latest_refresh_run)
            .filter(Boolean)
            .map((run) => [String(run?.run_id || "").trim(), run] as const)
        );
        const trackedRuns = trackedRunIds
          .map((runId) => runLookup.get(runId))
          .filter(Boolean);
        const runningRunIds = collectRunningRunIds(nextStatus);
        const allTerminal =
          trackedRuns.length > 0
            ? trackedRuns.every((run) => isTerminalPlaidRunStatus(run?.status))
            : trackedRunIds.every((runId) => !runningRunIds.includes(runId));

        if (allTerminal || runningRunIds.length === 0) {
          if (refreshTracking) {
            const anyFailed = trackedRuns.some((run) => String(run?.status || "") === "failed");
            const anyCanceled = trackedRuns.some((run) => String(run?.status || "") === "canceled");
            if (anyFailed) {
              AppBackgroundTaskService.failTask(
                refreshTracking.taskId,
                "One or more Plaid connections failed to refresh.",
                "Plaid refresh finished with errors."
              );
            } else if (anyCanceled) {
              AppBackgroundTaskService.cancelTask(
                refreshTracking.taskId,
                "Plaid refresh canceled."
              );
            } else {
              AppBackgroundTaskService.completeTask(
                refreshTracking.taskId,
                "Plaid brokerage data is up to date."
              );
              void refreshDerivedMarketCaches();
            }
          }
          setRefreshTracking(null);
          await reload({ force: true });
          return;
        }

        if (attempts >= PLAID_STATUS_MAX_ATTEMPTS) {
          console.warn("[usePortfolioSources] Stopping Plaid status polling after watchdog timeout.", {
            userId,
            trackedRunIds,
          });
          setRefreshTracking(null);
          return;
        }
      } catch (error) {
        if (attempts >= PLAID_STATUS_MAX_ATTEMPTS) {
          console.warn("[usePortfolioSources] Plaid status polling exhausted retries.", error);
          setRefreshTracking(null);
          return;
        }
      }

      timeoutId = window.setTimeout(() => {
        void poll();
      }, nextPlaidStatusPollDelay(attempts));
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    refreshDerivedMarketCaches,
    refreshTracking,
    reload,
    trackedRefreshRunSignature,
    userId,
    vaultOwnerToken,
  ]);

  return {
    isLoading,
    error,
    plaidStatus,
    statementPortfolio,
    plaidPortfolio,
    statementSnapshots,
    activeStatementSnapshotId,
    activeSource,
    availableSources,
    activePortfolio,
    freshness,
    changeActiveSource,
    changeActiveStatementSnapshot,
    refreshPlaid,
    cancelPlaidRefresh,
    reload,
    isPlaidRefreshing:
      trackedRefreshRunSignature.length > 0,
  };
}
