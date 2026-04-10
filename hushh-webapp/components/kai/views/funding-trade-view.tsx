"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BadgeDollarSign,
  KeyRound,
  Loader2,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";

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
import { Badge } from "@/components/ui/badge";
import { clearPlaidOAuthResumeSession, savePlaidOAuthResumeSession } from "@/lib/kai/brokerage/plaid-oauth-session";
import { saveAlpacaOAuthResumeSession } from "@/lib/kai/brokerage/alpaca-oauth-session";
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import type { PlaidFundingTradeIntentRef } from "@/lib/kai/brokerage/portfolio-sources";
import { resolvePlaidRedirectUri } from "@/lib/kai/brokerage/plaid-redirect-uri";
import { usePortfolioSources } from "@/lib/kai/brokerage/use-portfolio-sources";
import { ROUTES } from "@/lib/navigation/routes";
import { Button } from "@/lib/morphy-ux/button";
import { useVault } from "@/lib/vault/vault-context";
import { cn } from "@/lib/utils";

interface FundingTradeViewProps {
  userId: string;
  vaultOwnerToken: string;
}

const PENDING_TRADE_STATUSES = new Set([
  "queued",
  "funding_pending",
  "ready_to_trade",
  "order_submitted",
  "order_partially_filled",
]);

function compactAccountId(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "Unknown account";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function intentStatusTone(status: string | null | undefined): string {
  const normalized = String(status || "").trim().toLowerCase();
  if (["order_filled"].includes(normalized)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 dark:border-emerald-400/30 dark:bg-emerald-400/10";
  }
  if (["failed", "order_canceled"].includes(normalized)) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 dark:border-rose-400/30 dark:bg-rose-400/10";
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 dark:border-sky-400/30 dark:bg-sky-400/10";
}

export function FundingTradeView({ userId, vaultOwnerToken }: FundingTradeViewProps) {
  const router = useRouter();
  const { vaultKey } = useVault();
  const [isLinkingFunding, setIsLinkingFunding] = useState(false);
  const [isLinkingBrokerage, setIsLinkingBrokerage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [amountInput, setAmountInput] = useState("100.00");
  const [legalNameInput, setLegalNameInput] = useState("");
  const [selectedFundingAccountId, setSelectedFundingAccountId] = useState("");
  const [selectedBrokerageAccountId, setSelectedBrokerageAccountId] = useState("");
  const [intentRows, setIntentRows] = useState<PlaidFundingTradeIntentRef[]>([]);
  const [refreshingIntentId, setRefreshingIntentId] = useState<string | null>(null);

  const { isLoading, error, plaidFundingStatus, reload } = usePortfolioSources({
    userId,
    vaultOwnerToken,
    vaultKey,
  });

  const fundingItem = (plaidFundingStatus?.items || [])[0] || null;
  const fundingAccounts = fundingItem?.accounts || [];
  const selectedFundingDefault =
    fundingItem?.selected_funding_account_id ||
    fundingAccounts.find((account) => account.is_selected_funding_account)?.account_id ||
    fundingAccounts[0]?.account_id ||
    "";
  const brokerageOptions = useMemo(
    () =>
      (plaidFundingStatus?.brokerage_accounts || [])
        .map((row) => {
          const accountId = String(row.alpaca_account_id || "").trim();
          if (!accountId) return null;
          return {
            accountId,
            label: row.is_default
              ? `Alpaca · ${compactAccountId(accountId)} (default)`
              : `Alpaca · ${compactAccountId(accountId)}`,
          };
        })
        .filter((row): row is { accountId: string; label: string } => row !== null),
    [plaidFundingStatus?.brokerage_accounts]
  );

  useEffect(() => {
    if (selectedFundingDefault && selectedFundingDefault !== selectedFundingAccountId) {
      setSelectedFundingAccountId(selectedFundingDefault);
    }
  }, [selectedFundingAccountId, selectedFundingDefault]);

  useEffect(() => {
    const defaultBrokerage = brokerageOptions[0]?.accountId || "";
    if (defaultBrokerage && !selectedBrokerageAccountId) {
      setSelectedBrokerageAccountId(defaultBrokerage);
    }
  }, [brokerageOptions, selectedBrokerageAccountId]);

  useEffect(() => {
    const latest = Array.isArray(plaidFundingStatus?.latest_trade_intents)
      ? plaidFundingStatus.latest_trade_intents
      : [];
    setIntentRows(latest);
  }, [plaidFundingStatus?.latest_trade_intents]);

  const openFundingLink = useCallback(async () => {
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
        itemId: fundingItem?.item_id,
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
          returnPath: ROUTES.KAI_FUNDING_TRADE,
          startedAt: new Date().toISOString(),
        });
      }

      const Plaid = await loadPlaidLink();
      await new Promise<void>((resolve, reject) => {
        const handler = Plaid.create({
          token: linkToken.link_token!,
          onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
            void PlaidPortfolioService.exchangeFundingPublicToken({
              userId,
              publicToken,
              vaultOwnerToken,
              metadata,
              resumeSessionId: linkToken.resume_session_id || null,
              consentTimestamp: new Date().toISOString(),
            })
              .then(() => resolve())
              .catch((loadError) => reject(loadError))
              .finally(() => handler.destroy?.());
          },
          onExit: () => {
            handler.destroy?.();
            resolve();
          },
        });
        handler.open();
      });
      clearPlaidOAuthResumeSession();
      toast.success("Funding account linked.");
      await reload();
    } catch (loadError) {
      clearPlaidOAuthResumeSession();
      toast.error("Could not start funding account linking.", {
        description: loadError instanceof Error ? loadError.message : "Please try again.",
      });
    } finally {
      setIsLinkingFunding(false);
    }
  }, [fundingItem?.item_id, reload, userId, vaultOwnerToken]);

  const connectBrokerage = useCallback(async () => {
    if (!vaultOwnerToken) {
      toast.error("Please unlock your Vault and try again.");
      return;
    }
    setIsLinkingBrokerage(true);
    try {
      await PlaidPortfolioService.setFundingBrokerageAccount({
        userId,
        vaultOwnerToken,
        setDefault: true,
        alpacaAccountId: selectedBrokerageAccountId || null,
      });
      await reload();
      toast.success("Alpaca brokerage funding destination is ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again.";
      const shouldStartOAuth =
        /No Alpaca brokerage account is configured/i.test(message) ||
        /ALPACA_ACCOUNT_REQUIRED/i.test(message);
      if (!shouldStartOAuth) {
        toast.error("Could not connect brokerage account.", {
          description: message,
        });
        return;
      }
      try {
        const connect = await PlaidPortfolioService.startAlpacaConnect({
          userId,
          vaultOwnerToken,
        });
        if (!connect.authorization_url || !connect.state) {
          throw new Error("Alpaca OAuth is not configured for this environment.");
        }
        saveAlpacaOAuthResumeSession({
          version: 1,
          userId,
          state: connect.state,
          returnPath: ROUTES.KAI_FUNDING_TRADE,
          startedAt: new Date().toISOString(),
        });
        window.location.assign(connect.authorization_url);
      } catch (oauthError) {
        toast.error("Could not start Alpaca login.", {
          description: oauthError instanceof Error ? oauthError.message : "Please try again.",
        });
      }
    } finally {
      setIsLinkingBrokerage(false);
    }
  }, [reload, selectedBrokerageAccountId, userId, vaultOwnerToken]);

  const refreshIntent = useCallback(
    async (intentId: string) => {
      if (!vaultOwnerToken || !intentId) return;
      setRefreshingIntentId(intentId);
      try {
        const response = await PlaidPortfolioService.refreshFundedTradeIntent({
          userId,
          intentId,
          vaultOwnerToken,
        });
        setIntentRows((current) => {
          const next = [...current];
          const index = next.findIndex((row) => row.intent_id === intentId);
          if (index >= 0) {
            next[index] = response.intent;
            return next;
          }
          return [response.intent, ...next];
        });
      } catch (error) {
        toast.error("Could not refresh trade status.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setRefreshingIntentId(null);
      }
    },
    [userId, vaultOwnerToken]
  );

  const createFundAndTrade = useCallback(async () => {
    if (!vaultOwnerToken) {
      toast.error("Please unlock your Vault and try again.");
      return;
    }
    if (!fundingItem?.item_id || !selectedFundingAccountId) {
      toast.error("Select a linked funding account first.");
      return;
    }
    if (!legalNameInput.trim()) {
      toast.error("Legal name is required.");
      return;
    }
    if (!selectedBrokerageAccountId) {
      toast.error("Connect an Alpaca brokerage account first.");
      return;
    }
    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid USD amount.");
      return;
    }

    setIsSubmitting(true);
    try {
      const nonce =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}`;
      const response = await PlaidPortfolioService.createFundedTradeIntent({
        userId,
        vaultOwnerToken,
        fundingItemId: fundingItem.item_id,
        fundingAccountId: selectedFundingAccountId,
        symbol: symbolInput.trim().toUpperCase(),
        userLegalName: legalNameInput.trim(),
        notionalUsd: amount,
        side: "buy",
        orderType: "market",
        timeInForce: "day",
        brokerageAccountId: selectedBrokerageAccountId,
        tradeIdempotencyKey: `kai_trade_${userId}_${nonce}`,
        transferIdempotencyKey: `kai_transfer_${userId}_${nonce}`,
      });
      setIntentRows((current) => [response.intent, ...current.filter((row) => row.intent_id !== response.intent.intent_id)]);
      toast.success("One-click Fund + Trade submitted.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again.";
      const shouldStartOAuth =
        /No Alpaca brokerage account is configured/i.test(message) ||
        /ALPACA_ACCOUNT_REQUIRED/i.test(message);
      if (shouldStartOAuth) {
        await connectBrokerage();
        return;
      }
      toast.error("Could not create funded trade.", {
        description: message,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    amountInput,
    connectBrokerage,
    fundingItem?.item_id,
    legalNameInput,
    reload,
    selectedBrokerageAccountId,
    selectedFundingAccountId,
    symbolInput,
    userId,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!vaultOwnerToken) return;
    const pending = intentRows
      .filter((row) => PENDING_TRADE_STATUSES.has(String(row.status || "").trim().toLowerCase()))
      .slice(0, 3);
    if (!pending.length) return;

    const timer = window.setInterval(() => {
      for (const row of pending) {
        const intentId = String(row.intent_id || "").trim();
        if (intentId) {
          void refreshIntent(intentId);
        }
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [intentRows, refreshIntent, vaultOwnerToken]);

  return (
    <AppPageShell as="div" width="wide" className="pb-10">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Kai Trading"
          title="One-Click Fund + Trade"
          description="Pick a stock and amount. Kai moves cash from your linked bank account to Alpaca, then executes the order as soon as funding is available."
          icon={BadgeDollarSign}
          accent="sky"
          actions={
            <>
              <Button variant="none" effect="fade" onClick={() => router.push(ROUTES.KAI_INVESTMENTS)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to investments
              </Button>
              <Button variant="none" effect="fade" onClick={() => void reload()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>
          {error ? (
            <SurfaceCard tone="warning">
              <SurfaceCardContent className="py-3 text-sm text-muted-foreground">
                {error}
              </SurfaceCardContent>
            </SurfaceCard>
          ) : null}

          <SurfaceCard>
            <SurfaceCardContent className="space-y-4 p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  Linked funding account
                  <select
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={selectedFundingAccountId}
                    onChange={(event) => setSelectedFundingAccountId(event.target.value)}
                    disabled={isLoading || !fundingAccounts.length}
                  >
                    {fundingAccounts.length ? (
                      fundingAccounts.map((account) => (
                        <option key={account.account_id} value={account.account_id}>
                          {`${account.name || account.official_name || account.account_id} ${account.mask ? `•••• ${account.mask}` : ""}`}
                        </option>
                      ))
                    ) : (
                      <option value="">No funding accounts linked</option>
                    )}
                  </select>
                </label>

                <label className="space-y-1 text-xs text-muted-foreground">
                  Alpaca brokerage destination
                  <select
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={selectedBrokerageAccountId}
                    onChange={(event) => setSelectedBrokerageAccountId(event.target.value)}
                    disabled={!brokerageOptions.length}
                  >
                    {brokerageOptions.length ? (
                      brokerageOptions.map((option) => (
                        <option key={option.accountId} value={option.accountId}>
                          {option.label}
                        </option>
                      ))
                    ) : (
                      <option value="">No Alpaca account connected</option>
                    )}
                  </select>
                </label>

                <label className="space-y-1 text-xs text-muted-foreground">
                  Stock ticker
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={symbolInput}
                    onChange={(event) => setSymbolInput(event.target.value.toUpperCase())}
                    placeholder="AAPL"
                  />
                </label>

                <label className="space-y-1 text-xs text-muted-foreground">
                  Notional amount (USD)
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={amountInput}
                    onChange={(event) => setAmountInput(event.target.value)}
                    inputMode="decimal"
                    placeholder="100.00"
                  />
                </label>

                <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                  Legal name on funding account
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={legalNameInput}
                    onChange={(event) => setLegalNameInput(event.target.value)}
                    placeholder="Name on bank account"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="none"
                  effect="fade"
                  disabled={isLinkingFunding}
                  onClick={() => void openFundingLink()}
                >
                  {isLinkingFunding ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <WalletCards className="mr-2 h-4 w-4" />
                  )}
                  {fundingItem ? "Manage funding account" : "Connect funding account"}
                </Button>
                <Button
                  variant="none"
                  effect="fade"
                  disabled={isLinkingBrokerage}
                  onClick={() => void connectBrokerage()}
                >
                  {isLinkingBrokerage ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4" />
                  )}
                  {brokerageOptions.length ? "Manage brokerage account" : "Connect brokerage account"}
                </Button>
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  disabled={isSubmitting}
                  onClick={() => void createFundAndTrade()}
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <BadgeDollarSign className="mr-2 h-4 w-4" />
                  )}
                  Fund and trade
                </Button>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceCard>
            <SurfaceCardContent className="space-y-3 p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">Trade execution timeline</h2>
                <span className="text-xs text-muted-foreground">
                  {intentRows.length} recent request{intentRows.length === 1 ? "" : "s"}
                </span>
              </div>

              {intentRows.length ? (
                intentRows.map((intent) => {
                  const intentId = String(intent.intent_id || "").trim();
                  return (
                    <div
                      key={intentId || `${intent.symbol}-${intent.requested_at}`}
                      className="rounded-xl border border-border/60 bg-background/80 px-3 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">
                          {(intent.symbol || "—").toUpperCase()} · ${intent.notional_usd || "0.00"}
                        </p>
                        <Badge
                          variant="outline"
                          className={cn("rounded-full px-2.5 py-0.5 text-[11px]", intentStatusTone(intent.status))}
                        >
                          {intent.status || "queued"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[
                          intent.transfer_id ? `Transfer ${compactAccountId(intent.transfer_id)}` : null,
                          intent.order_id ? `Order ${compactAccountId(intent.order_id)}` : null,
                          intent.requested_at ? `Requested ${formatTimestamp(intent.requested_at)}` : null,
                          intent.executed_at ? `Executed ${formatTimestamp(intent.executed_at)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" • ")}
                      </p>
                      {intent.failure_message ? (
                        <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">
                          {intent.failure_message}
                        </p>
                      ) : null}
                      {intentId ? (
                        <div className="mt-2">
                          <Button
                            variant="none"
                            effect="fade"
                            size="sm"
                            disabled={refreshingIntentId === intentId}
                            onClick={() => void refreshIntent(intentId)}
                          >
                            {refreshingIntentId === intentId ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Refresh status
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-4 text-xs text-muted-foreground">
                  No funded trade requests yet. Create your first one-click trade above.
                </div>
              )}
            </SurfaceCardContent>
          </SurfaceCard>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
