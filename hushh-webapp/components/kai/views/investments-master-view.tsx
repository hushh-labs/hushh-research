"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Building2,
  ChevronRight,
  Loader2,
  PieChart,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { PortfolioSourceSwitcher } from "@/components/kai/portfolio-source-switcher";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceStack,
} from "@/components/app-ui/surfaces";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  PlaidBrokerageSummarySection,
  PlaidFundingTransfersSection,
  PlaidInvestmentAccountsSection,
} from "@/components/kai/plaid/plaid-brokerage-sections";
import { TransactionActivity } from "@/components/kai/cards/transaction-activity";
import { SectorAllocationChart } from "@/components/kai/charts/sector-allocation-chart";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { usePortfolioSources } from "@/lib/kai/brokerage/use-portfolio-sources";
import {
  buildDebateContextFromPortfolio,
  normalizePortfolioTransactions,
  type PortfolioSource,
} from "@/lib/kai/brokerage/portfolio-sources";
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import {
  clearPlaidOAuthResumeSession,
  savePlaidOAuthResumeSession,
} from "@/lib/kai/brokerage/plaid-oauth-session";
import { resolvePlaidRedirectUri } from "@/lib/kai/brokerage/plaid-redirect-uri";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { buildKaiAnalysisPreviewRoute, ROUTES } from "@/lib/navigation/routes";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { useVault } from "@/lib/vault/vault-context";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

interface InvestmentsMasterViewProps {
  userId: string;
  vaultOwnerToken: string;
  initialStatementPortfolio?: PortfolioData | null;
}

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Value unavailable";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(1)}%`;
}

function holdingRowDescription(position: {
  sector?: string | null;
  assetType?: string | null;
}): string {
  return [
    position.sector || null,
    position.assetType || null,
  ]
    .filter(Boolean)
    .join(" • ");
}

function describeTransferDecisionRationale(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const payload = value as Record<string, unknown>;
    const messageCandidates = [
      payload.display_message,
      payload.description,
      payload.message,
      payload.reason,
      payload.rationale,
      payload.code,
    ];
    const message = messageCandidates.find(
      (candidate) => typeof candidate === "string" && candidate.trim().length > 0
    ) as string | undefined;
    if (message) return message.trim();
  }
  return "The funding provider returned a non-approved transfer decision.";
}

export function InvestmentsMasterView({
  userId,
  vaultOwnerToken,
  initialStatementPortfolio = null,
}: InvestmentsMasterViewProps) {
  const router = useRouter();
  const { vaultKey } = useVault();
  const [isLinkingPlaid, setIsLinkingPlaid] = useState(false);
  const [isLinkingFunding, setIsLinkingFunding] = useState(false);
  const [isSubmittingTransfer, setIsSubmittingTransfer] = useState(false);
  const [isReconcilingFunding, setIsReconcilingFunding] = useState(false);
  const setAnalysisParams = useKaiSession((s) => s.setAnalysisParams);
  const setLosersInput = useKaiSession((s) => s.setLosersInput);
  const {
    isLoading,
    error,
    plaidStatus,
    plaidFundingStatus,
    statementSnapshots,
    activeStatementSnapshotId,
    activeSource,
    availableSources,
    activePortfolio,
    freshness,
    isPlaidRefreshing,
    changeActiveSource,
    changeActiveStatementSnapshot,
    refreshPlaid,
    cancelPlaidRefresh,
    reload,
  } = usePortfolioSources({
    userId,
    vaultOwnerToken,
    vaultKey,
    initialStatementPortfolio,
  });

  const workingPortfolio = activePortfolio;
  const model = useMemo(
    () => mapPortfolioToDashboardViewModel(workingPortfolio ?? { holdings: [], transactions: [] }),
    [workingPortfolio]
  );
  const workflowPortfolioContext = useMemo(
    () => buildDebateContextFromPortfolio(workingPortfolio),
    [workingPortfolio]
  );
  const recentTransactions = useMemo(
    () => normalizePortfolioTransactions(workingPortfolio).slice(0, 10),
    [workingPortfolio]
  );
  const sourceLabel = activeSource === "plaid" ? "Plaid" : "Statement";
  const plaidProjectionStale = Boolean(plaidStatus?.aggregate?.projection_stale);

  const handleSourceChange = useCallback(
    (nextSource: PortfolioSource) => {
      void changeActiveSource(nextSource).catch((loadError) => {
        toast.error("Could not switch portfolio source.", {
          description: loadError instanceof Error ? loadError.message : "Please try again.",
        });
      });
    },
    [changeActiveSource]
  );

  const handleStatementSnapshotChange = useCallback(
    (snapshotId: string) => {
      void changeActiveStatementSnapshot(snapshotId).catch((loadError) => {
        toast.error("Could not switch statements.", {
          description: loadError instanceof Error ? loadError.message : "Please try again.",
        });
      });
    },
    [changeActiveStatementSnapshot]
  );

  const handleRefresh = useCallback(
    (itemId?: string) => {
      void refreshPlaid(itemId)
        .then((result) => {
          if (result.status === "already_running") {
            toast.info("A refresh is already in progress.", {
              description: "Let it finish or cancel it first.",
              action: result.runIds.length
                ? {
                    label: "Cancel",
                    onClick: () => {
                      void cancelPlaidRefresh({ itemId, runIds: result.runIds });
                    },
                  }
                : undefined,
            });
            return;
          }
          if (result.status !== "started") return;
          toast.message("Refreshing your brokerage data in the background.", {
            description: "We’ll update this view when it finishes.",
            action: {
              label: "Cancel",
              onClick: () => {
                void cancelPlaidRefresh({ itemId, runIds: result.runIds });
              },
            },
          });
        })
        .catch((loadError) => {
          toast.error("Could not refresh Plaid.", {
            description: loadError instanceof Error ? loadError.message : "Please try again.",
          });
        });
    },
    [cancelPlaidRefresh, refreshPlaid]
  );

  const handleCancelRefresh = useCallback(
    (params?: { itemId?: string; runIds?: string[] }) => {
      void cancelPlaidRefresh(params)
        .then((result) => {
          if (result.status === "noop") {
            toast.info("No active Plaid refresh is running.");
            return;
          }
          toast.success("Plaid refresh canceled.");
        })
        .catch((loadError) => {
          toast.error("Could not cancel Plaid refresh.", {
            description: loadError instanceof Error ? loadError.message : "Please try again.",
          });
        });
    },
    [cancelPlaidRefresh]
  );

  const handleAnalyzeHolding = useCallback(
    (symbol: string) => {
      if (!symbol || !vaultOwnerToken) {
        toast.error("Please unlock your Vault first.");
        return;
      }
      setAnalysisParams(null);
      router.push(
        buildKaiAnalysisPreviewRoute({
          ticker: symbol.toUpperCase(),
        })
      );
    },
    [router, setAnalysisParams, vaultOwnerToken]
  );

  const openPlaidLinkFlow = useCallback(
    async (itemId?: string) => {
      if (!vaultOwnerToken) {
        toast.error("Please unlock your Vault and try again.");
        return;
      }

      setIsLinkingPlaid(true);
      try {
        const redirectUri =
          typeof window !== "undefined"
            ? new URL(ROUTES.KAI_PLAID_OAUTH_RETURN, window.location.origin).toString()
            : undefined;
        const linkToken = await PlaidPortfolioService.createLinkToken({
          userId,
          vaultOwnerToken,
          itemId,
          updateMode: Boolean(itemId),
          redirectUri,
        });
        if (!linkToken.configured || !linkToken.link_token) {
          throw new Error("Plaid is not configured for this environment.");
        }
        if (linkToken.resume_session_id) {
          savePlaidOAuthResumeSession({
            version: 1,
            userId,
            resumeSessionId: linkToken.resume_session_id,
            returnPath: ROUTES.KAI_INVESTMENTS,
            startedAt: new Date().toISOString(),
          });
        }

        const Plaid = await loadPlaidLink();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
          };

          const handler = Plaid.create({
            token: linkToken.link_token,
            onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
              void PlaidPortfolioService.exchangePublicToken({
                userId,
                publicToken,
                vaultOwnerToken,
                metadata,
                resumeSessionId: linkToken.resume_session_id || null,
              })
                .then(async () => {
                  clearPlaidOAuthResumeSession();
                  await reload();
                  toast.success(itemId ? "Plaid connection updated." : "Brokerage connected with Plaid.");
                  finish(resolve);
                })
                .catch((loadError) => {
                  finish(() =>
                    reject(
                      loadError instanceof Error
                        ? loadError
                        : new Error("Plaid connection failed.")
                    )
                  );
                })
                .finally(() => {
                  handler.destroy?.();
                });
            },
            onExit: (exitError: Record<string, unknown> | null) => {
              handler.destroy?.();
              clearPlaidOAuthResumeSession();
              if (exitError && typeof exitError === "object") {
                const detail =
                  typeof exitError.error_message === "string"
                    ? exitError.error_message
                    : "Plaid Link closed with an error.";
                finish(() => reject(new Error(detail)));
                return;
              }
              finish(resolve);
            },
          });

          handler.open();
        });
      } catch (loadError) {
        clearPlaidOAuthResumeSession();
        toast.error(itemId ? "Could not update this Plaid connection." : "Could not start Plaid.", {
          description:
            loadError instanceof Error
              ? loadError.message
              : "Kai could not start the brokerage connection flow. Please try again.",
        });
      } finally {
        setIsLinkingPlaid(false);
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const openPlaidFundingLinkFlow = useCallback(
    async (itemId?: string) => {
      if (!vaultOwnerToken) {
        toast.error("Please unlock your Vault and try again.");
        return;
      }

      setIsLinkingFunding(true);
      try {
        const redirectUri = resolvePlaidRedirectUri();
        const linkToken = await PlaidPortfolioService.createFundingLinkToken({
          userId,
          vaultOwnerToken,
          itemId,
          redirectUri,
        });
        if (!linkToken.configured || !linkToken.link_token) {
          throw new Error("Plaid is not configured for this environment.");
        }
        if (linkToken.resume_session_id) {
          savePlaidOAuthResumeSession({
            version: 1,
            flowKind: "funding",
            userId,
            resumeSessionId: linkToken.resume_session_id,
            returnPath: ROUTES.KAI_INVESTMENTS,
            startedAt: new Date().toISOString(),
          });
        }

        const Plaid = await loadPlaidLink();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
          };

          const handler = Plaid.create({
            token: linkToken.link_token,
            onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
              void PlaidPortfolioService.exchangeFundingPublicToken({
                userId,
                publicToken,
                vaultOwnerToken,
                metadata,
                resumeSessionId: linkToken.resume_session_id || null,
                consentTimestamp: new Date().toISOString(),
              })
                .then(async () => {
                  clearPlaidOAuthResumeSession();
                  await reload();
                  toast.success("Funding account connected.");
                  finish(resolve);
                })
                .catch((loadError) => {
                  finish(() =>
                    reject(
                      loadError instanceof Error
                        ? loadError
                        : new Error("Funding connection failed.")
                    )
                  );
                })
                .finally(() => {
                  handler.destroy?.();
                });
            },
            onExit: (exitError: Record<string, unknown> | null) => {
              handler.destroy?.();
              clearPlaidOAuthResumeSession();
              if (exitError && typeof exitError === "object") {
                const detail =
                  typeof exitError.error_message === "string"
                    ? exitError.error_message
                    : "Plaid Link closed with an error.";
                finish(() => reject(new Error(detail)));
                return;
              }
              finish(resolve);
            },
          });

          handler.open();
        });
      } catch (loadError) {
        clearPlaidOAuthResumeSession();
        toast.error("Could not start funding account linking.", {
          description:
            loadError instanceof Error
              ? loadError.message
              : "Kai could not start the funding account connection flow. Please try again.",
        });
      } finally {
        setIsLinkingFunding(false);
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleCreateFundingTransfer = useCallback(
    async (payload: {
      fundingItemId: string;
      fundingAccountId: string;
      brokerageItemId?: string | null;
      brokerageAccountId?: string | null;
      amount: number;
      userLegalName: string;
      direction: "to_brokerage" | "from_brokerage";
      idempotencyKey: string;
    }) => {
      if (!vaultOwnerToken) {
        toast.error("Please unlock your Vault and try again.");
        return;
      }
      setIsSubmittingTransfer(true);
      try {
        const redirectUri = resolvePlaidRedirectUri();
        const response = await PlaidPortfolioService.createTransfer({
          userId,
          vaultOwnerToken,
          fundingItemId: payload.fundingItemId,
          fundingAccountId: payload.fundingAccountId,
          amount: payload.amount,
          userLegalName: payload.userLegalName,
          direction: payload.direction,
          idempotencyKey: payload.idempotencyKey,
          brokerageItemId: payload.brokerageItemId || null,
          brokerageAccountId: payload.brokerageAccountId || null,
          redirectUri,
        });
        if (!response.approved) {
          if (response.decision === "user_action_required" && response.action_link_token?.link_token) {
            const actionLink = response.action_link_token;
            if (actionLink.resume_session_id) {
              savePlaidOAuthResumeSession({
                version: 1,
                flowKind: "funding",
                userId,
                resumeSessionId: actionLink.resume_session_id,
                returnPath: ROUTES.KAI_INVESTMENTS,
                startedAt: new Date().toISOString(),
              });
            }
            const Plaid = await loadPlaidLink();
            await new Promise<void>((resolve, reject) => {
              const handler = Plaid.create({
                token: actionLink.link_token!,
                onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
                  void PlaidPortfolioService.exchangeFundingPublicToken({
                    userId,
                    publicToken,
                    vaultOwnerToken,
                    metadata,
                    resumeSessionId: actionLink.resume_session_id || null,
                    consentTimestamp: new Date().toISOString(),
                  })
                    .then(() => resolve())
                    .catch((error) => reject(error))
                    .finally(() => handler.destroy?.());
                },
                onExit: () => {
                  handler.destroy?.();
                  resolve();
                },
              });
              handler.open();
            });
            toast.info("Funding account relink completed. Please try the transfer again.");
          } else {
            toast.error("Transfer was not approved.", {
              description: describeTransferDecisionRationale(response.decision_rationale),
            });
          }
          await reload();
          return;
        }
        toast.success("Transfer submitted.");
        await reload();
      } catch (error) {
        toast.error("Transfer could not be created.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setIsSubmittingTransfer(false);
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleRefreshTransfer = useCallback(
    async (transferId: string) => {
      if (!vaultOwnerToken) return;
      try {
        await PlaidPortfolioService.refreshFundingTransferStatus({
          userId,
          transferId,
          vaultOwnerToken,
        });
        await reload();
      } catch (error) {
        toast.error("Could not refresh transfer status.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleSetDefaultFundingAccount = useCallback(
    async (payload: { itemId: string; accountId: string }) => {
      if (!vaultOwnerToken) return;
      try {
        await PlaidPortfolioService.setDefaultFundingAccount({
          userId,
          itemId: payload.itemId,
          accountId: payload.accountId,
          vaultOwnerToken,
        });
        await reload();
      } catch (error) {
        toast.error("Could not update default funding account.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleRunFundingReconciliation = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setIsReconcilingFunding(true);
    try {
      await PlaidPortfolioService.runFundingReconciliation({
        userId,
        vaultOwnerToken,
        triggerSource: "investments_ui",
      });
      toast.success("Funding reconciliation completed.");
      await reload();
    } catch (error) {
      toast.error("Funding reconciliation failed.", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsReconcilingFunding(false);
    }
  }, [reload, userId, vaultOwnerToken]);

  const handleCancelTransfer = useCallback(
    async (transferId: string) => {
      if (!vaultOwnerToken) return;
      try {
        await PlaidPortfolioService.cancelTransfer({
          userId,
          transferId,
          vaultOwnerToken,
        });
        toast.success("Transfer cancellation requested.");
        await reload();
      } catch (error) {
        toast.error("Could not cancel transfer.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleSearchFundingRecords = useCallback(
    async (payload: {
      transferId?: string;
      relationshipId?: string;
      limit?: number;
    }) => {
      if (!vaultOwnerToken) {
        throw new Error("Please unlock your Vault and try again.");
      }
      return await PlaidPortfolioService.searchFundingRecords({
        userId,
        vaultOwnerToken,
        transferId: payload.transferId || null,
        relationshipId: payload.relationshipId || null,
        limit: payload.limit,
      });
    },
    [userId, vaultOwnerToken]
  );

  const handleCreateFundingEscalation = useCallback(
    async (payload: {
      transferId?: string;
      relationshipId?: string;
      severity: "low" | "normal" | "high" | "urgent";
      notes: string;
    }) => {
      if (!vaultOwnerToken) {
        throw new Error("Please unlock your Vault and try again.");
      }
      await PlaidPortfolioService.createFundingEscalation({
        userId,
        vaultOwnerToken,
        transferId: payload.transferId || null,
        relationshipId: payload.relationshipId || null,
        severity: payload.severity,
        notes: payload.notes,
      });
      toast.success("Support escalation created.");
    },
    [userId, vaultOwnerToken]
  );

  const handleOptimize = useCallback(() => {
    if (!workingPortfolio || !Array.isArray(workingPortfolio.holdings) || !workingPortfolio.holdings.length) {
      toast.error("No holdings are ready for optimization yet.");
      return;
    }
    const holdings = workingPortfolio.holdings.map((holding) => ({
      symbol: String(holding.symbol || "").trim().toUpperCase(),
      name: holding.name,
      gain_loss_pct:
        typeof holding.unrealized_gain_loss_pct === "number"
          ? holding.unrealized_gain_loss_pct
          : undefined,
      gain_loss:
        typeof holding.unrealized_gain_loss === "number"
          ? holding.unrealized_gain_loss
          : undefined,
      market_value:
        typeof holding.market_value === "number" ? holding.market_value : undefined,
      weight_pct:
        typeof holding.weight_pct === "number" ? holding.weight_pct : undefined,
      sector: holding.sector,
      asset_type: holding.asset_type,
    }));
    const losers = holdings.filter(
      (holding) => typeof holding.gain_loss_pct === "number" && holding.gain_loss_pct < 0
    );
    setLosersInput({
      userId,
      thresholdPct: -5,
      maxPositions: 10,
      losers,
      holdings,
      forceOptimize: losers.length === 0,
      hadBelowThreshold: losers.length > 0,
      portfolioSource: activeSource,
      portfolioContext: workflowPortfolioContext,
      sourceMetadata:
        workingPortfolio.source_metadata && typeof workingPortfolio.source_metadata === "object"
          ? workingPortfolio.source_metadata
          : null,
    });
    router.push(ROUTES.KAI_OPTIMIZE);
  }, [activeSource, router, setLosersInput, userId, workingPortfolio, workflowPortfolioContext]);

  const topPositions = model.canonicalModel.positions.slice(0, 12);
  const equitySectorHoldings = model.canonicalModel.positions
    .filter((position) => !position.isCashEquivalent && position.assetBucket === "equity")
    .map((position) => ({
      symbol: position.displaySymbol,
      name: position.name,
      market_value: position.marketValue,
      sector: position.sector || position.assetType || "Other Equity",
      asset_type: position.assetType || undefined,
    }));

  if (isLoading && !workingPortfolio) {
    return (
      <AppPageShell
        as="div"
        width="wide"
        className="flex items-center justify-center pb-10"
      >
        <SurfaceCard className="max-w-md">
          <SurfaceCardContent className="flex items-center gap-3 py-5 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading investments...
          </SurfaceCardContent>
        </SurfaceCard>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell
      as="div"
      width="wide"
      className="pb-10"
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Kai Investments"
          title="Investments"
          description="Review the current source, connected brokerages, positions, and recent investment activity in one place."
          icon={Building2}
          accent="emerald"
          actions={
            <>
              <Button variant="none" effect="fade" onClick={() => router.push(ROUTES.KAI_PORTFOLIO)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to portfolio
              </Button>
              <Button variant="none" effect="fade" onClick={() => handleRefresh()}>
                <RefreshCw
                  className={cn("mr-2 h-4 w-4", (isPlaidRefreshing || isLinkingPlaid) && "animate-spin")}
                />
                Refresh
              </Button>
              {isPlaidRefreshing ? (
                <Button variant="none" effect="fade" onClick={() => handleCancelRefresh()}>
                  Cancel refresh
                </Button>
              ) : null}
              <Button variant="blue-gradient" effect="fill" onClick={handleOptimize}>
                <ArrowRight className="mr-2 h-4 w-4" />
                Optimize current source
              </Button>
            </>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>
        <PortfolioSourceSwitcher
          activeSource={activeSource}
          availableSources={availableSources}
          freshness={freshness}
          onSourceChange={handleSourceChange}
          statementSnapshots={statementSnapshots}
          activeStatementSnapshotId={activeStatementSnapshotId}
          onStatementSnapshotChange={handleStatementSnapshotChange}
          onRefreshPlaid={() => handleRefresh()}
          onCancelRefreshPlaid={isPlaidRefreshing ? () => handleCancelRefresh() : undefined}
          isRefreshing={isPlaidRefreshing}
        />

        {error ? (
          <SurfaceCard tone="warning">
            <SurfaceCardContent className="py-3 text-sm text-muted-foreground">
              {error}
            </SurfaceCardContent>
          </SurfaceCard>
        ) : null}

        {activeSource === "plaid" && plaidProjectionStale ? (
          <SurfaceCard accent="sky">
            <SurfaceCardContent className="py-3 text-sm text-muted-foreground">
              Brokerage data is fresher than the mirrored PKM snapshot right now. Kai will
              project the latest Plaid source again while your vault is unlocked.
            </SurfaceCardContent>
          </SurfaceCard>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SurfaceCard>
            <SurfaceCardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Source
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">{sourceLabel}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {activeSource === "plaid"
                  ? "Broker-sourced and read-only"
                  : "Statement-driven and editable"}
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
          <SurfaceCard>
            <SurfaceCardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Portfolio value
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">
                {formatCurrency(model.hero.totalValue)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Current active source value</p>
            </SurfaceCardContent>
          </SurfaceCard>
          <SurfaceCard>
            <SurfaceCardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Investable positions
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">
                {model.hero.investableHoldingsCount}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Equity positions ready for analysis
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
          <SurfaceCard>
            <SurfaceCardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Top 3 concentration
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">
                {formatPercent(
                  model.concentration.slice(0, 3).reduce((sum, row) => sum + row.weightPct, 0)
                )}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Largest positions share of portfolio
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
        </section>

        <PlaidBrokerageSummarySection
          items={plaidStatus?.items || []}
          onRefreshItem={(itemId) => handleRefresh(itemId)}
          onCancelRefresh={(params) => handleCancelRefresh(params)}
          onManageConnection={(itemId) => void openPlaidLinkFlow(itemId)}
        />

        <PlaidFundingTransfersSection
          fundingStatus={plaidFundingStatus}
          brokerageItems={plaidStatus?.items || []}
          onManageBrokerage={() => void openPlaidLinkFlow()}
          onConnectFunding={(itemId) => void openPlaidFundingLinkFlow(itemId)}
          onSetDefaultFundingAccount={(payload) => void handleSetDefaultFundingAccount(payload)}
          onRunReconciliation={() => void handleRunFundingReconciliation()}
          onCreateTransfer={(payload) => void handleCreateFundingTransfer(payload)}
          onRefreshTransfer={(transferId) => void handleRefreshTransfer(transferId)}
          onCancelTransfer={(transferId) => void handleCancelTransfer(transferId)}
          onSearchFundingRecords={(payload) => handleSearchFundingRecords(payload)}
          onCreateFundingEscalation={(payload) => handleCreateFundingEscalation(payload)}
          isConnectingFunding={isLinkingFunding}
          isSubmittingTransfer={isSubmittingTransfer}
          isReconciling={isReconcilingFunding}
        />

        {activeSource === "plaid" ? (
          <PlaidInvestmentAccountsSection items={plaidStatus?.items || []} />
        ) : null}

        {equitySectorHoldings.length > 0 ? (
          <SectorAllocationChart
            className="min-w-0"
            holdings={equitySectorHoldings}
            title="Equity sector view"
            subtitle={`Built from the current ${sourceLabel.toLowerCase()} source and ready for debate context.`}
          />
        ) : null}

        <SettingsGroup
          eyebrow="Positions"
          title="Largest positions"
          description="Use this to see where current value is concentrated and jump straight into analysis for eligible holdings."
        >
          {topPositions.map((position) => (
            <SettingsRow
              key={`${position.displaySymbol}:${position.name}`}
              icon={PieChart}
              title={`${position.displaySymbol || "—"} · ${position.name}`}
              description={holdingRowDescription({
                sector: position.sector,
                assetType: position.assetType,
              })}
              trailing={
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-[13px] font-semibold text-foreground">
                      {formatCurrency(position.marketValue)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatPercent(
                        model.hero.totalValue > 0
                          ? (position.marketValue / model.hero.totalValue) * 100
                          : 0
                      )}
                    </p>
                  </div>
                  {position.debateEligible && position.displaySymbol ? (
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      onClick={() => handleAnalyzeHolding(position.displaySymbol)}
                    >
                      Analyze
                    </Button>
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              }
            />
          ))}
        </SettingsGroup>

        <SettingsGroup
          eyebrow="Activity"
          title="Recent investment activity"
          description="Transactions stay source-aware, so you can compare what came from broker data versus uploaded statements."
        >
          <div className="p-3 sm:p-4">
            <TransactionActivity
              transactions={recentTransactions}
              maxItems={8}
              className="min-w-0"
            />
          </div>
        </SettingsGroup>

        <SettingsGroup
          eyebrow="Actions"
          title="Use this source in Kai"
          description="Debate and Optimize will carry the current source and freshness context forward."
        >
          <SettingsRow
            icon={BarChart3}
            title="Open optimization workspace"
            description={`Continue with the current ${sourceLabel.toLowerCase()} source in Optimize.`}
            trailing={
              <Button variant="none" effect="fade" size="sm" onClick={handleOptimize}>
                Open Optimize
              </Button>
            }
          />
          <SettingsRow
            icon={ArrowRight}
            title="Analyze a holding from this source"
            description="Use the Analyze action beside a position above to launch the debate engine with this source context."
            trailing={<ArrowRight className="h-4 w-4 text-muted-foreground" />}
          />
        </SettingsGroup>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
