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
import {
  resolveGmailStatusSummary,
  resolveGmailSyncFeedback,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";
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
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";

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

function buildEditableReceiptMemoryArtifact(
  artifact: ReceiptMemoryArtifact,
  summaryDraft: string
): ReceiptMemoryArtifact {
  const nextSummary = summaryDraft.trim();
  const currentSummary =
    artifact.candidate_pkm_payload.receipts_memory.readable_summary.text.trim();

  if (!nextSummary || nextSummary === currentSummary) {
    return artifact;
  }

  return {
    ...artifact,
    enrichment: artifact.enrichment
      ? {
          ...artifact.enrichment,
          readable_summary: {
            ...artifact.enrichment.readable_summary,
            text: nextSummary,
          },
        }
      : null,
    candidate_pkm_payload: {
      ...artifact.candidate_pkm_payload,
      receipts_memory: {
        ...artifact.candidate_pkm_payload.receipts_memory,
        readable_summary: {
          ...artifact.candidate_pkm_payload.receipts_memory.readable_summary,
          text: nextSummary,
        },
      },
    },
  };
}

const RECEIPT_MEMORY_DETERMINISTIC_CONFIG_VERSION = "receipt_memory_v1";
const RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS = 365;
const RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS = 90;

interface ReceiptMemorySourceWatermark {
  eligible_receipt_count: number;
  latest_receipt_updated_at: string | null;
  latest_receipt_id: number | null;
  latest_receipt_date: string | null;
  deterministic_config_version: string;
  inference_window_days: number;
  highlights_window_days: number;
}

function toComparableIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.endsWith(".000Z") ? iso.replace(".000Z", "Z") : iso;
}

function receiptSortKey(item: ReceiptListItem): [number, number] | null {
  const timestamp = toComparableIso(
    item.receipt_date || item.gmail_internal_date || item.created_at || item.updated_at || null
  );
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return [parsed, item.id];
}

function buildReceiptMemorySourceWatermark(
  cached: ReturnType<typeof getCachedGmailReceipts>
): ReceiptMemorySourceWatermark | null {
  if (!cached || cached.has_more || !Array.isArray(cached.items) || cached.items.length === 0) {
    return null;
  }

  const latestItem = [...cached.items]
    .filter((item) => receiptSortKey(item) !== null)
    .sort((left, right) => {
      const leftKey = receiptSortKey(left);
      const rightKey = receiptSortKey(right);
      if (!leftKey || !rightKey) return 0;
      if (leftKey[0] !== rightKey[0]) return rightKey[0] - leftKey[0];
      return rightKey[1] - leftKey[1];
    })[0];

  if (!latestItem) return null;

  const latestReceiptDate = toComparableIso(
    latestItem.receipt_date || latestItem.gmail_internal_date || latestItem.created_at || null
  );
  const latestReceiptUpdatedAt = toComparableIso(
    latestItem.updated_at || latestItem.created_at || latestItem.receipt_date || null
  );

  if (!latestReceiptDate || !latestReceiptUpdatedAt) {
    return null;
  }

  return {
    eligible_receipt_count: cached.total,
    latest_receipt_updated_at: latestReceiptUpdatedAt,
    latest_receipt_id: latestItem.id,
    latest_receipt_date: latestReceiptDate,
    deterministic_config_version: RECEIPT_MEMORY_DETERMINISTIC_CONFIG_VERSION,
    inference_window_days: RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS,
    highlights_window_days: RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS,
  };
}

function isReceiptMemoryWatermarkCurrent(
  artifact: ReceiptMemoryArtifact | null,
  cached: ReturnType<typeof getCachedGmailReceipts>
): boolean {
  if (!artifact) return false;
  const current = buildReceiptMemorySourceWatermark(cached);
  if (!current) return false;

  const sourceWatermark = artifact.source_watermark;
  if (!sourceWatermark || typeof sourceWatermark !== "object" || Array.isArray(sourceWatermark)) {
    return false;
  }

  const record = sourceWatermark as Record<string, unknown>;
  return (
    Number(record.eligible_receipt_count) === current.eligible_receipt_count &&
    toComparableIso(String(record.latest_receipt_updated_at || "")) === current.latest_receipt_updated_at &&
    Number(record.latest_receipt_id) === current.latest_receipt_id &&
    toComparableIso(String(record.latest_receipt_date || "")) === current.latest_receipt_date &&
    String(record.deterministic_config_version || "") === current.deterministic_config_version &&
    Number(record.inference_window_days) === current.inference_window_days &&
    Number(record.highlights_window_days) === current.highlights_window_days
  );
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
  const [receiptSummaryDraft, setReceiptSummaryDraft] = useState("");
  const [receiptMemoryLoading, setReceiptMemoryLoading] = useState(false);
  const [receiptMemorySaving, setReceiptMemorySaving] = useState(false);
  const [receiptMemoryMessage, setReceiptMemoryMessage] = useState<string | null>(null);
  const receiptsRef = useRef<ReceiptListItem[]>([]);
  const pageRef = useRef(1);
  const pendingSyncFeedbackRef = useRef(false);
  const autoReceiptSummaryKeyRef = useRef<string | null>(null);

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
  const hasSealedReceiptAccess = Boolean(vaultOwnerToken && isVaultUnlocked);
  const hasStoredReceipts = receipts.length > 0;

  const loadReceipts = useCallback(
    async (
      nextPage: number,
      options?: {
        preserveCachedItems?: boolean;
        silent?: boolean;
      }
    ) => {
      if (!user?.uid || !vaultOwnerToken || !isVaultUnlocked) return;
      const showBlockingLoader = !options?.silent;
      if (showBlockingLoader) {
        setLoadingReceipts(true);
      }
      try {
        const idToken = await user.getIdToken();
        const response = await GmailReceiptsService.listReceipts({
          idToken,
          vaultOwnerToken,
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
    [isVaultUnlocked, user, vaultOwnerToken]
  );

  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !loading,
    idTokenProvider: user?.getIdToken ? () => user.getIdToken() : null,
    routeHref: ROUTES.PROFILE_RECEIPTS,
    refreshKey: user?.uid || "",
    onSyncComplete: async (status) => {
      await loadReceipts(1, {
        preserveCachedItems: true,
      });
      if (!pendingSyncFeedbackRef.current) {
        return;
      }
      pendingSyncFeedbackRef.current = false;
      const feedback = resolveGmailSyncFeedback(status);
      if (feedback.kind === "success") {
        toast.success("Receipts updated");
      } else if (feedback.kind === "error") {
        toast.error(feedback.message);
      }
    },
  });

  useEffect(() => {
    if (loading || !canLoad || !user?.uid) return;
    if (!hasSealedReceiptAccess) {
      setReceipts([]);
      setPage(1);
      setHasMore(false);
      setTotal(0);
      return;
    }

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
  }, [canLoad, hasSealedReceiptAccess, loadReceipts, loading, user?.uid]);

  const syncing = gmail.refreshingStatus || gmail.syncingRun;
  const isConnected = gmail.presentation.isConnected;
  const loadingStatus = gmail.loadingStatus;
  const connectorState = gmail.presentation.state;
  const latestSyncText = gmail.presentation.latestSyncText;
  const latestSyncBadge = gmail.presentation.latestSyncBadge;
  const isPassiveBackfillState = connectorState === "connected_backfill_running";

  const handleSyncNow = useCallback(async () => {
    if (!user?.uid) return;
    try {
      if (!isConnected || syncing) {
        return;
      }
      const queued = await gmail.syncNow();
      if (!queued?.run?.run_id) {
        toast.message("We're already syncing your receipts.");
        return;
      }
      pendingSyncFeedbackRef.current = true;
      toast.message("Syncing your receipts now.");
    } catch (error) {
      pendingSyncFeedbackRef.current = false;
      console.error("[ProfileReceiptsPage] Failed to start Gmail sync:", error);
      toast.error(
        sanitizeGmailUserMessage(error, {
          fallback: "We couldn't sync your receipts. Please try again in a moment.",
          authFallback: "Reconnect Gmail to continue syncing your receipts.",
        })
      );
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
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const pageTitle = useMemo(
    () =>
      gmail.status?.google_email
        ? `Connected to ${gmail.status.google_email}`
        : connectorState === "connected_initial_scan_running"
          ? "Connected to your Gmail"
        : connectorState === "connected_backfill_running"
            ? "Connected to your Gmail"
            : hasStoredReceipts
          ? "Saved receipts are still available here."
          : "Connect Gmail to bring in your recent purchases.",
    [connectorState, gmail.status?.google_email, hasStoredReceipts]
  );
  const isSyncingState =
    connectorState === "connected_initial_scan_running" ||
    connectorState === "connected_backfill_running" ||
    connectorState === "syncing";
  const hasStaleBackgroundSync = gmail.isStale && isSyncingState;
  const canBuildReceiptMemoryPreview =
    Boolean(user?.uid) && hasSealedReceiptAccess && (total > 0 || hasStoredReceipts);
  const receiptSummaryDraftTrimmed = receiptSummaryDraft.trim();
  const autoReceiptSummaryKey = useMemo(() => {
    if (!user?.uid || !isConnected || !canBuildReceiptMemoryPreview) {
      return null;
    }

    return [
      user.uid,
      total,
      receipts.length,
      gmail.status?.last_sync_at || "",
      gmail.syncRun?.completed_at || "",
      gmail.syncRun?.run_id || "",
    ].join(":");
  }, [
    canBuildReceiptMemoryPreview,
    gmail.status?.last_sync_at,
    gmail.syncRun?.completed_at,
    gmail.syncRun?.run_id,
    isConnected,
    receipts.length,
    total,
    user?.uid,
  ]);
  const cachedReceipts = user?.uid ? getCachedGmailReceipts(user.uid) : null;
  const receiptMemoryWatermarkCurrent = useMemo(
    () => isReceiptMemoryWatermarkCurrent(receiptMemoryArtifact, cachedReceipts),
    [cachedReceipts, receiptMemoryArtifact]
  );
  const statusSummary = useMemo(
    () =>
      resolveGmailStatusSummary({
        status: gmail.status,
        loading: loadingStatus,
        errorText: gmail.statusError,
      }),
    [gmail.status, gmail.statusError, loadingStatus]
  );
  const primaryActionLabel = isConnected
    ? syncing
      ? "Syncing receipts…"
      : "Sync receipts"
    : connectorState === "needs_reauthentication"
      ? "Reconnect Gmail"
      : "Connect Gmail";
  const statusToneClassName =
    statusSummary.tone === "success"
      ? "border-emerald-500/18 bg-emerald-500/[0.05]"
      : statusSummary.tone === "error"
        ? "border-rose-500/22 bg-rose-500/[0.06]"
        : statusSummary.tone === "loading"
          ? "border-sky-500/18 bg-sky-500/[0.05]"
          : "border-border/60 bg-background/68";
  const receiptsVoiceSurfaceMetadata = useMemo(() => {
    const visibleModules = ["Receipt status", "Receipts list"];
    if (showConnectPrompt || showDisconnectedNotice) {
      visibleModules.push("Gmail connector prompt");
    }
    if (receiptMemoryArtifact) {
      visibleModules.push("Shopping summary");
    }
    if (canBuildReceiptMemoryPreview) {
      visibleModules.push("Save insights");
    }

    const availableActions = [
      ...(isConnected ? ["Sync receipts"] : ["Connect Gmail"]),
      ...(receiptMemoryArtifact ? ["Save insights"] : []),
      ...(hasMore ? ["Load older receipts"] : []),
    ];
    const controls = [
      {
        id: "sync_gmail_receipts",
        label: "Sync receipts",
        purpose: "starts or refreshes Gmail receipt sync.",
        actionId: "profile.gmail.sync_now",
        role: "button",
        voiceAliases: ["sync gmail", "sync receipts"],
      },
      {
        id: "open_gmail_connector",
        label: "Connect Gmail",
        purpose: "opens the Gmail connector so you can connect or reconnect Gmail.",
        actionId: "nav.profile_gmail_panel",
        role: "button",
        voiceAliases: ["connect gmail", "open gmail connector", "open gmail"],
      },
      {
        id: "edit_receipts_summary",
        label: "Shopping summary",
        purpose: "edits the shopping summary before you save it.",
        role: "textbox",
        voiceAliases: ["edit summary", "shopping summary"],
      },
      {
        id: "save_receipts_memory",
        label: "Save insights",
        purpose: "saves the current shopping summary into your personal memory.",
        actionId: "profile.receipts_memory.save",
        role: "button",
        voiceAliases: ["save insights", "save summary"],
      },
      {
        id: "load_older_receipts",
        label: "Load older receipts",
        purpose: "loads older stored receipt records from the receipts list.",
        role: "button",
        voiceAliases: ["load older receipts"],
      },
    ];
    const surfaceDefinition = {
      screenId: "profile_receipts",
      title: "Receipts",
      purpose:
        "This page shows your Gmail receipts, lets you sync new ones, and helps you save a simple shopping summary.",
      sections: [
        {
          id: "receipt_status",
          title: "Receipt status",
          purpose: "This section shows whether Gmail is connected and whether receipts are syncing right now.",
        },
        {
          id: "receipt_insights",
          title: "Save insights",
          purpose: "This section creates and saves a simple shopping summary from your receipts.",
        },
        {
          id: "stored_receipts",
          title: "Stored receipts",
          purpose: "This section lists the receipts we already found in Gmail.",
        },
      ],
      actions: availableActions.map((action) => ({
        id: action.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        label: action,
        purpose: `${action} from this receipts workspace.`,
      })),
      controls,
      concepts: [
        {
          id: "gmail_receipts",
          label: "Gmail receipts",
          explanation:
            "Gmail receipts brings your receipt emails into one place and can turn them into a shopping summary.",
          aliases: ["gmail receipts", "receipt sync"],
        },
        {
          id: "pkm",
          label: "PKM",
          explanation:
            "PKM is your private personal memory, where Kai can save summaries for you to reuse later.",
          aliases: ["pkm", "personal knowledge model"],
        },
      ],
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
    };
    const activeControl =
      controls.find((control) => control.id === activeVoiceControlId) ||
      controls.find((control) => control.id === lastVoiceControlId) ||
      null;

    return {
      surfaceDefinition,
      activeSection: receiptMemoryArtifact
        ? "Save insights"
        : isSyncingState
          ? "Receipt status"
          : "Stored receipts",
      visibleModules,
      focusedWidget: activeControl?.label || (receiptMemoryArtifact ? "Shopping summary" : "Receipts list"),
      modalState: showVaultUnlock ? "vault_unlock" : null,
      availableActions,
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(syncing ? ["gmail_sync"] : []),
        ...(receiptMemoryLoading ? ["receipt_memory_preview"] : []),
        ...(receiptMemorySaving ? ["receipt_memory_save"] : []),
        ...(loadingReceipts ? ["receipts_list_refresh"] : []),
      ],
      screenMetadata: {
        connector_state: connectorState,
        connector_badge_label: gmail.presentation.badgeLabel,
        connector_summary: statusSummary.detail,
        latest_sync_text: latestSyncText,
        latest_sync_badge: latestSyncBadge,
        receipt_count: total,
        has_more_receipts: hasMore,
        sync_run_status: gmail.syncRun?.status || null,
        sync_error:
          gmail.syncRun?.error_message || gmail.status?.last_sync_error
            ? sanitizeGmailUserMessage(
                gmail.syncRun?.error_message || gmail.status?.last_sync_error,
                {
                  fallback:
                    "We couldn't update your receipts right now. Please try again in a moment.",
                  authFallback: "Reconnect Gmail to continue syncing your receipts.",
                }
              )
            : null,
        preview_available: Boolean(receiptMemoryArtifact),
        preview_summary_editable: Boolean(receiptMemoryArtifact),
        preview_stale: receiptMemoryArtifact?.freshness.is_stale || false,
        preview_stale_after_days: receiptMemoryArtifact?.freshness.stale_after_days || null,
        preview_merchant_count:
          receiptMemoryArtifact?.deterministic_projection.observed_facts.merchant_affinity.length ||
          0,
        preview_pattern_count:
          receiptMemoryArtifact?.deterministic_projection.observed_facts.purchase_patterns.length ||
          0,
        preview_highlight_count:
          receiptMemoryArtifact?.deterministic_projection.observed_facts.recent_highlights.length ||
          0,
        preview_signal_count:
          receiptMemoryArtifact?.deterministic_projection.inferred_preferences.length || 0,
      },
    };
  }, [
    canBuildReceiptMemoryPreview,
    connectorState,
    gmail.presentation.badgeLabel,
    gmail.status?.last_sync_error,
    gmail.syncRun,
    hasMore,
    activeVoiceControlId,
    isConnected,
    isSyncingState,
    lastVoiceControlId,
    latestSyncBadge,
    latestSyncText,
    loadingReceipts,
    receiptMemoryArtifact,
    receiptMemoryLoading,
    receiptMemorySaving,
    statusSummary.detail,
    showConnectPrompt,
    showDisconnectedNotice,
    showVaultUnlock,
    syncing,
    total,
  ]);

  const requestVaultUnlock = useCallback(() => {
    if (hasVault === true) {
      setShowVaultUnlock(true);
      return;
    }
    toast.info("Create and unlock your vault from Profile before saving receipt memory.");
  }, [hasVault]);

  const handleBuildReceiptMemoryPreview = useCallback(
    async (forceRefresh = false) => {
      if (!user?.uid || !vaultOwnerToken || !isVaultUnlocked) return;
      setReceiptMemoryLoading(true);
      setReceiptMemoryMessage(null);
      try {
        const idToken = await user.getIdToken();
        const artifact = await GmailReceiptMemoryService.preview({
          idToken,
          vaultOwnerToken,
          userId: user.uid,
          forceRefresh,
        });
        setReceiptMemoryArtifact(artifact);
        setReceiptMemoryMessage(
          "Your shopping summary is ready to review."
        );
      } catch (error) {
        console.error("[ProfileReceiptsPage] Failed to build receipt summary:", error);
        const message = sanitizeGmailUserMessage(error, {
          fallback: "We couldn't create a shopping summary right now. Please try again in a moment.",
        });
        setReceiptMemoryMessage(message);
        toast.error(message);
      } finally {
        setReceiptMemoryLoading(false);
      }
    },
    [isVaultUnlocked, user, vaultOwnerToken]
  );

  usePublishVoiceSurfaceMetadata(receiptsVoiceSurfaceMetadata);

  useEffect(() => {
    setReceiptSummaryDraft(
      receiptMemoryArtifact?.candidate_pkm_payload.receipts_memory.readable_summary.text || ""
    );
  }, [
    receiptMemoryArtifact?.artifact_id,
    receiptMemoryArtifact?.candidate_pkm_payload.receipts_memory.readable_summary.text,
  ]);

  useEffect(() => {
    if (
      !autoReceiptSummaryKey ||
      loadingStatus ||
      loadingReceipts ||
      isSyncingState ||
      receiptMemoryLoading
    ) {
      return;
    }
    if (autoReceiptSummaryKeyRef.current === autoReceiptSummaryKey) {
      return;
    }

    autoReceiptSummaryKeyRef.current = autoReceiptSummaryKey;
    void handleBuildReceiptMemoryPreview(
      Boolean(receiptMemoryArtifact) && !receiptMemoryWatermarkCurrent
    );
  }, [
    autoReceiptSummaryKey,
    handleBuildReceiptMemoryPreview,
    isSyncingState,
    loadingReceipts,
    loadingStatus,
    receiptMemoryArtifact,
    receiptMemoryWatermarkCurrent,
    receiptMemoryLoading,
  ]);

  const handleSaveReceiptMemory = useCallback(async () => {
    if (!user?.uid || !receiptMemoryArtifact) return;
    if (!vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
      requestVaultUnlock();
      return;
    }

    setReceiptMemorySaving(true);
    setReceiptMemoryMessage(null);
    try {
      const artifactForSave = buildEditableReceiptMemoryArtifact(
        receiptMemoryArtifact,
        receiptSummaryDraft
      );
      const existingContext = await PkmDomainResourceService.prepareDomainWriteContext({
        userId: user.uid,
        domain: "shopping",
        vaultKey,
        vaultOwnerToken,
      });
      if (
        existingContext.domainData &&
        hasMatchingReceiptMemoryProvenance(existingContext.domainData, artifactForSave)
      ) {
        setReceiptMemoryMessage("Your saved insights are already up to date.");
        toast.message("Your saved insights are already up to date.");
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
            artifact: artifactForSave,
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
      setReceiptMemoryArtifact(artifactForSave);
      setReceiptMemoryMessage("Your shopping summary is saved.");
      toast.success("Insights saved");
    } catch (error) {
      console.error("[ProfileReceiptsPage] Failed to save receipt insights:", error);
      const message = sanitizeGmailUserMessage(error, {
        fallback: "We couldn't save your insights right now. Please try again in a moment.",
      });
      setReceiptMemoryMessage(message);
      toast.error(message);
    } finally {
      setReceiptMemorySaving(false);
    }
  }, [
    isVaultUnlocked,
    receiptMemoryArtifact,
    receiptSummaryDraft,
    requestVaultUnlock,
    user,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handleLoadMore = useCallback(async () => {
    try {
      await loadReceipts(page + 1);
    } catch (error) {
      console.error("[ProfileReceiptsPage] Failed to load older receipts:", error);
      toast.error("We couldn't load older receipts right now. Please try again.");
    }
  }, [loadReceipts, page]);

  return (
    <AppPageShell
      as="div"
      width="reading"
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
              onClick={() =>
                isConnected
                  ? void handleSyncNow()
                  : router.push(`${ROUTES.PROFILE}?panel=gmail`)
              }
              disabled={isConnected ? syncing : gmail.status?.configured === false}
              className="min-w-[140px]"
              data-voice-control-id={isConnected ? "sync_gmail_receipts" : "open_gmail_connector"}
              data-voice-action-id={isConnected ? "profile.gmail.sync_now" : "nav.profile_gmail_panel"}
              data-voice-label={primaryActionLabel}
              data-voice-purpose={
                isConnected
                  ? "starts or refreshes Gmail receipt sync."
                  : "opens the Gmail connector so you can connect Gmail."
              }
            >
              {syncing || (!isConnected && loadingStatus) ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : isConnected ? (
                <RefreshCw className="mr-2 h-4 w-4" />
              ) : (
                <Mail className="mr-2 h-4 w-4" />
              )}
              {primaryActionLabel}
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <SurfaceInset
            className={`space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5 ${statusToneClassName}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Status
                </p>
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  {statusSummary.title}
                </h2>
                <p className="text-sm text-muted-foreground">{statusSummary.detail}</p>
                {statusSummary.helper ? (
                  <p className="text-xs text-muted-foreground">{statusSummary.helper}</p>
                ) : null}
              </div>
              <Badge variant="secondary">
                {total} receipt{total === 1 ? "" : "s"}
              </Badge>
            </div>

            {isSyncingState && latestRunMetrics && !isPassiveBackfillState ? (
              <div className="space-y-2">
                <Progress value={progressPercent} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  We’re still fetching your recent purchases in the background.
                </p>
              </div>
            ) : null}
            {hasStaleBackgroundSync ? (
              <p className="text-xs text-amber-600">
                Gmail is still running in the background. This status may lag behind for a bit.
              </p>
            ) : null}

            {!isConnected ? (
              <div className="pt-1">
                <Button
                  onClick={() => router.push(`${ROUTES.PROFILE}?panel=gmail`)}
                  data-voice-control-id="open_gmail_connector"
                  data-voice-action-id="nav.profile_gmail_panel"
                  data-voice-label={primaryActionLabel}
                  data-voice-purpose="opens the Gmail connector so you can connect or reconnect Gmail."
                >
                  <Mail className="mr-2 h-4 w-4" />
                  {primaryActionLabel}
                </Button>
              </div>
            ) : null}
          </SurfaceInset>

          <SurfaceInset className="space-y-3 px-4 py-4 text-sm sm:px-5 sm:py-5">
            <div className="space-y-1">
              <p className="font-medium text-foreground">Save insights</p>
              <p className="text-muted-foreground">
                Review and edit your shopping summary before you save it.
              </p>
            </div>

            {receiptMemoryLoading && !receiptMemoryArtifact ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating your shopping summary…
              </div>
            ) : null}

            {receiptMemoryArtifact ? (
              <div className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {receiptMemoryArtifact.freshness.is_stale ? "Needs refresh" : "Ready to save"}
                  </Badge>
                  <Badge variant="outline">
                    {receiptMemoryArtifact.deterministic_projection.budget_stats.eligible_receipt_count} receipts
                  </Badge>
                </div>

                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Shopping summary
                  </span>
                  <textarea
                    value={receiptSummaryDraft}
                    onChange={(event) => setReceiptSummaryDraft(event.target.value)}
                    rows={5}
                    className="min-h-[128px] w-full resize-y rounded-xl border border-border/70 bg-background px-3 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/80 focus:border-foreground/20"
                    placeholder="Your shopping summary will appear here."
                    data-voice-control-id="edit_receipts_summary"
                    data-voice-label="Shopping summary"
                    data-voice-purpose="edits the shopping summary before you save it."
                  />
                </label>

                {receiptMemoryArtifact.candidate_pkm_payload.receipts_memory.readable_summary.highlights.length > 0 ? (
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {receiptMemoryArtifact.candidate_pkm_payload.receipts_memory.readable_summary.highlights.map(
                      (item) => (
                        <Badge key={item} variant="outline">
                          {item}
                        </Badge>
                      )
                    )}
                  </div>
                ) : null}

                {receiptMemoryArtifact.freshness.is_stale ? (
                  <p className="text-xs text-amber-600">
                    This summary is a little older. We&apos;ll refresh it again after your next sync.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void handleSaveReceiptMemory()}
                disabled={!receiptMemoryArtifact || !receiptSummaryDraftTrimmed || receiptMemorySaving}
                variant="none"
                effect="fade"
                data-voice-control-id="save_receipts_memory"
                data-voice-action-id="profile.receipts_memory.save"
                data-voice-label="Save insights"
                data-voice-purpose="saves the current shopping summary into your personal memory."
              >
                {receiptMemorySaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : !vaultKey || !vaultOwnerToken || !isVaultUnlocked ? (
                  <Lock className="mr-2 h-4 w-4" />
                ) : null}
                Save insights
              </Button>
            </div>

            {!canBuildReceiptMemoryPreview ? (
              <p className="text-xs text-muted-foreground">
                Sync receipts first to create a shopping summary.
              </p>
            ) : isSyncingState ? (
              <p className="text-xs text-muted-foreground">
                We&apos;ll prepare your shopping summary after Gmail finishes syncing.
              </p>
            ) : null}
            {!vaultKey || !vaultOwnerToken || !isVaultUnlocked ? (
              <p className="text-xs text-muted-foreground">
                Unlock your vault to save this summary.
              </p>
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
              <Button onClick={() => router.push(`${ROUTES.PROFILE}?panel=gmail`)}>
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
          {isConnected && !hasSealedReceiptAccess && !loadingStatus ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Lock className="h-4 w-4" />
                Unlock your vault to view and summarize synced receipts.
              </div>
              <Button onClick={requestVaultUnlock}>Unlock vault</Button>
            </SurfaceInset>
          ) : null}

          {isConnected && hasSealedReceiptAccess && loadingReceipts && !loadingStatus ? (
            <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your receipts…
            </SurfaceInset>
          ) : null}

          {isConnected && hasSealedReceiptAccess && !loadingReceipts && receipts.length === 0 && !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {gmail.syncRun?.synced_count
                ? "Your receipts are still finishing up. Please try syncing again in a moment."
                : "No receipts yet. Sync receipts to bring in your recent purchases."}
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
                    <span>Order number: {item.order_id || "—"}</span>
                    <span>Receipt date: {formatDate(item.receipt_date || item.gmail_internal_date)}</span>
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
                data-voice-control-id="load_older_receipts"
                data-voice-label="Load older receipts"
                data-voice-purpose="loads older stored receipt records from the receipts list."
              >
                Load older receipts
              </Button>
            </div>
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
