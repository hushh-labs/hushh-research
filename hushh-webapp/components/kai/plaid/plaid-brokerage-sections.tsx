"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  Building2,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  WalletCards,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import type {
  PlaidAccountSummary,
  PlaidFundingBrokerageAccountSummary,
  PlaidFundingStatusResponse,
  PlaidFundingTransferRef,
  PlaidItemSummary,
} from "@/lib/kai/brokerage/portfolio-sources";
import { cn } from "@/lib/utils";

function formatCurrency(value: number | null | undefined, currency = "USD"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Value unavailable";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatRelativeTimestamp(value: string | null | undefined): string {
  if (!value) return "Not synced yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not synced yet";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function compactAccountId(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "Unknown account";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

function accountSubtypeLabel(account: PlaidAccountSummary): string {
  const subtype = String(account.subtype || "").trim();
  const type = String(account.type || "").trim();
  return subtype || type || "Investment";
}

function accountCurrentValue(account: PlaidAccountSummary): number | null {
  const balances =
    account.balances && typeof account.balances === "object" ? account.balances : null;
  const current = balances?.current;
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function connectionHealth(item: PlaidItemSummary): {
  label: string;
  toneClassName: string;
  description: string;
  requiresAttention: boolean;
  isRefreshing: boolean;
} {
  const runStatus = String(item.latest_refresh_run?.status || "").trim();
  const syncStatus = String(item.sync_status || "").trim();
  const itemStatus = String(item.status || "").trim();

  if (runStatus === "queued" || runStatus === "running" || syncStatus === "running") {
    return {
      label: "Refreshing",
      toneClassName:
        "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 dark:border-sky-400/30 dark:bg-sky-400/10",
      description: "Brokerage refresh in progress.",
      requiresAttention: false,
      isRefreshing: true,
    };
  }
  if (itemStatus === "permission_revoked") {
    return {
      label: "Permission revoked",
      toneClassName:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 dark:border-amber-400/30 dark:bg-amber-400/10",
      description: "Broker access was revoked and needs to be reconnected.",
      requiresAttention: true,
      isRefreshing: false,
    };
  }
  if (itemStatus === "relink_required" || syncStatus === "action_required") {
    return {
      label: "Relink required",
      toneClassName:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 dark:border-amber-400/30 dark:bg-amber-400/10",
      description: "This connection needs your attention before it can refresh again.",
      requiresAttention: true,
      isRefreshing: false,
    };
  }
  if (itemStatus === "error" || syncStatus === "failed") {
    return {
      label: "Needs attention",
      toneClassName:
        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 dark:border-rose-400/30 dark:bg-rose-400/10",
      description: "Kai could not sync this brokerage recently.",
      requiresAttention: true,
      isRefreshing: false,
    };
  }
  if (syncStatus === "stale") {
    return {
      label: "Stale",
      toneClassName:
        "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300 dark:border-orange-400/30 dark:bg-orange-400/10",
      description: "Brokerage data is available, but freshness is aging.",
      requiresAttention: false,
      isRefreshing: false,
    };
  }
  return {
    label: "Active",
    toneClassName:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 dark:border-emerald-400/30 dark:bg-emerald-400/10",
    description: "Brokerage data is connected and ready.",
    requiresAttention: false,
    isRefreshing: false,
  };
}

function flattenPlaidAccounts(items: PlaidItemSummary[]): Array<PlaidAccountSummary & {
  connectionStatusLabel: string;
}> {
  return items.flatMap((item) =>
    (item.accounts || []).map((account) => ({
      ...account,
      institution_name: account.institution_name || item.institution_name || null,
      connectionStatusLabel: connectionHealth(item).label,
    }))
  );
}

function PlaidStatusBadge({ item }: { item: PlaidItemSummary }) {
  const health = connectionHealth(item);
  return (
    <span className="inline-flex items-center gap-1.5">
      {health.isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" /> : null}
      <Badge variant="outline" className={cn("rounded-full px-2.5 py-0.5 text-[11px]", health.toneClassName)}>
        {health.label}
      </Badge>
    </span>
  );
}

interface PlaidBrokerageSummarySectionProps {
  items: PlaidItemSummary[];
  onRefreshItem?: (itemId?: string) => Promise<void> | void;
  onCancelRefresh?: (params?: { itemId?: string; runIds?: string[] }) => Promise<void> | void;
  onManageConnection?: (itemId?: string) => Promise<void> | void;
  onViewInvestments?: () => void;
  className?: string;
}

export function PlaidBrokerageSummarySection({
  items,
  onRefreshItem,
  onCancelRefresh,
  onManageConnection,
  onViewInvestments,
  className,
}: PlaidBrokerageSummarySectionProps) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const selectedItem = useMemo(
    () => items.find((item) => item.item_id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  if (!items.length) return null;

  return (
    <>
      <SettingsGroup
        className={className}
        eyebrow="Connected brokerages"
        title="Plaid-linked investment accounts"
        description="Read-only brokerages stay broker-sourced here, while statements remain your editable source."
      >
        {items.map((item) => {
          const health = connectionHealth(item);
          const accountsCount = item.accounts?.length || 0;
          const totalValue = Number(item.summary?.total_value || item.portfolio_data?.total_value || 0);
          return (
            <SettingsRow
              key={item.item_id}
              icon={Building2}
              title={item.institution_name || item.institution_id || "Connected brokerage"}
              description={`${accountsCount} account${accountsCount === 1 ? "" : "s"} • ${health.description} • Last sync ${formatRelativeTimestamp(item.last_synced_at)}`}
              trailing={
                <div className="flex items-center gap-2">
                  <div className="hidden text-right sm:block">
                    <p className="text-[13px] font-semibold text-foreground">
                      {formatCurrency(Number.isFinite(totalValue) ? totalValue : null)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">Current value</p>
                  </div>
                  <PlaidStatusBadge item={item} />
                </div>
              }
              chevron
              onClick={() => setSelectedItemId(item.item_id)}
            />
          );
        })}
      </SettingsGroup>

      <SettingsDetailPanel
        open={Boolean(selectedItem)}
        onOpenChange={(open) => {
          if (!open) setSelectedItemId(null);
        }}
        title={selectedItem?.institution_name || "Connected brokerage"}
        description={
          selectedItem
            ? `${selectedItem.accounts?.length || 0} account${(selectedItem.accounts?.length || 0) === 1 ? "" : "s"} • Last sync ${formatRelativeTimestamp(selectedItem.last_synced_at)}`
            : undefined
        }
      >
        {selectedItem ? (
          <div className="space-y-4">
            {(selectedItem.last_error_message || connectionHealth(selectedItem).requiresAttention) ? (
              <div className="rounded-[20px] border border-amber-500/20 bg-amber-500/8 p-4">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">
                      {connectionHealth(selectedItem).label}
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {selectedItem.last_error_message || connectionHealth(selectedItem).description}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {connectionHealth(selectedItem).isRefreshing ? (
                <Button
                  variant="none"
                  effect="fade"
                  onClick={() =>
                    void onCancelRefresh?.({
                      itemId: selectedItem.item_id,
                      runIds: selectedItem.latest_refresh_run?.run_id
                        ? [selectedItem.latest_refresh_run.run_id]
                        : [],
                    })
                  }
                >
                  <X className="mr-2 h-4 w-4" />
                  Cancel refresh
                </Button>
              ) : (
                <Button
                  variant="none"
                  effect="fade"
                  onClick={() => void onRefreshItem?.(selectedItem.item_id)}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
              )}
              <Button
                variant="none"
                effect="fade"
                onClick={() => void onManageConnection?.(selectedItem.item_id)}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                Manage connection
              </Button>
              {onViewInvestments ? (
                <Button variant="none" effect="fade" onClick={onViewInvestments}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View investments
                </Button>
              ) : null}
            </div>

            <SettingsGroup
              eyebrow="Accounts"
              title="Investment accounts"
              description="Each linked account stays read-only and keeps its brokerage metadata."
            >
              {(selectedItem.accounts || []).map((account) => {
                const currencyCode = String(account.balances?.iso_currency_code || "USD");
                return (
                  <SettingsRow
                    key={account.account_id}
                    icon={WalletCards}
                    title={account.name || account.official_name || "Investment account"}
                    description={[
                      accountSubtypeLabel(account),
                      account.mask ? `•••• ${account.mask}` : null,
                      selectedItem.institution_name || null,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                    trailing={
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[11px]">
                          {accountSubtypeLabel(account)}
                        </Badge>
                        <div className="text-right">
                          <p className="text-[13px] font-semibold text-foreground">
                            {formatCurrency(accountCurrentValue(account), currencyCode)}
                          </p>
                          <p className="text-[11px] text-muted-foreground">Current balance</p>
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </SettingsGroup>
          </div>
        ) : null}
      </SettingsDetailPanel>
    </>
  );
}

export function PlaidInvestmentAccountsSection({
  items,
  className,
}: {
  items: PlaidItemSummary[];
  className?: string;
}) {
  const accounts = useMemo(() => flattenPlaidAccounts(items), [items]);
  if (!accounts.length) return null;

  return (
    <SettingsGroup
      className={className}
      eyebrow="Investment accounts"
      title="Accounts connected through Plaid"
      description="Account subtype, masked identifiers, institution, and current balance stay visible even when holdings are sparse."
    >
      {accounts.map((account) => {
        const currencyCode = String(account.balances?.iso_currency_code || "USD");
        return (
          <SettingsRow
            key={`${account.item_id}:${account.account_id}`}
            icon={BadgeDollarSign}
            title={account.name || account.official_name || "Investment account"}
            description={[
              account.institution_name || null,
              accountSubtypeLabel(account),
              account.mask ? `•••• ${account.mask}` : null,
              account.connectionStatusLabel,
            ]
              .filter(Boolean)
              .join(" • ")}
            trailing={
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[11px]">
                  {accountSubtypeLabel(account)}
                </Badge>
                <div className="text-right">
                  <p className="text-[13px] font-semibold text-foreground">
                    {formatCurrency(accountCurrentValue(account), currencyCode)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Current balance</p>
                </div>
              </div>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}

interface PlaidFundingTransfersSectionProps {
  fundingStatus: PlaidFundingStatusResponse | null;
  onManageBrokerage?: () => Promise<void> | void;
  onConnectFunding?: (itemId?: string) => Promise<void> | void;
  onSetDefaultFundingAccount?: (payload: { itemId: string; accountId: string }) => Promise<void> | void;
  onRunReconciliation?: () => Promise<void> | void;
  onCreateTransfer?: (payload: {
    fundingItemId: string;
    fundingAccountId: string;
    brokerageItemId?: string | null;
    brokerageAccountId?: string | null;
    amount: number;
    userLegalName: string;
    direction: "to_brokerage" | "from_brokerage";
    idempotencyKey: string;
  }) => Promise<void> | void;
  onRefreshTransfer?: (transferId: string) => Promise<void> | void;
  onCancelTransfer?: (transferId: string) => Promise<void> | void;
  onSearchFundingRecords?: (payload: {
    transferId?: string;
    relationshipId?: string;
    limit?: number;
  }) => Promise<{ count: number; items: Array<Record<string, unknown>> }> | { count: number; items: Array<Record<string, unknown>> };
  onCreateFundingEscalation?: (payload: {
    transferId?: string;
    relationshipId?: string;
    severity: "low" | "normal" | "high" | "urgent";
    notes: string;
  }) => Promise<void> | void;
  isConnectingFunding?: boolean;
  isSubmittingTransfer?: boolean;
  isReconciling?: boolean;
  className?: string;
}

function transferStatusTone(status: string | null | undefined): string {
  const normalized = String(status || "").trim().toLowerCase();
  if (["pending", "submitted", "queued", "processing", "approval_pending"].includes(normalized)) {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 dark:border-sky-400/30 dark:bg-sky-400/10";
  }
  if (["failed", "canceled", "returned", "rejected"].includes(normalized)) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 dark:border-rose-400/30 dark:bg-rose-400/10";
  }
  if (["posted", "completed", "complete", "settled", "funds_available"].includes(normalized)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 dark:border-emerald-400/30 dark:bg-emerald-400/10";
  }
  return "border-muted bg-muted/20 text-muted-foreground";
}

function relationshipStatusTone(status: string | null | undefined): string {
  const normalized = String(status || "").trim().toLowerCase();
  if (["approved"].includes(normalized)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 dark:border-emerald-400/30 dark:bg-emerald-400/10";
  }
  if (["queued", "pending", "submitted"].includes(normalized)) {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 dark:border-sky-400/30 dark:bg-sky-400/10";
  }
  if (["rejected", "canceled", "disabled", "error"].includes(normalized)) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 dark:border-rose-400/30 dark:bg-rose-400/10";
  }
  return "border-muted bg-muted/20 text-muted-foreground";
}

function readRecordText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function PlaidFundingTransfersSection({
  fundingStatus,
  onManageBrokerage,
  onConnectFunding,
  onSetDefaultFundingAccount,
  onRunReconciliation,
  onCreateTransfer,
  onRefreshTransfer,
  onCancelTransfer,
  onSearchFundingRecords,
  onCreateFundingEscalation,
  isConnectingFunding = false,
  isSubmittingTransfer = false,
  isReconciling = false,
  className,
}: PlaidFundingTransfersSectionProps) {
  const fundingItem = (fundingStatus?.items || [])[0] || null;
  const fundingAccounts = fundingItem?.accounts || [];
  const selectedFundingDefault =
    fundingItem?.selected_funding_account_id ||
    fundingAccounts.find((account) => account.is_selected_funding_account)?.account_id ||
    fundingAccounts[0]?.account_id ||
    "";
  const mappedBrokerageAccounts = useMemo(
    () =>
      ((fundingStatus?.brokerage_accounts || []) as PlaidFundingBrokerageAccountSummary[]),
    [fundingStatus?.brokerage_accounts]
  );
  const brokerageAccountOptions = useMemo(
    () =>
      mappedBrokerageAccounts
        .map((account) => {
          const accountId = String(account.alpaca_account_id || "").trim();
          if (!accountId) return null;
          const status = String(account.status || "active").trim().toLowerCase() || "active";
          const defaultLabel = account.is_default ? "default" : null;
          const statusLabel = status && status !== "active" ? status : null;
          return {
            accountId,
            label: [
              `Alpaca · ${compactAccountId(accountId)}`,
              defaultLabel,
              statusLabel,
            ]
              .filter(Boolean)
              .join(" • "),
          };
        })
        .filter(
          (option): option is { accountId: string; label: string } => option !== null
        ),
    [mappedBrokerageAccounts]
  );
  const [selectedFundingAccountId, setSelectedFundingAccountId] = useState<string>(selectedFundingDefault);
  const [selectedBrokerageAccountId, setSelectedBrokerageAccountId] = useState<string>(
    brokerageAccountOptions[0]?.accountId || ""
  );
  const [transferDirection, setTransferDirection] = useState<"to_brokerage" | "from_brokerage">(
    "to_brokerage"
  );
  const [amountInput, setAmountInput] = useState<string>("11.11");
  const [legalNameInput, setLegalNameInput] = useState<string>("");
  const [supportTransferId, setSupportTransferId] = useState<string>("");
  const [supportRelationshipId, setSupportRelationshipId] = useState<string>("");
  const [supportSeverity, setSupportSeverity] = useState<"low" | "normal" | "high" | "urgent">(
    "normal"
  );
  const [supportNotes, setSupportNotes] = useState<string>("");
  const [supportResults, setSupportResults] = useState<Array<Record<string, unknown>>>([]);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [isSearchingSupport, setIsSearchingSupport] = useState<boolean>(false);
  const [isEscalatingSupport, setIsEscalatingSupport] = useState<boolean>(false);

  const latestTransfers = useMemo(
    () =>
      ((fundingStatus?.latest_transfers || fundingItem?.transfers || []) as PlaidFundingTransferRef[]),
    [fundingItem?.transfers, fundingStatus?.latest_transfers]
  );
  const selectedFundingRelationship =
    (fundingItem?.relationships || []).find(
      (relationship) =>
        String(relationship.account_id || "").trim() === selectedFundingAccountId
    ) ||
    (fundingItem?.relationships || [])[0] ||
    null;
  const selectedRelationshipStatus = String(
    selectedFundingRelationship?.status || ""
  ).trim().toLowerCase();
  const relationshipApproved = selectedRelationshipStatus === "approved";
  const relationshipPending = ["queued", "pending", "submitted"].includes(
    selectedRelationshipStatus
  );
  const relationshipFailed = ["rejected", "canceled", "disabled", "error"].includes(
    selectedRelationshipStatus
  );
  const hasSupportTools = Boolean(onSearchFundingRecords || onCreateFundingEscalation);

  useEffect(() => {
    if (selectedFundingDefault && selectedFundingDefault !== selectedFundingAccountId) {
      setSelectedFundingAccountId(selectedFundingDefault);
    }
  }, [selectedFundingAccountId, selectedFundingDefault]);

  useEffect(() => {
    const firstBrokerageAccountId = brokerageAccountOptions[0]?.accountId || "";
    if (!selectedBrokerageAccountId && firstBrokerageAccountId) {
      setSelectedBrokerageAccountId(firstBrokerageAccountId);
    }
  }, [brokerageAccountOptions, selectedBrokerageAccountId]);

  useEffect(() => {
    if (!supportTransferId && latestTransfers[0]?.transfer_id) {
      setSupportTransferId(String(latestTransfers[0].transfer_id || "").trim());
    }
  }, [latestTransfers, supportTransferId]);

  useEffect(() => {
    const relationshipId = String(selectedFundingRelationship?.relationship_id || "").trim();
    if (!supportRelationshipId && relationshipId) {
      setSupportRelationshipId(relationshipId);
    }
  }, [selectedFundingRelationship?.relationship_id, supportRelationshipId]);

  const handleSupportSearch = async () => {
    if (!onSearchFundingRecords) return;
    setIsSearchingSupport(true);
    setSupportError(null);
    try {
      const response = await onSearchFundingRecords({
        transferId: supportTransferId || undefined,
        relationshipId: supportRelationshipId || undefined,
        limit: 25,
      });
      const items = Array.isArray(response?.items) ? response.items : [];
      setSupportResults(items);

      if (!supportTransferId) {
        const firstTransferId = readRecordText(items[0] || {}, "transfer_id");
        if (firstTransferId) setSupportTransferId(firstTransferId);
      }
      if (!supportRelationshipId) {
        const firstRelationshipId = readRecordText(items[0] || {}, "relationship_id");
        if (firstRelationshipId) setSupportRelationshipId(firstRelationshipId);
      }
    } catch (error) {
      setSupportError(
        error instanceof Error
          ? error.message
          : "Funding support records could not be loaded right now."
      );
    } finally {
      setIsSearchingSupport(false);
    }
  };

  const handleCreateEscalation = async () => {
    if (!onCreateFundingEscalation) return;
    const notes = supportNotes.trim();
    if (!notes) {
      setSupportError("Escalation notes are required.");
      return;
    }
    setIsEscalatingSupport(true);
    setSupportError(null);
    try {
      await onCreateFundingEscalation({
        transferId: supportTransferId || undefined,
        relationshipId: supportRelationshipId || undefined,
        severity: supportSeverity,
        notes,
      });
      setSupportNotes("");
    } catch (error) {
      setSupportError(
        error instanceof Error
          ? error.message
          : "Funding escalation could not be created right now."
      );
    } finally {
      setIsEscalatingSupport(false);
    }
  };

  return (
    <SettingsGroup
      className={className}
      eyebrow="Funding and transfers"
      title="Funding transfers"
      description="Connect a bank account through Plaid Auth and move cash to or from your Alpaca brokerage account."
    >
      <SettingsRow
        icon={WalletCards}
        title={
          fundingItem
            ? fundingItem.institution_name || "Connected funding account"
            : "No funding account connected"
        }
        description={
          fundingItem
            ? `${fundingAccounts.length} linked account${fundingAccounts.length === 1 ? "" : "s"} • Last sync ${formatRelativeTimestamp(fundingItem.last_synced_at)}`
            : "Connect a funding account to enable deposits and withdrawals."
        }
        trailing={
          <div className="flex flex-wrap items-center gap-2">
            {onRunReconciliation ? (
              <Button
                variant="none"
                effect="fade"
                disabled={isReconciling}
                onClick={() => void onRunReconciliation()}
              >
                {isReconciling ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Reconcile
              </Button>
            ) : null}
            <Button
              variant="none"
              effect="fade"
              disabled={isConnectingFunding}
              onClick={() => void onConnectFunding?.(fundingItem?.item_id)}
            >
              {isConnectingFunding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="mr-2 h-4 w-4" />
              )}
              {fundingItem ? "Manage funding link" : "Connect funding account"}
            </Button>
          </div>
        }
      />

      {fundingItem && fundingAccounts.length > 0 && onCreateTransfer ? (
        <div className="rounded-[20px] border border-border/60 bg-background/60 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Funding account
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={selectedFundingAccountId}
                onChange={(event) => {
                  const accountId = event.target.value;
                  setSelectedFundingAccountId(accountId);
                  if (fundingItem?.item_id && onSetDefaultFundingAccount) {
                    void onSetDefaultFundingAccount({
                      itemId: fundingItem.item_id,
                      accountId,
                    });
                  }
                }}
              >
                {fundingAccounts.map((account) => (
                  <option key={account.account_id} value={account.account_id}>
                    {`${account.name || account.official_name || account.account_id} ${account.mask ? `•••• ${account.mask}` : ""}`}
                  </option>
                ))}
              </select>
            </label>

            {brokerageAccountOptions.length > 0 ? (
              <label className="space-y-1 text-xs text-muted-foreground">
                Alpaca brokerage destination
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                  value={selectedBrokerageAccountId}
                  onChange={(event) => setSelectedBrokerageAccountId(event.target.value)}
                >
                  {brokerageAccountOptions.map((option) => (
                    <option key={option.accountId} value={option.accountId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="space-y-1 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Alpaca brokerage destination
                <p className="text-[11px] leading-5">
                  No mapped Alpaca account was found. Add or configure at least one Alpaca account
                  before creating transfers.
                </p>
                {onManageBrokerage ? (
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={() => void onManageBrokerage()}
                  >
                    Connect brokerage account
                  </Button>
                ) : null}
              </div>
            )}

            <label className="space-y-1 text-xs text-muted-foreground">
              Transfer direction
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={transferDirection}
                onChange={(event) =>
                  setTransferDirection(event.target.value as "to_brokerage" | "from_brokerage")
                }
              >
                <option value="to_brokerage">Deposit to brokerage</option>
                <option value="from_brokerage">Withdraw to bank</option>
              </select>
            </label>

            <label className="space-y-1 text-xs text-muted-foreground">
              Amount (USD)
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                inputMode="decimal"
                placeholder="100.00"
              />
              <div className="flex gap-2 pt-1">
                {["100.00", "250.00", "500.00"].map((preset) => (
                  <Button
                    key={preset}
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={() => setAmountInput(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </label>

            <label className="space-y-1 text-xs text-muted-foreground">
              Legal name
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={legalNameInput}
                onChange={(event) => setLegalNameInput(event.target.value)}
                placeholder="Name on funding account"
              />
            </label>
          </div>
          <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span>ACH relationship</span>
              <Badge
                variant="outline"
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px]",
                  relationshipStatusTone(selectedFundingRelationship?.status)
                )}
              >
                {selectedFundingRelationship?.status || "not_started"}
              </Badge>
            </div>
            {selectedFundingRelationship?.status_reason_message ? (
              <p className="mt-1 text-[11px] leading-5">
                {selectedFundingRelationship.status_reason_message}
              </p>
            ) : relationshipPending ? (
              <p className="mt-1 text-[11px] leading-5">
                Approval is still pending. Transfers are blocked until this relationship becomes
                approved.
              </p>
            ) : relationshipFailed ? (
              <p className="mt-1 text-[11px] leading-5">
                This funding relationship is not eligible right now. Reconnect the bank account or
                contact support.
              </p>
            ) : !relationshipApproved ? (
              <p className="mt-1 text-[11px] leading-5">
                No approved ACH relationship exists for this funding account yet.
              </p>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="none"
              effect="fade"
              disabled={isSubmittingTransfer || !relationshipApproved}
              onClick={() => {
                const amount = Number(amountInput);
                if (!Number.isFinite(amount) || amount <= 0) return;
                if (!selectedFundingAccountId || !legalNameInput.trim()) return;
                if (brokerageAccountOptions.length > 0 && !selectedBrokerageAccountId) return;
                const nonce =
                  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now()}`;
                void onCreateTransfer({
                  fundingItemId: fundingItem.item_id,
                  fundingAccountId: selectedFundingAccountId,
                  brokerageItemId: null,
                  brokerageAccountId: selectedBrokerageAccountId || null,
                  amount,
                  userLegalName: legalNameInput.trim(),
                  direction: transferDirection,
                  idempotencyKey: `kai_${fundingItem.item_id}_${selectedFundingAccountId}_${amount.toFixed(2)}_${nonce}`,
                });
              }}
            >
              {isSubmittingTransfer ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <BadgeDollarSign className="mr-2 h-4 w-4" />
              )}
              Create transfer
            </Button>
          </div>
        </div>
      ) : null}

      {latestTransfers.length > 0 ? (
        <div className="space-y-2">
          {latestTransfers.map((transfer) => {
            const transferId = String(transfer.transfer_id || "").trim();
            const transferStatus = String(
              transfer.user_facing_status || transfer.status || "pending"
            ).trim();
            return (
              <SettingsRow
                key={transferId}
                icon={BadgeDollarSign}
                title={transferId || "Transfer"}
                description={[
                  transfer.amount ? `$${transfer.amount}` : null,
                  transfer.direction || null,
                  transfer.brokerage_account_id || transfer.alpaca_account_id
                    ? `Destination ${transfer.brokerage_account_id || transfer.alpaca_account_id}`
                    : null,
                  transfer.completed_at
                    ? `Completed ${formatRelativeTimestamp(transfer.completed_at)}`
                    : transfer.requested_at
                      ? formatRelativeTimestamp(transfer.requested_at)
                      : transfer.created_at
                        ? formatRelativeTimestamp(transfer.created_at)
                        : null,
                  transfer.failure_reason_message
                    ? `Reason: ${transfer.failure_reason_message}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
                trailing={
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-[11px]",
                        transferStatusTone(transferStatus)
                      )}
                    >
                      {transferStatus || "pending"}
                    </Badge>
                    {transferId && onRefreshTransfer ? (
                      <Button
                        variant="none"
                        effect="fade"
                        size="sm"
                        onClick={() => void onRefreshTransfer(transferId)}
                      >
                        Refresh
                      </Button>
                    ) : null}
                    {transferId && onCancelTransfer ? (
                      <Button
                        variant="none"
                        effect="fade"
                        size="sm"
                        onClick={() => void onCancelTransfer(transferId)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                }
              />
            );
          })}
        </div>
      ) : null}

      {hasSupportTools ? (
        <div className="rounded-[20px] border border-border/60 bg-background/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Support tools
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Search transfer records and create a manual escalation with notes for operations.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Transfer ID
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={supportTransferId}
                onChange={(event) => setSupportTransferId(event.target.value)}
                placeholder="Optional transfer ID"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Relationship ID
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={supportRelationshipId}
                onChange={(event) => setSupportRelationshipId(event.target.value)}
                placeholder="Optional relationship ID"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Escalation severity
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={supportSeverity}
                onChange={(event) =>
                  setSupportSeverity(
                    event.target.value as "low" | "normal" | "high" | "urgent"
                  )
                }
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Escalation notes
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={supportNotes}
                onChange={(event) => setSupportNotes(event.target.value)}
                placeholder="Required for escalation"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {onSearchFundingRecords ? (
              <Button
                variant="none"
                effect="fade"
                disabled={isSearchingSupport}
                onClick={() => void handleSupportSearch()}
              >
                {isSearchingSupport ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Search records
              </Button>
            ) : null}
            {onCreateFundingEscalation ? (
              <Button
                variant="none"
                effect="fade"
                disabled={isEscalatingSupport || !supportNotes.trim()}
                onClick={() => void handleCreateEscalation()}
              >
                {isEscalatingSupport ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldAlert className="mr-2 h-4 w-4" />
                )}
                Create escalation
              </Button>
            ) : null}
          </div>

          {supportError ? (
            <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{supportError}</p>
          ) : null}

          {supportResults.length > 0 ? (
            <div className="mt-3 space-y-2">
              {supportResults.slice(0, 8).map((row, index) => {
                const transferId = readRecordText(row, "transfer_id") || `result-${index + 1}`;
                const relationshipId = readRecordText(row, "relationship_id");
                const status =
                  readRecordText(row, "user_facing_status") ||
                  readRecordText(row, "status") ||
                  "pending";
                const amount = readRecordText(row, "amount");
                const requestedAt = readRecordText(row, "requested_at");
                const failureReason = readRecordText(row, "failure_reason_message");

                return (
                  <div
                    key={`${transferId}:${index}`}
                    className="rounded-xl border border-border/60 bg-background px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{transferId}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-[11px]",
                          transferStatusTone(status)
                        )}
                      >
                        {status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[amount ? `$${amount}` : null, relationshipId || null, requestedAt || null]
                        .filter(Boolean)
                        .join(" • ")}
                    </p>
                    {failureReason ? (
                      <p className="mt-1 text-xs text-muted-foreground">Reason: {failureReason}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsGroup>
  );
}
