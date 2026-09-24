"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Capacitor } from "@capacitor/core";

import type { PortfolioData } from "@/components/kai/types/portfolio";
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
  removeStatementSnapshot,
  setActivePlaidSource,
  setActiveStatementSnapshot,
} from "@/lib/kai/brokerage/financial-sources";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  buildVaultPlaidStatus,
  loadFinancialForVault,
  refreshVaultConnections,
} from "@/lib/kai/plaid-vault/vault-sync";

interface UsePortfolioSourcesParams {
  userId: string | null | undefined;
  vaultOwnerToken?: string | null;
  vaultKey?: string | null;
  initialStatementPortfolio?: PortfolioData | null;
}

interface ReloadOptions {
  background?: boolean;
}

interface PlaidRefreshActionResult {
  refreshed: number;
  needsRelink: string[];
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
  refreshPlaid: () => Promise<PlaidRefreshActionResult>;
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

/** Where an owner-confirmed portfolio change was made, for its receipt. */
function confirmationSurface(): "web" | "ios" | "android" {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : "web";
}

const REPLACE_FINANCIAL = { merge_mode: "replace_domain", target_domain: "financial" } as const;

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
  const [isPlaidRefreshing, setIsPlaidRefreshing] = useState(false);
  const [isChangingSource, setIsChangingSource] = useState(false);
  const [isChangingStatementSnapshot, setIsChangingStatementSnapshot] =
    useState(false);
  const reloadInflightRef = useRef<Promise<void> | null>(null);
  const sourceChangeInflightRef = useRef<Promise<void> | null>(null);
  const statementSnapshotChangeInflightRef = useRef<Promise<void> | null>(null);
  const lastReloadStartedAtRef = useRef(0);
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
    // The sync above drops the warm result through a lazy import, which lands
    // after the run below; without this the run returns the pre-change warm.
    UnlockWarmOrchestrator.invalidateForUser(userId);
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
        // Reading is all a reload does. Plaid connections live sealed in the
        // vault, so memory is the only source of their status; the retired
        // server copy used to be re-saved here without a change plan, which
        // the server refused (428) on every unlock.
        const financialContext = await loadFinancialContext();
        const nextFinancial = financialContext.financial;
        const nextPlaidStatus = buildVaultPlaidStatus(nextFinancial, userId);
        const storedStatementPortfolio = getStatementPortfolio(nextFinancial);
        const desiredSource: PortfolioSource = resolvePreferredPortfolioSource({
          storedActiveSource: getStoredActiveSource(nextFinancial),
          backendPreferredSource: nextPlaidStatus?.source_preference,
          hasStatementPortfolio: hasPortfolioHoldings(storedStatementPortfolio),
          hasPlaidPortfolio: hasPortfolioHoldings(getPlaidPortfolio(nextFinancial)),
        });

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
  }, [applyFinancialSnapshot, loadFinancialContext, userId, vaultOwnerToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
   * Saves an owner-confirmed change to the financial memory: the change is
   * computed against the latest memory inside the write, and the write
   * replaces the domain so the sealed vault tiers are carried whole.
   */
  const saveFinancialChange = useCallback(
    async (params: {
      source: string;
      transform: (financial: Record<string, unknown>) => Record<string, unknown> | null;
      notReadyMessage: string;
      failureMessage: string;
    }) => {
      if (!userId || !vaultOwnerToken || !vaultKey) {
        throw new Error("Unlock your Vault before changing your portfolio.");
      }
      let notReady = false;
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
        confirmation: {
          confirmedByUser: true,
          surface: confirmationSurface(),
          source: params.source,
        },
        build: (context) => {
          const next = params.transform(context.currentDomainData);
          if (!next) {
            notReady = true;
            return {
              domainData: context.currentDomainData,
              summary: buildFinancialDomainSummary(context.currentDomainData),
              mergeDecision: REPLACE_FINANCIAL,
            };
          }
          return {
            domainData: next,
            summary: buildFinancialDomainSummary(next),
            mergeDecision: REPLACE_FINANCIAL,
          };
        },
      });
      if (notReady) throw new Error(params.notReadyMessage);
      if (!result.success) {
        throw new Error(
          result.conflict ? "Your portfolio changed elsewhere. Please try again." : params.failureMessage
        );
      }
      return toFinancialDomain(result.fullBlob.financial);
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
          const savedFinancial = await saveFinancialChange({
            source: "portfolio_source_change",
            notReadyMessage: "That portfolio source is not ready yet.",
            failureMessage: "Your portfolio source could not be saved. Please try again.",
            transform: (financial) => {
              const nowIso = new Date().toISOString();
              if (nextSource === "plaid") return setActivePlaidSource(financial, nowIso);
              const snapshotId = getActiveStatementSnapshotId(financial);
              return snapshotId ? setActiveStatementSnapshot(financial, snapshotId, nowIso) : null;
            },
          });

          applyFinancialSnapshot({
            financial: savedFinancial,
            plaidStatus,
            preferredSource: nextSource,
          });
          await refreshDerivedMarketCaches();
          await reload();
        } catch (selectionError) {
          // The visible source stays confirmed until the durable write succeeds.
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
      plaidStatus,
      saveFinancialChange,
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

      const request = (async () => {
        setIsChangingStatementSnapshot(true);
        try {
          const savedFinancial = await saveFinancialChange({
            source: "portfolio_statement_change",
            notReadyMessage: "That statement snapshot is no longer available.",
            failureMessage: "Your saved statement could not be selected. Please try again.",
            transform: (financial) =>
              setActiveStatementSnapshot(financial, snapshotId, new Date().toISOString()),
          });
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
      applyFinancialSnapshot,
      plaidStatus,
      saveFinancialChange,
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
        throw new Error("Unlock your Vault to delete this statement.");
      }
      if (sourceChangeInflightRef.current || statementSnapshotChangeInflightRef.current) {
        throw new Error("Finish the current portfolio change before deleting a statement.");
      }
      await saveFinancialChange({
        source: "portfolio_statement_delete",
        notReadyMessage: "That statement snapshot is no longer available.",
        failureMessage: "Your saved statement could not be deleted. Please try again.",
        transform: (financial) =>
          removeStatementSnapshot(financial, snapshotId, new Date().toISOString()),
      });
      await refreshDerivedMarketCaches();
      await reload();
    },
    [refreshDerivedMarketCaches, reload, saveFinancialChange, userId, vaultKey, vaultOwnerToken]
  );

  /** Refreshes every sealed connection now, through the stateless relay. */
  const refreshPlaid = useCallback(async (): Promise<PlaidRefreshActionResult> => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      throw new Error("Unlock your Vault to refresh your connected accounts.");
    }
    setIsPlaidRefreshing(true);
    try {
      const outcome = await refreshVaultConnections({
        userId,
        vaultKey,
        vaultOwnerToken,
        financial: await loadFinancialForVault({ userId, vaultKey, vaultOwnerToken }),
        force: true,
      });
      if (outcome.saved) await refreshDerivedMarketCaches();
      await reload();
      if (!outcome.saved && (outcome.failed > 0 || outcome.refreshed > 0)) {
        throw new Error("Could not refresh your connected accounts.");
      }
      return { refreshed: outcome.refreshed, needsRelink: outcome.needsRelink };
    } finally {
      setIsPlaidRefreshing(false);
    }
  }, [refreshDerivedMarketCaches, reload, userId, vaultKey, vaultOwnerToken]);

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
    reload,
    isPlaidRefreshing,
  };
}
