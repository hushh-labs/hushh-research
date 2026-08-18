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
  resolvePreferredPortfolioSource,
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
  getPlaidPortfolio,
  getStatementPortfolio,
  getStatementSnapshotOptions,
  isPlaidMirrorStale,
  removeStatementSnapshot,
  setActivePlaidSource,
  setActiveStatementSnapshot,
  upsertPlaidSource,
} from "@/lib/kai/brokerage/financial-sources";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

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

interface ReloadOptions {
  background?: boolean;
}

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
  /** The active source remains the last confirmed source while this settles. */
  isChangingSource: boolean;
  /** A saved-statement selection is being durably persisted. */
  isChangingStatementSnapshot: boolean;
  /** Source and saved-statement changes require an unlocked Vault. */
  canChangePortfolioSource: boolean;
  changeActiveSource: (nextSource: PortfolioSource) => Promise<void>;
  changeActiveStatementSnapshot: (snapshotId: string) => Promise<void>;
  deleteStatementSnapshot: (snapshotId: string) => Promise<void>;
  refreshPlaid: (itemId?: string) => Promise<PlaidRefreshActionResult>;
  cancelPlaidRefresh: (params?: {
    itemId?: string;
    runIds?: string[];
  }) => Promise<PlaidRefreshActionResult>;
  reload: (options?: ReloadOptions) => Promise<void>;
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

export function usePortfolioSources({
  userId,
  vaultOwnerToken,
  vaultKey,
  initialStatementPortfolio = null,
}: UsePortfolioSourcesParams): UsePortfolioSourcesResult {
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
  const [isChangingSource, setIsChangingSource] = useState(false);
  const [isChangingStatementSnapshot, setIsChangingStatementSnapshot] =
    useState(false);
  const reloadInflightRef = useRef<Promise<void> | null>(null);
  const sourceChangeInflightRef = useRef<Promise<void> | null>(null);
  const statementSnapshotChangeInflightRef = useRef<Promise<void> | null>(null);
  const lastReloadStartedAtRef = useRef(0);
  const plaidPollAttemptRef = useRef(0);
  const growthPortfolioReadyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialStatementPortfolio && hasPortfolioHoldings(initialStatementPortfolio)) {
      setStatementPortfolio(initialStatementPortfolio);
    }
  }, [initialStatementPortfolio]);

  const loadFinancialContext = useCallback(async () => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      return {
        fullBlob: {} as Record<string, unknown>,
        financial: null as Record<string, unknown> | null,
        expectedDataVersion: undefined as number | undefined,
      };
    }

    const cachedBlob = PersonalKnowledgeModelService.peekCachedFullBlob(userId);
    const cachedFinancial =
      cachedBlob?.blob &&
      typeof cachedBlob.blob.financial === "object" &&
      !Array.isArray(cachedBlob.blob.financial)
        ? (cachedBlob.blob.financial as Record<string, unknown>)
        : null;
    const financial =
      cachedFinancial ??
      (await PersonalKnowledgeModelService.loadDomainData({
        userId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken: vaultOwnerToken || undefined,
      }).catch(() => null));

    const expectedDataVersion =
      cachedBlob?.dataVersion ?? PersonalKnowledgeModelService.peekCachedEncryptedBlob(userId)?.dataVersion;

    return {
      fullBlob: financial ? { financial } : ({} as Record<string, unknown>),
      financial: toFinancialDomain(financial),
      expectedDataVersion,
    };
  }, [userId, vaultKey, vaultOwnerToken]);

  const applyFinancialSnapshot = useCallback(
    (params: {
      financial: Record<string, unknown> | null;
      plaidStatus: PlaidPortfolioStatusResponse | null;
      preferredSource?: PortfolioSource | string | null;
    }) => {
      const loadedStatement = params.financial
        ? getStatementPortfolio(params.financial)
        : initialStatementPortfolio && hasPortfolioHoldings(initialStatementPortfolio)
          ? initialStatementPortfolio
          : null;
      const loadedStatementSnapshots = params.financial
        ? getStatementSnapshotOptions(params.financial)
        : [];
      const loadedActiveStatementSnapshotId = params.financial
        ? getActiveStatementSnapshotId(params.financial)
        : null;
      const mirroredPlaidPortfolio = params.financial ? getPlaidPortfolio(params.financial) : null;
      const loadedPlaidPortfolio =
        mirroredPlaidPortfolio ??
        (params.plaidStatus?.aggregate?.portfolio_data as PortfolioData | null | undefined) ??
        null;
      const nextAvailableSources = resolveAvailableSources({
        statementPortfolio: loadedStatement,
        plaidPortfolio: loadedPlaidPortfolio,
      });
      const nextActiveSource = pickPreferredSource({
        preferred:
          params.preferredSource ??
          params.plaidStatus?.source_preference ??
          getStoredActiveSource(params.financial),
        availableSources: nextAvailableSources,
      });

      startTransition(() => {
        setStatementPortfolio(loadedStatement);
        setStatementSnapshots(loadedStatementSnapshots);
        setActiveStatementSnapshotId(loadedActiveStatementSnapshotId);
        setPlaidStatus(params.plaidStatus);
        setPlaidPortfolio(loadedPlaidPortfolio);
        setActiveSource(nextActiveSource);
      });
    },
    [initialStatementPortfolio]
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

  const reload = useCallback(async (options?: ReloadOptions) => {
    const isBackground = options?.background === true;
    if (reloadInflightRef.current) {
      return reloadInflightRef.current;
    }
    const now = Date.now();
    const minReloadGapMs = isBackground ? 2000 : 400;
    if (now - lastReloadStartedAtRef.current < minReloadGapMs) {
      return;
    }

    lastReloadStartedAtRef.current = now;
    const request = (async () => {
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

      if (!isBackground) {
        setIsLoading(true);
      }
      setError(null);
      try {
        const [financialContext, loadedPlaidStatus] = await Promise.all([
          loadFinancialContext(),
          PlaidPortfolioService.getStatus({
            userId,
            vaultOwnerToken,
          }).catch(() => null),
        ]);

        let nextFinancial = financialContext.financial;
        let nextFullBlob = financialContext.fullBlob;
        const expectedDataVersion = financialContext.expectedDataVersion;
        const storedActiveSource = getStoredActiveSource(nextFinancial);
        const storedStatementPortfolio = getStatementPortfolio(nextFinancial);
        const hasPlaidPortfolio =
          hasPortfolioHoldings(getPlaidPortfolio(nextFinancial)) ||
          hasPortfolioHoldings(loadedPlaidStatus?.aggregate?.portfolio_data);
        const desiredSource: PortfolioSource =
          resolvePreferredPortfolioSource({
            storedActiveSource,
            backendPreferredSource: loadedPlaidStatus?.source_preference,
            hasStatementPortfolio: hasPortfolioHoldings(storedStatementPortfolio),
            hasPlaidPortfolio,
          });
        const nowIso = new Date().toISOString();

        if (userId && vaultKey && vaultOwnerToken) {
          let projectedFinancial = nextFinancial ?? {};
          let shouldPersist = false;

          if (loadedPlaidStatus?.configured && isPlaidMirrorStale(projectedFinancial, loadedPlaidStatus)) {
            projectedFinancial = upsertPlaidSource(
              projectedFinancial,
              loadedPlaidStatus,
              desiredSource === "plaid" ? "plaid" : "statement",
              nowIso
            );
            shouldPersist = true;
          }

          if (desiredSource === "plaid" && getStoredActiveSource(projectedFinancial) !== "plaid") {
            const plaidActivated = setActivePlaidSource(projectedFinancial, loadedPlaidStatus, nowIso);
            if (plaidActivated) {
              projectedFinancial = plaidActivated;
              shouldPersist = true;
            }
          }

          if (desiredSource === "statement" && getStoredActiveSource(projectedFinancial) !== "statement") {
            const activeSnapshotId = getActiveStatementSnapshotId(projectedFinancial);
            if (activeSnapshotId) {
              const statementActivated = setActiveStatementSnapshot(
                projectedFinancial,
                activeSnapshotId,
                nowIso
              );
              if (statementActivated) {
                projectedFinancial = statementActivated;
                shouldPersist = true;
              }
            }
          }

          if (shouldPersist) {
            const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
              userId,
              vaultKey,
              domain: "financial",
              domainData: projectedFinancial,
              summary: buildFinancialDomainSummary(projectedFinancial),
              baseFullBlob: nextFullBlob,
              expectedDataVersion,
              vaultOwnerToken,
            });
            nextFullBlob = result.fullBlob;
            nextFinancial = toFinancialDomain(result.fullBlob.financial) ?? projectedFinancial;
            await refreshDerivedMarketCaches();
          }
        }

        const plaidSourceRecord = toFinancialDomain(
          toFinancialDomain(nextFinancial?.sources)?.plaid
        );
        const projectionStale = Boolean(
          loadedPlaidStatus?.configured && isPlaidMirrorStale(nextFinancial, loadedPlaidStatus)
        );
        const nextPlaidStatus = loadedPlaidStatus
          ? {
              ...loadedPlaidStatus,
              aggregate: {
                ...loadedPlaidStatus.aggregate,
                projection_stale: projectionStale,
                projected_at:
                  typeof plaidSourceRecord?.projected_at === "string"
                    ? plaidSourceRecord.projected_at
                    : null,
              },
            }
          : null;

        applyFinancialSnapshot({
          financial: nextFinancial,
          plaidStatus: nextPlaidStatus,
          preferredSource: desiredSource,
        });
      } catch {
        startTransition(() => {
          setError("Portfolio sources are unavailable right now. Please try again.");
        });
      } finally {
        if (!isBackground) {
          startTransition(() => {
            setIsLoading(false);
          });
        }
      }
    })();

    reloadInflightRef.current = request;
    try {
      await request;
    } finally {
      if (reloadInflightRef.current === request) {
        reloadInflightRef.current = null;
      }
    }
  }, [
    applyFinancialSnapshot,
    loadFinancialContext,
    refreshDerivedMarketCaches,
    userId,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  const activePortfolio = useMemo(() => {
    if (activeSource === "statement") return statementPortfolio;
    return plaidPortfolio;
  }, [activeSource, plaidPortfolio, statementPortfolio]);
  const canChangePortfolioSource = Boolean(userId && vaultOwnerToken && vaultKey);

  /**
   * Source selection has two durable projections: the server preference used
   * by Plaid and the encrypted financial source metadata used by the client.
   * Keep the confirmed source visible until both settle, and compensate the
   * server preference if the encrypted write cannot be committed.
   */
  const persistFinancialSourceSelection = useCallback(
    async (params: {
      nextSource: PortfolioSource;
      previousSource: PortfolioSource;
      nextFinancial: Record<string, unknown>;
      fullBlob: Record<string, unknown>;
      expectedDataVersion?: number;
    }) => {
      if (!userId || !vaultOwnerToken || !vaultKey) {
        throw new Error("Unlock your Vault before changing the portfolio source.");
      }

      let backendPreferenceChanged = false;
      try {
        await PlaidPortfolioService.setActiveSource({
          userId,
          activeSource: params.nextSource,
          vaultOwnerToken,
        });
        backendPreferenceChanged = true;

        const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
          userId,
          vaultKey,
          domain: "financial",
          domainData: params.nextFinancial,
          summary: buildFinancialDomainSummary(params.nextFinancial),
          baseFullBlob: params.fullBlob,
          mergeDecision: {
            merge_mode: "replace_domain",
            target_domain: "financial",
          },
          expectedDataVersion: params.expectedDataVersion,
          vaultOwnerToken,
        });

        if (!result.success) {
          throw new Error(
            result.conflict
              ? "Your portfolio changed elsewhere. Please try again."
              : "Your portfolio source could not be saved. Please try again."
          );
        }

        return result;
      } catch (selectionError) {
        if (backendPreferenceChanged && params.previousSource !== params.nextSource) {
          await PlaidPortfolioService.setActiveSource({
            userId,
            activeSource: params.previousSource,
            vaultOwnerToken,
          }).catch(() => undefined);
        }
        throw selectionError;
      }
    },
    [userId, vaultKey, vaultOwnerToken]
  );

  useEffect(() => {
    if (!userId || isLoading || !activePortfolio || !hasPortfolioHoldings(activePortfolio)) {
      return;
    }

    const nextKey = `${activeSource}:${availableSources.join(",")}`;
    if (growthPortfolioReadyKeyRef.current === nextKey) {
      return;
    }
    growthPortfolioReadyKeyRef.current = nextKey;

    trackGrowthFunnelStepCompleted({
      journey: "investor",
      step: "portfolio_ready",
      portfolioSource: activeSource,
      dedupeKey: `growth:investor:portfolio_ready:${nextKey}`,
      dedupeWindowMs: 5_000,
    });
  }, [activePortfolio, activeSource, availableSources, isLoading, userId]);

  const changeActiveSource = useCallback(
    async (nextSource: PortfolioSource) => {
      if (nextSource === activeSource) return;
      if (!userId || !vaultOwnerToken || !vaultKey) {
        throw new Error("Unlock your Vault before changing the portfolio source.");
      }
      if (!availableSources.includes(nextSource)) {
        throw new Error("That portfolio source is not ready yet.");
      }
      if (statementSnapshotChangeInflightRef.current) {
        throw new Error("Finish changing the saved statement before selecting another source.");
      }
      if (sourceChangeInflightRef.current) {
        return sourceChangeInflightRef.current;
      }

      const previousSource = activeSource;
      const request = (async () => {
        setIsChangingSource(true);
        try {
          const { fullBlob, financial, expectedDataVersion } = await loadFinancialContext();
          const nowIso = new Date().toISOString();
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
            throw new Error("That portfolio source is not ready yet.");
          }

          const result = await persistFinancialSourceSelection({
            nextSource,
            previousSource,
            nextFinancial,
            fullBlob,
            expectedDataVersion,
          });
          const savedFinancial =
            toFinancialDomain(result.fullBlob.financial) ?? nextFinancial;

          applyFinancialSnapshot({
            financial: savedFinancial,
            plaidStatus,
            preferredSource: nextSource,
          });
          await refreshDerivedMarketCaches();
          await reload();
        } catch (selectionError) {
          // The visible source stays confirmed until the complete durable write
          // succeeds. Reconcile a compensated server preference in the
          // background without replacing the last safe portfolio view.
          setActiveSource(previousSource);
          void reload({ background: true });
          throw selectionError;
        } finally {
          setIsChangingSource(false);
        }
      })();

      sourceChangeInflightRef.current = request;
      try {
        await request;
      } finally {
        if (sourceChangeInflightRef.current === request) {
          sourceChangeInflightRef.current = null;
        }
      }
    },
    [
      activeSource,
      applyFinancialSnapshot,
      availableSources,
      loadFinancialContext,
      plaidStatus,
      persistFinancialSourceSelection,
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
      if (!statementSnapshots.some((snapshot) => snapshot.id === snapshotId)) {
        throw new Error("That statement snapshot is no longer available.");
      }
      if (sourceChangeInflightRef.current) {
        throw new Error("Finish changing the portfolio source before selecting another statement.");
      }
      if (statementSnapshotChangeInflightRef.current) {
        return statementSnapshotChangeInflightRef.current;
      }

      const previousSource = activeSource;
      const request = (async () => {
        setIsChangingStatementSnapshot(true);
        try {
          const { fullBlob, financial, expectedDataVersion } = await loadFinancialContext();
          const nowIso = new Date().toISOString();
          const nextFinancial = setActiveStatementSnapshot(financial, snapshotId, nowIso);
          if (!nextFinancial) {
            throw new Error("That statement snapshot is no longer available.");
          }

          const result = await persistFinancialSourceSelection({
            nextSource: "statement",
            previousSource,
            nextFinancial,
            fullBlob,
            expectedDataVersion,
          });
          const savedFinancial =
            toFinancialDomain(result.fullBlob.financial) ?? nextFinancial;
          applyFinancialSnapshot({
            financial: savedFinancial,
            plaidStatus,
            preferredSource: "statement",
          });
          await refreshDerivedMarketCaches();
          await reload();
        } catch (selectionError) {
          void reload({ background: true });
          throw selectionError;
        } finally {
          setIsChangingStatementSnapshot(false);
        }
      })();

      statementSnapshotChangeInflightRef.current = request;
      try {
        await request;
      } finally {
        if (statementSnapshotChangeInflightRef.current === request) {
          statementSnapshotChangeInflightRef.current = null;
        }
      }
    },
    [
      activeSource,
      applyFinancialSnapshot,
      loadFinancialContext,
      plaidStatus,
      persistFinancialSourceSelection,
      refreshDerivedMarketCaches,
      reload,
      statementSnapshots,
      userId,
      vaultKey,
      vaultOwnerToken,
    ]
  );

  const deleteStatementSnapshot = useCallback(
    async (snapshotId: string) => {
      if (!userId || !vaultOwnerToken || !vaultKey) {
        throw new Error("Unlock to delete this statement.");
      }
      if (sourceChangeInflightRef.current || statementSnapshotChangeInflightRef.current) {
        throw new Error("Finish the current portfolio change before deleting a statement.");
      }
      const { fullBlob, financial, expectedDataVersion } = await loadFinancialContext();
      const nowIso = new Date().toISOString();
      const nextFinancial = removeStatementSnapshot(financial, snapshotId, nowIso);
      if (!nextFinancial) {
        throw new Error("That statement snapshot is no longer available.");
      }
      const nextActiveSource = getStoredActiveSource(nextFinancial);
      // Removing a saved statement must not be blocked by the derived server
      // preference. The encrypted financial record remains authoritative for
      // the next active source and is committed before the view changes.
      void PlaidPortfolioService.setActiveSource({
        userId,
        activeSource: nextActiveSource,
        vaultOwnerToken,
      }).catch(() => undefined);
      const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
        userId,
        vaultKey,
        domain: "financial",
        domainData: nextFinancial,
        summary: buildFinancialDomainSummary(nextFinancial),
        baseFullBlob: fullBlob,
        mergeDecision: {
          merge_mode: "replace_domain",
          target_domain: "financial",
        },
        expectedDataVersion,
        vaultOwnerToken,
      });
      if (!result.success) {
        throw new Error(
          result.conflict
            ? "Your portfolio changed elsewhere. Please try again."
            : "Your saved statement could not be deleted. Please try again."
        );
      }
      await refreshDerivedMarketCaches();
      await reload();
    },
    [
      loadFinancialContext,
      refreshDerivedMarketCaches,
      reload,
      userId,
      vaultKey,
      vaultOwnerToken,
    ]
  );

  const refreshPlaid = useCallback(
    async (itemId?: string) => {
      if (!userId || !vaultOwnerToken) {
        throw new Error("Not ready yet. Try again.");
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
        await reload();
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
      await reload();
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
        throw new Error("Not ready yet. Try again.");
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

      await reload();
      return {
        status: "canceled",
        runIds: targetRunIds,
        taskId: activeTracking?.taskId ?? null,
      } satisfies PlaidRefreshActionResult;
    },
    [plaidStatus, refreshTracking, reload, userId, vaultOwnerToken]
  );

  useEffect(() => {
    const runLookup = new Map(
      (plaidStatus?.items || [])
        .map((item) => item.latest_refresh_run)
        .filter(Boolean)
        .map((run) => [String(run?.run_id || ""), run] as const)
    );

    if (refreshTracking) {
      const trackedRuns = refreshTracking.runIds
        .map((runId) => runLookup.get(runId))
        .filter(Boolean);
      const allTerminal =
        trackedRuns.length > 0 &&
        trackedRuns.every((run) => {
          const status = String(run?.status || "");
          return status === "completed" || status === "failed" || status === "canceled";
        });
      if (allTerminal) {
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
        setRefreshTracking(null);
      }
    }

    const shouldPoll =
      Boolean(refreshTracking) ||
      Boolean(
        (plaidStatus?.items || []).some((item) => {
          const status = String(item.latest_refresh_run?.status || item.sync_status || "");
          return status === "queued" || status === "running";
        })
      );
    if (!shouldPoll) {
      plaidPollAttemptRef.current = 0;
      return;
    }

    let canceled = false;
    let timer: number | null = null;
    const scheduleNext = () => {
      const attempt = plaidPollAttemptRef.current;
      const delayMs = attempt < 3 ? 4000 : attempt < 10 ? 7000 : 10000;
      timer = window.setTimeout(async () => {
        if (canceled) return;
        plaidPollAttemptRef.current += 1;
        await reload({ background: true });
        if (!canceled) {
          scheduleNext();
        }
      }, delayMs);
    };
    scheduleNext();

    return () => {
      canceled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [plaidStatus, refreshDerivedMarketCaches, refreshTracking, reload]);

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
    isChangingSource,
    isChangingStatementSnapshot,
    canChangePortfolioSource,
    changeActiveSource,
    changeActiveStatementSnapshot,
    deleteStatementSnapshot,
    refreshPlaid,
    cancelPlaidRefresh,
    reload,
    isPlaidRefreshing:
      Boolean(refreshTracking) ||
      Boolean(
        (plaidStatus?.items || []).some((item) => {
          const status = String(item.latest_refresh_run?.status || item.sync_status || "");
          return status === "queued" || status === "running";
        })
      ),
  };
}
