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
import { ApiService } from "@/lib/services/api-service";
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
const AUTO_REFRESH_INTERVAL_MS = 12_000;
const AUTO_REFRESH_BATCH_SIZE = 3;

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

type AlpacaMarketTrade = {
  price: number | null;
  size: number | null;
  exchange: string | null;
  tape: string | null;
  timestamp: string | null;
};

type AlpacaMarketQuote = {
  bidPrice: number | null;
  bidSize: number | null;
  bidExchange: string | null;
  askPrice: number | null;
  askSize: number | null;
  askExchange: string | null;
  timestamp: string | null;
};

type AlpacaMarketBar = {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap: number | null;
  tradeCount: number | null;
  timestamp: string | null;
};

type AlpacaMarketSnapshot = {
  latestTrade: AlpacaMarketTrade | null;
  latestQuote: AlpacaMarketQuote | null;
  minuteBar: AlpacaMarketBar | null;
  dailyBar: AlpacaMarketBar | null;
  prevDailyBar: AlpacaMarketBar | null;
};

type AlpacaStockDetail = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  assetClass: string | null;
  status: string | null;
  active: boolean | null;
  tradable: boolean | null;
  marginable: boolean | null;
  shortable: boolean | null;
  easyToBorrow: boolean | null;
  fractionable: boolean | null;
  maintenanceMarginRequirement: number | null;
  attributes: string[];
  currency: string | null;
  market: AlpacaMarketSnapshot | null;
};

type AlpacaSymbolsResponse = {
  items?: AlpacaStockDetail[];
  error?: string;
  details?: string;
};

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDecimal(value: number | null | undefined, maxDigits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: maxDigits }).format(value);
}

function formatStockStatus(detail: AlpacaStockDetail | null): string {
  if (!detail) return "No stock selected";
  const status = detail.status || (detail.active === true ? "active" : detail.active === false ? "inactive" : "unknown");
  const tradable = detail.tradable === null ? "tradability unknown" : detail.tradable ? "tradable" : "not tradable";
  return `${status} · ${tradable}`;
}

async function fetchAlpacaStockDetails(query: string, limit = 8): Promise<AlpacaStockDetail[]> {
  const normalized = String(query || "").trim().toUpperCase();
  if (!normalized) return [];

  const response = await ApiService.apiFetch(
    `/api/alpaca/symbols?q=${encodeURIComponent(normalized)}&limit=${limit}`,
    { method: "GET" }
  );
  const payload = (await response.json().catch(() => ({}))) as AlpacaSymbolsResponse;
  if (!response.ok) {
    const errorMessage =
      payload.error ||
      (typeof payload.details === "string" && payload.details.trim().length ? payload.details : null) ||
      "Alpaca stock lookup failed.";
    throw new Error(errorMessage);
  }
  return Array.isArray(payload.items) ? payload.items : [];
}

export function FundingTradeView({ userId, vaultOwnerToken }: FundingTradeViewProps) {
  const router = useRouter();
  const { vaultKey } = useVault();
  const [isLinkingFunding, setIsLinkingFunding] = useState(false);
  const [isLinkingBrokerage, setIsLinkingBrokerage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [symbolSuggestions, setSymbolSuggestions] = useState<AlpacaStockDetail[]>([]);
  const [selectedSymbolDetail, setSelectedSymbolDetail] = useState<AlpacaStockDetail | null>(null);
  const [isLoadingSymbolDetails, setIsLoadingSymbolDetails] = useState(false);
  const [symbolLookupError, setSymbolLookupError] = useState<string | null>(null);
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
    let cancelled = false;
    const q = String(symbolInput || "").trim().toUpperCase();
    if (!q) {
      setSymbolSuggestions([]);
      setSelectedSymbolDetail(null);
      setIsLoadingSymbolDetails(false);
      setSymbolLookupError(null);
      return;
    }

    const handle = window.setTimeout(async () => {
      setIsLoadingSymbolDetails(true);
      try {
        const details = await fetchAlpacaStockDetails(q, 8);
        if (cancelled) return;

        setSymbolSuggestions(details);
        const exactMatch = details.find((item) => item.symbol === q) || null;
        setSelectedSymbolDetail(exactMatch || details[0] || null);
        setSymbolLookupError(details.length ? null : `No Alpaca stock matches "${q}".`);
      } catch (lookupError) {
        if (cancelled) return;
        setSymbolSuggestions([]);
        setSelectedSymbolDetail(null);
        setSymbolLookupError(
          lookupError instanceof Error ? lookupError.message : "Could not load Alpaca stock details."
        );
      } finally {
        if (!cancelled) {
          setIsLoadingSymbolDetails(false);
        }
      }
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [symbolInput]);

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

  const pendingIntentIds = useMemo(
    () =>
      intentRows
        .filter((row) => PENDING_TRADE_STATUSES.has(String(row.status || "").trim().toLowerCase()))
        .map((row) => String(row.intent_id || "").trim())
        .filter((intentId) => intentId.length > 0),
    [intentRows]
  );

  useEffect(() => {
    if (!vaultOwnerToken || pendingIntentIds.length === 0) return;

    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const ids = pendingIntentIds.slice(0, AUTO_REFRESH_BATCH_SIZE);
        const refreshed = await Promise.allSettled(
          ids.map((intentId) =>
            PlaidPortfolioService.refreshFundedTradeIntent({
              userId,
              intentId,
              vaultOwnerToken,
            })
          )
        );
        if (cancelled) return;

        const refreshedIntents = refreshed.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.intent] : []
        );
        if (!refreshedIntents.length) return;

        setIntentRows((current) => {
          const next = [...current];
          for (const refreshedIntent of refreshedIntents) {
            const refreshedId = String(refreshedIntent.intent_id || "").trim();
            if (!refreshedId) continue;
            const index = next.findIndex(
              (row) => String(row.intent_id || "").trim() === refreshedId
            );
            if (index >= 0) {
              next[index] = refreshedIntent;
            } else {
              next.unshift(refreshedIntent);
            }
          }
          return next;
        });
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingIntentIds, userId, vaultOwnerToken]);

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
    const normalizedSymbol = String(symbolInput || "").trim().toUpperCase();
    if (!normalizedSymbol) {
      toast.error("Stock ticker is required.");
      return;
    }

    setIsSubmitting(true);
    try {
      let resolvedSymbolDetail =
        selectedSymbolDetail?.symbol === normalizedSymbol ? selectedSymbolDetail : null;

      if (!resolvedSymbolDetail) {
        const refreshedDetails = await fetchAlpacaStockDetails(normalizedSymbol, 8);
        resolvedSymbolDetail =
          refreshedDetails.find((item) => item.symbol === normalizedSymbol) || null;
      }

      if (!resolvedSymbolDetail) {
        toast.error("Select a valid Alpaca stock symbol before trading.");
        return;
      }

      if (resolvedSymbolDetail.active === false) {
        toast.error(`${resolvedSymbolDetail.symbol} is inactive on Alpaca.`);
        return;
      }

      if (resolvedSymbolDetail.tradable === false) {
        toast.error(`${resolvedSymbolDetail.symbol} is not tradable on Alpaca.`);
        return;
      }

      setSelectedSymbolDetail(resolvedSymbolDetail);

      const nonce =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}`;
      const response = await PlaidPortfolioService.createFundedTradeIntent({
        userId,
        vaultOwnerToken,
        fundingItemId: fundingItem.item_id,
        fundingAccountId: selectedFundingAccountId,
        symbol: resolvedSymbolDetail.symbol,
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
    selectedSymbolDetail,
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
                  <div className="relative">
                    <input
                      list="alpaca-symbols"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground"
                      value={symbolInput}
                      onChange={(event) => {
                        const nextValue = String(event.target.value || "")
                          .toUpperCase()
                          .replace(/[^A-Z0-9.\-]/g, "");
                        setSymbolInput(nextValue);
                        setSymbolLookupError(null);
                      }}
                      placeholder="AAPL"
                      autoComplete="off"
                    />
                    {isLoadingSymbolDetails ? (
                      <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    ) : null}
                  </div>
                  <datalist id="alpaca-symbols">
                    {symbolSuggestions.map((s) => (
                      <option key={s.symbol} value={s.symbol}>
                        {[s.symbol, s.name, s.exchange].filter(Boolean).join(" — ")}
                      </option>
                    ))}
                  </datalist>
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

                <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground sm:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {selectedSymbolDetail
                        ? `${selectedSymbolDetail.symbol} — ${selectedSymbolDetail.name || "Unknown company"}`
                        : "Type a ticker to fetch Alpaca stock details"}
                    </p>
                    <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px]">
                      {formatStockStatus(selectedSymbolDetail)}
                    </Badge>
                  </div>

                  {selectedSymbolDetail ? (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="rounded-lg border border-border/60 bg-background/80 p-2">
                        <p className="text-[11px] text-muted-foreground">Last trade</p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatMoney(selectedSymbolDetail.market?.latestTrade?.price)}
                        </p>
                        <p className="text-[11px]">
                          {formatTimestamp(selectedSymbolDetail.market?.latestTrade?.timestamp)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-background/80 p-2">
                        <p className="text-[11px] text-muted-foreground">Bid / Ask</p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatMoney(selectedSymbolDetail.market?.latestQuote?.bidPrice)} /{" "}
                          {formatMoney(selectedSymbolDetail.market?.latestQuote?.askPrice)}
                        </p>
                        <p className="text-[11px]">
                          {formatTimestamp(selectedSymbolDetail.market?.latestQuote?.timestamp)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-background/80 p-2">
                        <p className="text-[11px] text-muted-foreground">Day close / volume</p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatMoney(selectedSymbolDetail.market?.dailyBar?.close)} /{" "}
                          {formatDecimal(selectedSymbolDetail.market?.dailyBar?.volume, 0)}
                        </p>
                        <p className="text-[11px]">
                          {formatTimestamp(selectedSymbolDetail.market?.dailyBar?.timestamp)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p>Kai will fetch company, tradability, and live quote snapshot from Alpaca.</p>
                  )}

                  {symbolSuggestions.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {symbolSuggestions.slice(0, 8).map((detail) => (
                        <button
                          key={detail.symbol}
                          type="button"
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[11px] transition",
                            detail.symbol === selectedSymbolDetail?.symbol
                              ? "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              : "border-border/70 bg-background text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => {
                            setSymbolInput(detail.symbol);
                            setSelectedSymbolDetail(detail);
                            setSymbolLookupError(null);
                          }}
                        >
                          {detail.symbol}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {symbolLookupError ? (
                    <p className="text-xs text-rose-700 dark:text-rose-300">{symbolLookupError}</p>
                  ) : null}
                </div>
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
