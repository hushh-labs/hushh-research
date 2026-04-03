"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  buildShoppingReceiptMemoryPreparedDomain,
  hasMatchingReceiptMemoryProvenance,
} from "@/lib/profile/gmail-receipt-memory-pkm";
import {
  getCachedGmailReceipts,
  isCachedGmailReceiptsFresh,
  mergeCachedReceiptItems,
  primeCachedGmailReceipts,
} from "@/lib/profile/gmail-receipts-cache";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  GmailReceiptMemoryService,
  type ReceiptMemoryArtifact,
} from "@/lib/services/gmail-receipt-memory-service";
import {
  GmailReceiptsService,
  type GmailSyncRun,
  type ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { VaultService } from "@/lib/services/vault-service";
import { useVault } from "@/lib/vault/vault-context";

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatAmount(currency?: string | null, amount?: number | null): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "—";
  const normalized = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalized,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${normalized} ${amount.toFixed(2)}`;
  }
}

function computeSyncProgressPercent(run: GmailSyncRun | null): number {
  if (!run) return 0;
  if (run.status === "queued") return 8;
  if (run.status === "running") {
    const listed = Math.max(1, run.listed_count || 0);
    const pipelineWork = (run.filtered_count || 0) + (run.synced_count || 0) + (run.extracted_count || 0);
    const ratio = Math.max(0, Math.min(1, pipelineWork / (listed * 3)));
    return Math.max(12, Math.min(95, Math.round(ratio * 100)));
  }
  if (run.status === "completed") return 100;
  return 100;
}

export default function ProfileReceiptsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();

  const [receipts, setReceipts] = useState<ReceiptListItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const [receiptMemoryArtifact, setReceiptMemoryArtifact] = useState<ReceiptMemoryArtifact | null>(
    null
  );
  const [receiptMemoryLoading, setReceiptMemoryLoading] = useState(false);
  const [receiptMemorySaving, setReceiptMemorySaving] = useState(false);
  const [receiptMemoryMessage, setReceiptMemoryMessage] = useState<string | null>(null);
  const receiptsRef = useRef<ReceiptListItem[]>([]);
  const pageRef = useRef(1);

  useEffect(() => {
    receiptsRef.current = receipts;
  }, [receipts]);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.uid) {
      setHasVault(null);
      return;
    }
    void VaultService.checkVault(user.uid)
      .then((next) => {
        if (!cancelled) {
          setHasVault(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasVault(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const canLoad = Boolean(user?.uid);
  const hasStoredReceipts = receipts.length > 0;

  const loadReceipts = useCallback(
    async (
      nextPage: number,
      options?: {
        preserveCachedItems?: boolean;
        silent?: boolean;
      }
    ) => {
      if (!user?.uid) return;
      const showBlockingLoader = !options?.silent;
      if (showBlockingLoader) {
        setLoadingReceipts(true);
      }
      try {
        const idToken = await user.getIdToken();
        const response = await GmailReceiptsService.listReceipts({
          idToken,
          userId: user.uid,
          page: nextPage,
          perPage: 20,
        });

        const previousItems = receiptsRef.current;
        const nextItems =
          nextPage > 1
            ? mergeCachedReceiptItems({
                existing: previousItems,
                incoming: response.items,
                mode: "append",
              })
            : options?.preserveCachedItems
              ? mergeCachedReceiptItems({
                  existing: previousItems,
                  incoming: response.items,
                  mode: "prepend_refresh",
                })
              : response.items;
        const nextLoadedPage =
          nextPage > 1
            ? response.page
            : options?.preserveCachedItems
              ? Math.max(pageRef.current, response.page)
              : response.page;
        const nextHasMore = nextItems.length < response.total;

        setReceipts(nextItems);
        setPage(nextLoadedPage);
        setHasMore(nextHasMore);
        setTotal(response.total);
        primeCachedGmailReceipts({
          userId: user.uid,
          response: {
            ...response,
            items: nextItems,
            page: nextLoadedPage,
            has_more: nextHasMore,
          },
        });
      } finally {
        if (showBlockingLoader) {
          setLoadingReceipts(false);
        }
      }
    },
    [user]
  );

  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !loading,
    idTokenProvider: user?.getIdToken ? () => user.getIdToken() : null,
    routeHref: ROUTES.PROFILE_RECEIPTS,
    refreshKey: user?.uid || "",
    onSyncComplete: async () => {
      await loadReceipts(1, {
        preserveCachedItems: true,
      });
    },
  });

  useEffect(() => {
    if (loading || !canLoad || !user?.uid) return;

    const cached = getCachedGmailReceipts(user.uid);
    if (cached) {
      setReceipts(cached.items);
      setPage(cached.page);
      setHasMore(cached.has_more);
      setTotal(cached.total);
      if (isCachedGmailReceiptsFresh(user.uid)) {
        return;
      }
      void loadReceipts(1, {
        preserveCachedItems: true,
        silent: true,
      });
      return;
    }

    void loadReceipts(1);
  }, [canLoad, loadReceipts, loading, user?.uid]);

  const syncing = gmail.refreshingStatus || gmail.syncingRun;
  const isConnected = gmail.presentation.isConnected;
  const loadingStatus = gmail.loadingStatus;
  const connectorState = gmail.presentation.state;
  const connectorSummary = gmail.presentation.description;
  const latestSyncText = gmail.presentation.latestSyncText;
  const latestSyncBadge = gmail.presentation.latestSyncBadge;

  const handleSyncNow = useCallback(async () => {
    if (!user?.uid) return;
    try {
      if (!isConnected || syncing) {
        return;
      }
      const queued = await gmail.syncNow();
      if (!queued?.run?.run_id) {
        toast.message("Gmail sync is already running.");
        return;
      }
      toast.message("Gmail sync started in the background.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start Gmail sync.");
    }
  }, [gmail, isConnected, syncing, user?.uid]);

  const showConnectPrompt =
    !gmail.loadingStatus &&
    !gmail.statusError &&
    !isConnected &&
    !hasStoredReceipts &&
    gmail.status?.configured !== false;
  const showDisconnectedNotice =
    !gmail.loadingStatus && !gmail.statusError && !isConnected && hasStoredReceipts;
  const progressPercent = useMemo(() => computeSyncProgressPercent(gmail.syncRun), [gmail.syncRun]);
  const latestRunMetrics = useMemo(() => {
    if (!gmail.syncRun) return null;
    const extractionSuccessPercent = Math.round((gmail.syncRun.extraction_success_rate || 0) * 100);
    return {
      listed: gmail.syncRun.listed_count || 0,
      filtered: gmail.syncRun.filtered_count || 0,
      synced: gmail.syncRun.synced_count || 0,
      extracted: gmail.syncRun.extracted_count || 0,
      duplicates: gmail.syncRun.duplicates_dropped || 0,
      extractionSuccessPercent,
    };
  }, [gmail.syncRun]);
  const pageTitle = useMemo(
    () =>
      gmail.status?.google_email
        ? `Synced from ${gmail.status.google_email}`
        : connectorState === "connected_initial_scan_running"
          ? "Your initial Gmail scan is running in the background."
          : connectorState === "connected_backfill_running"
            ? "Older receipts are still being backfilled."
            : hasStoredReceipts
          ? "Stored Gmail receipts"
          : "Your Gmail receipts",
    [connectorState, gmail.status?.google_email, hasStoredReceipts]
  );
  const isSyncingState =
    connectorState === "connected_initial_scan_running" ||
    connectorState === "connected_backfill_running" ||
    connectorState === "syncing";
  const canBuildReceiptMemoryPreview = Boolean(user?.uid) && (total > 0 || hasStoredReceipts);

  const requestVaultUnlock = useCallback(() => {
    if (hasVault === true) {
      setShowVaultUnlock(true);
      return;
    }
    toast.info("Create and unlock your vault from Profile before saving receipt memory.");
  }, [hasVault]);

  const handleBuildReceiptMemoryPreview = useCallback(
    async (forceRefresh = false) => {
      if (!user?.uid) return;
      setReceiptMemoryLoading(true);
      setReceiptMemoryMessage(null);
      try {
        const idToken = await user.getIdToken();
        const artifact = await GmailReceiptMemoryService.preview({
          idToken,
          userId: user.uid,
          forceRefresh,
        });
        setReceiptMemoryArtifact(artifact);
        setReceiptMemoryMessage(
          artifact.enrichment
            ? "Preview includes deterministic facts plus LLM-readable summary."
            : "Preview generated from deterministic receipt projection."
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to build receipt memory preview.";
        setReceiptMemoryMessage(message);
        toast.error(message);
      } finally {
        setReceiptMemoryLoading(false);
      }
    },
    [user]
  );

  const handleSaveReceiptMemory = useCallback(async () => {
    if (!user?.uid || !receiptMemoryArtifact) return;
    if (!vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
      requestVaultUnlock();
      return;
    }

    setReceiptMemorySaving(true);
    setReceiptMemoryMessage(null);
    try {
      const existingContext = await PkmDomainResourceService.prepareDomainWriteContext({
        userId: user.uid,
        domain: "shopping",
        vaultKey,
        vaultOwnerToken,
      });
      if (
        existingContext.domainData &&
        hasMatchingReceiptMemoryProvenance(existingContext.domainData, receiptMemoryArtifact)
      ) {
        setReceiptMemoryMessage("Receipt memory is already current in PKM.");
        toast.message("Receipt memory is already current in PKM.");
        return;
      }

      const result = await PkmWriteCoordinator.savePreparedDomain({
        userId: user.uid,
        domain: "shopping",
        vaultKey,
        vaultOwnerToken,
        build: async (context) => {
          const prepared = buildShoppingReceiptMemoryPreparedDomain({
            currentDomainData: context.currentDomainData,
            currentManifest: context.currentManifest,
            artifact: receiptMemoryArtifact,
          });
          const validation = await PersonalKnowledgeModelService.validatePreparedDomainStore({
            userId: user.uid,
            vaultKey,
            vaultOwnerToken,
            domain: "shopping",
            domainData: prepared.domainData,
            summary: prepared.summary,
            manifest: prepared.manifest,
            structureDecision: prepared.structureDecision,
            baseFullBlob: context.baseFullBlob,
            expectedDataVersion:
              context.currentEncryptedDomain?.dataVersion ?? context.expectedDataVersion,
            upgradeContext: context.upgradeContext,
          });
          if (!validation.success) {
            throw new Error(validation.message || "Failed to validate receipt memory for PKM.");
          }
          return prepared;
        },
      });

      if (!result.success) {
        throw new Error(result.message || "Failed to save receipt memory to PKM.");
      }
      setReceiptMemoryMessage("Saved receipt memory to PKM.");
      toast.success("Saved receipt memory to PKM.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save receipt memory to PKM.";
      setReceiptMemoryMessage(message);
      toast.error(message);
    } finally {
      setReceiptMemorySaving(false);
    }
  }, [
    isVaultUnlocked,
    receiptMemoryArtifact,
    requestVaultUnlock,
    user,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handleLoadMore = useCallback(async () => {
    try {
      await loadReceipts(page + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load older receipts.");
    }
  }, [loadReceipts, page]);

  return (
    <AppPageShell
      as="div"
      width="profile"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/profile/receipts",
        marker: "native-route-profile-receipts",
        authState: user ? "authenticated" : "pending",
        dataState: loadingReceipts
          ? "loading"
          : !isConnected
            ? "unavailable-valid"
            : receipts.length > 0
              ? "loaded"
              : "empty-valid",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Profile"
          title="Receipts"
          description={pageTitle}
          actions={
            <Button
              onClick={() => void handleSyncNow()}
              disabled={!isConnected || syncing}
              className="min-w-[140px]"
            >
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Sync now
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <SurfaceInset className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
            <div className="space-y-1">
              <p className="text-muted-foreground">Connector status</p>
              <p className="font-medium text-foreground">{gmail.presentation.badgeLabel}</p>
              <p className="text-xs text-muted-foreground">{connectorSummary}</p>
              <p className="text-xs text-muted-foreground">{latestSyncText}</p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge variant="secondary">{total} receipts</Badge>
              {latestSyncBadge ? <Badge variant="outline">{latestSyncBadge}</Badge> : null}
            </div>
          </SurfaceInset>

          <SurfaceInset className="space-y-3 px-4 py-4 text-sm">
            <div className="space-y-1">
              <p className="font-medium text-foreground">Add receipts to PKM</p>
              <p className="text-muted-foreground">
                Build a compact shopping memory snapshot from stored Gmail receipts and save it
                into your encrypted PKM.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void handleBuildReceiptMemoryPreview(Boolean(receiptMemoryArtifact))}
                disabled={!canBuildReceiptMemoryPreview || receiptMemoryLoading}
              >
                {receiptMemoryLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {receiptMemoryArtifact ? "Refresh receipt memory" : "Add receipts to memory"}
              </Button>
              <Button
                onClick={() => void handleSaveReceiptMemory()}
                disabled={!receiptMemoryArtifact || receiptMemorySaving}
                variant="none"
                effect="fade"
              >
                {receiptMemorySaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : !vaultKey || !vaultOwnerToken || !isVaultUnlocked ? (
                  <Lock className="mr-2 h-4 w-4" />
                ) : null}
                Save to PKM
              </Button>
            </div>
            {!canBuildReceiptMemoryPreview ? (
              <p className="text-xs text-muted-foreground">
                Stored Gmail receipts are required before Kai can derive receipt memory.
              </p>
            ) : null}
            {!vaultKey || !vaultOwnerToken || !isVaultUnlocked ? (
              <p className="text-xs text-muted-foreground">
                Unlock your vault to save receipt memory into PKM.
              </p>
            ) : null}
            {receiptMemoryArtifact ? (
              <div className="space-y-2 rounded-xl border border-border/60 bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {receiptMemoryArtifact.freshness.is_stale ? "Stale preview" : "Fresh preview"}
                  </Badge>
                  <Badge variant="outline">
                    {receiptMemoryArtifact.deterministic_projection.budget_stats.eligible_receipt_count} receipts
                  </Badge>
                  <Badge variant="outline">
                    {receiptMemoryArtifact.debug_stats.enrichment_mode === "llm"
                      ? "LLM summary"
                      : "Deterministic summary"}
                  </Badge>
                </div>
                <p className="font-medium text-foreground">
                  {receiptMemoryArtifact.candidate_pkm_payload.receipts_memory.readable_summary.text}
                </p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {receiptMemoryArtifact.candidate_pkm_payload.receipts_memory.readable_summary.highlights.map(
                    (item) => (
                      <Badge key={item} variant="outline">
                        {item}
                      </Badge>
                    )
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <span>
                    Merchants:{" "}
                    {
                      receiptMemoryArtifact.deterministic_projection.observed_facts.merchant_affinity
                        .length
                    }
                  </span>
                  <span>
                    Patterns:{" "}
                    {
                      receiptMemoryArtifact.deterministic_projection.observed_facts.purchase_patterns
                        .length
                    }
                  </span>
                  <span>
                    Highlights:{" "}
                    {
                      receiptMemoryArtifact.deterministic_projection.observed_facts.recent_highlights
                        .length
                    }
                  </span>
                  <span>
                    Signals: {receiptMemoryArtifact.deterministic_projection.inferred_preferences.length}
                  </span>
                </div>
                {receiptMemoryArtifact.freshness.is_stale ? (
                  <p className="text-xs text-amber-600">
                    This preview is older than {receiptMemoryArtifact.freshness.stale_after_days} days.
                    Refresh it before saving if you want the latest snapshot.
                  </p>
                ) : null}
              </div>
            ) : null}
            {receiptMemoryMessage ? (
              <p className="text-xs text-muted-foreground">{receiptMemoryMessage}</p>
            ) : null}
          </SurfaceInset>

          {loadingStatus ? (
            <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading Gmail connector status...
            </SurfaceInset>
          ) : null}

          {isSyncingState && gmail.syncRun ? (
            <SurfaceInset className="space-y-1 px-4 py-3 text-sm">
              <p className="font-medium text-foreground">Latest sync</p>
              <p className="text-muted-foreground">Run: {gmail.syncRun.run_id}</p>
              <p className="text-muted-foreground">Status: {gmail.syncRun.status}</p>
              <p className="text-muted-foreground">
                Synced {gmail.syncRun.synced_count} / Filtered {gmail.syncRun.filtered_count} / Extracted {gmail.syncRun.extracted_count}
              </p>
              {latestRunMetrics ? (
                <div className="space-y-2 pt-1">
                  <Progress value={progressPercent} className="h-2" />
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <span>Scanned: {latestRunMetrics.listed}</span>
                    <span>Matched: {latestRunMetrics.filtered}</span>
                    <span>Stored: {latestRunMetrics.synced}</span>
                    <span>Extracted: {latestRunMetrics.extracted}</span>
                    <span>Duplicates: {latestRunMetrics.duplicates}</span>
                    <span>Extract %: {latestRunMetrics.extractionSuccessPercent}%</span>
                  </div>
                </div>
              ) : null}
              {gmail.syncRun.error_message ? (
                <p className="text-destructive">{gmail.syncRun.error_message}</p>
              ) : null}
            </SurfaceInset>
          ) : null}

          {gmail.status?.configured === false && !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              Gmail receipts are not configured in this environment yet.
            </SurfaceInset>
          ) : null}

          {showConnectPrompt ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Mail className="h-4 w-4" />
                Connect Gmail from Profile to start syncing receipts.
              </div>
              <Button onClick={() => router.push(`${ROUTES.PROFILE}?tab=account&panel=gmail`)}>
                Open Gmail connector
              </Button>
            </SurfaceInset>
          ) : null}

          {showDisconnectedNotice ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              Gmail is currently disconnected. Your previously synced receipts stay available below,
              but Sync now is disabled until you reconnect.
            </SurfaceInset>
          ) : null}

          {isConnected && loadingReceipts && !loadingStatus ? (
            <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading receipts...
            </SurfaceInset>
          ) : null}

          {isConnected && !loadingReceipts && receipts.length === 0 && !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {gmail.syncRun?.synced_count
                ? "Sync reported stored receipts, but none are visible yet. Click Sync now once more to refresh from the latest DB state."
                : "No receipts synced yet. Run a manual sync to fetch your latest purchases."}
            </SurfaceInset>
          ) : null}

          {receipts.length > 0
            ? receipts.map((item) => (
                <SurfaceInset key={item.id} className="space-y-2 px-4 py-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{item.merchant_name || item.from_name || "Unknown merchant"}</p>
                      <p className="text-muted-foreground">{item.subject || "No subject"}</p>
                    </div>
                    <Badge variant="secondary">{formatAmount(item.currency, item.amount)}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Order: {item.order_id || "—"}</span>
                    <span>Receipt date: {formatDate(item.receipt_date || item.gmail_internal_date)}</span>
                    <span>Source: {item.classification_source || "deterministic"}</span>
                  </div>
                </SurfaceInset>
              ))
            : null}

          {receipts.length > 0 && hasMore ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="none"
                effect="fade"
                onClick={() => void handleLoadMore()}
                disabled={loadingReceipts}
              >
                Load older receipts
              </Button>
            </div>
          ) : null}

          {gmail.statusError ? (
            <p className="text-center text-xs text-destructive">{gmail.statusError}</p>
          ) : null}

          {gmail.status?.last_sync_error ? (
            <p className="text-center text-xs text-destructive">{gmail.status.last_sync_error}</p>
          ) : null}
        </SurfaceStack>
      </AppPageContentRegion>

      {hasVault === true && user ? (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={setShowVaultUnlock}
          title="Unlock vault"
          description="Unlock your vault before saving receipt memory into PKM."
          onSuccess={() => {
            setShowVaultUnlock(false);
            toast.success("Vault unlocked.");
          }}
        />
      ) : null}
    </AppPageShell>
  );
}
