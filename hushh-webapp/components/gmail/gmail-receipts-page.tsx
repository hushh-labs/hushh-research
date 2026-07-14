"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Loader2, Lock, Mail, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { DataTable } from "@/components/app-ui/data-table";
import { PageHeader } from "@/components/app-ui/page-sections";
import GmailChatPanel from "@/components/gmail/gmail-chat-panel";
import GmailNudgesSection from "@/components/gmail/gmail-nudges-section";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  describeGmailReceiptScanProgress,
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
import { assignWindowLocation } from "@/lib/utils/browser-navigation";
import {
  clearOnboardingConnectorIntent,
  createOnboardingConnectorIntent,
  persistOnboardingConnectorIntent,
} from "@/lib/onboarding/onboarding-connector-intent";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useVault } from "@/lib/vault/vault-context";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
  type VoiceSurfacePublisherRole,
} from "@/lib/voice/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatAmount(
  currency?: string | null,
  amount?: number | null,
): string {
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
    const pipelineWork =
      (run.filtered_count || 0) +
      (run.synced_count || 0) +
      (run.extracted_count || 0);
    const ratio = Math.max(0, Math.min(1, pipelineWork / (listed * 3)));
    return Math.max(12, Math.min(95, Math.round(ratio * 100)));
  }
  if (run.status === "completed") return 100;
  return 100;
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

const receiptColumns: ColumnDef<ReceiptListItem>[] = [
  {
    id: "merchant",
    header: "Merchant",
    cell: ({ row }) => (
      <div className="min-w-0 space-y-1">
        <p className="truncate font-medium text-foreground">
          {row.original.merchant_name ||
            row.original.from_name ||
            "Unknown merchant"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {row.original.subject || "No subject"}
        </p>
      </div>
    ),
  },
  {
    accessorKey: "amount",
    header: "Amount",
    cell: ({ row }) => (
      <Badge variant="secondary">
        {formatAmount(row.original.currency, row.original.amount)}
      </Badge>
    ),
  },
  {
    accessorKey: "order_id",
    header: "Order",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.order_id || "—"}
      </span>
    ),
  },
  {
    id: "receipt_date",
    header: "Receipt date",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatDate(
          row.original.receipt_date || row.original.gmail_internal_date,
        )}
      </span>
    ),
  },
];

function toComparableIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.endsWith(".000Z") ? iso.replace(".000Z", "Z") : iso;
}

function receiptSortKey(item: ReceiptListItem): [number, number] | null {
  const timestamp = toComparableIso(
    item.receipt_date ||
      item.gmail_internal_date ||
      item.created_at ||
      item.updated_at ||
      null,
  );
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return [parsed, item.id];
}

function buildReceiptMemorySourceWatermark(
  cached: ReturnType<typeof getCachedGmailReceipts>,
): ReceiptMemorySourceWatermark | null {
  if (
    !cached ||
    cached.has_more ||
    !Array.isArray(cached.items) ||
    cached.items.length === 0
  ) {
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
    latestItem.receipt_date ||
      latestItem.gmail_internal_date ||
      latestItem.created_at ||
      null,
  );
  const latestReceiptUpdatedAt = toComparableIso(
    latestItem.updated_at ||
      latestItem.created_at ||
      latestItem.receipt_date ||
      null,
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
  cached: ReturnType<typeof getCachedGmailReceipts>,
): boolean {
  if (!artifact) return false;
  const current = buildReceiptMemorySourceWatermark(cached);
  if (!current) return false;

  const sourceWatermark = artifact.source_watermark;
  if (
    !sourceWatermark ||
    typeof sourceWatermark !== "object" ||
    Array.isArray(sourceWatermark)
  ) {
    return false;
  }

  const record = sourceWatermark as Record<string, unknown>;
  return (
    Number(record.eligible_receipt_count) === current.eligible_receipt_count &&
    toComparableIso(String(record.latest_receipt_updated_at || "")) ===
      current.latest_receipt_updated_at &&
    Number(record.latest_receipt_id) === current.latest_receipt_id &&
    toComparableIso(String(record.latest_receipt_date || "")) ===
      current.latest_receipt_date &&
    String(record.deterministic_config_version || "") ===
      current.deterministic_config_version &&
    Number(record.inference_window_days) === current.inference_window_days &&
    Number(record.highlights_window_days) === current.highlights_window_days
  );
}

export type GmailReceiptsPageProps = {
  /**
   * The setup variant shares this feature surface while keeping task recovery
   * inside `/one/setup/gmail`. The normal workspace remains `/one/gmail`.
   */
  journeyVariant?: "workspace" | "onboarding";
  /** Reports the verified connector state to the setup route owner. */
  onConnectionStateChange?: (isConnected: boolean) => void;
  /** Settles the verified connector goal and records Gmail as complete. */
  onFinishSetup?: () => void;
  finishingSetup?: boolean;
  /** Leaves the setup workspace without marking Gmail complete. */
  onSkipSetup?: () => void;
  skippingSetup?: boolean;
  /** Static setup keeps route authority while this feature contributes controls. */
  voicePublisherRole?: VoiceSurfacePublisherRole;
};

export default function GmailReceiptsPage({
  journeyVariant = "workspace",
  onConnectionStateChange,
  onFinishSetup,
  finishingSetup = false,
  onSkipSetup,
  skippingSetup = false,
  voicePublisherRole = "route",
}: GmailReceiptsPageProps) {
  const { user, loading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();

  const [receipts, setReceipts] = useState<ReceiptListItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const [receiptMemoryArtifact, setReceiptMemoryArtifact] =
    useState<ReceiptMemoryArtifact | null>(null);
  const [receiptMemoryLoading, setReceiptMemoryLoading] = useState(false);
  const [receiptMemorySaveState, setReceiptMemorySaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [receiptMemoryMessage, setReceiptMemoryMessage] = useState<
    string | null
  >(null);
  const [gmailActionBusy, setGmailActionBusy] = useState<
    "connect" | "disconnect" | null
  >(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
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

  const canLoad = Boolean(user?.uid);
  const hasSealedReceiptAccess = Boolean(vaultOwnerToken && isVaultUnlocked);
  const hasStoredReceipts = receipts.length > 0;

  const loadReceipts = useCallback(
    async (
      nextPage: number,
      options?: {
        preserveCachedItems?: boolean;
        silent?: boolean;
      },
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
    [isVaultUnlocked, user, vaultOwnerToken],
  );

  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !loading,
    idTokenProvider: user?.getIdToken ? () => user.getIdToken() : null,
    routeHref:
      journeyVariant === "onboarding" ? ROUTES.ONE_SETUP_GMAIL : ROUTES.GMAIL,
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
  const hasKnownGmailAccount = Boolean(
    gmail.status?.google_email ||
    gmail.status?.connected ||
    gmail.status?.connected_at,
  );
  const loadingStatus = gmail.loadingStatus;
  const connectorState = gmail.presentation.state;
  const latestSyncText = gmail.presentation.latestSyncText;
  const latestSyncBadge = gmail.presentation.latestSyncBadge;
  const isPassiveBackfillState =
    connectorState === "connected_backfill_running";

  useEffect(() => {
    onConnectionStateChange?.(isConnected);
  }, [isConnected, onConnectionStateChange]);

  const handleConnectGmail = useCallback(async () => {
    if (!user?.uid) return;

    try {
      setGmailActionBusy("connect");
      const journey = await PreVaultUserStateService.bootstrapState(user.uid, {
        force: true,
      }).catch(() => null);
      const fromSetup = Boolean(
        journey &&
        !PreVaultUserStateService.isSetupResolved(journey) &&
        journey.onboardingActiveCapability === "gmail",
      );
      const idToken = await user.getIdToken();
      const isGoogleProvider =
        user.providerData?.some(
          (provider) => provider.providerId === "google.com",
        ) ?? false;

      const payload = await GmailReceiptsService.startConnect({
        idToken,
        userId: user.uid,
        loginHint: isGoogleProvider ? user.email : null,
        includeGrantedScopes: isGoogleProvider,
      });

      if (!payload.configured || !payload.authorize_url) {
        throw new Error("Gmail OAuth is not configured for this environment.");
      }

      if (fromSetup) {
        const intent = createOnboardingConnectorIntent("gmail");
        await PreVaultUserStateService.syncOnboardingJourney({
          userId: user.uid,
          phase: "external_connector",
          activeCapability: "gmail",
          callbackState: "pending",
          callbackAttemptId: intent.correlationId,
          expectedJourneyUpdatedAt: journey?.onboardingJourneyUpdatedAt,
        });
        // Write the browser correlation marker only after the durable journey
        // accepted the pending transition. A failed write must not cause an
        // unrelated callback to be mistaken for onboarding later.
        persistOnboardingConnectorIntent(intent);
      }

      assignWindowLocation(payload.authorize_url);
    } catch (error) {
      clearOnboardingConnectorIntent();
      const message = sanitizeGmailUserMessage(error, {
        fallback:
          "We couldn't start Gmail connection right now. Please try again in a moment.",
      });
      console.error(
        "[ProfileReceiptsPage] Failed to start Gmail OAuth:",
        error,
      );
      toast.error(message);
    } finally {
      setGmailActionBusy(null);
    }
  }, [user]);

  useLocalOnboardingActionHandler("setup.connect_gmail", async () => {
    if (journeyVariant !== "onboarding") {
      return {
        status: "blocked",
        summary: "Open Gmail setup before connecting Gmail.",
      };
    }
    if (gmailActionBusy !== null) {
      return {
        status: "blocked",
        summary: "Gmail connection is already being prepared.",
      };
    }
    await handleConnectGmail();
    return {
      status: "started",
      summary: "Opening Gmail connection. Finish setup after it verifies.",
    };
  });

  const handleDisconnectGmail = useCallback(async () => {
    if (!user?.uid) return;

    try {
      setGmailActionBusy("disconnect");
      await morphyToast
        .promise(
          (async () => {
            const next = await gmail.disconnectGmail();
            if (!next) {
              throw new Error("Gmail could not be disconnected.");
            }
            return next;
          })(),
          {
            loading: "Disconnecting Gmail...",
            success: "Gmail disconnected. Saved receipts stay available here.",
            error: (error) =>
              sanitizeGmailUserMessage(error, {
                fallback:
                  "We couldn't disconnect Gmail right now. Please try again in a moment.",
              }),
            variant: "destructive",
          },
        )
        .unwrap();
      setShowDisconnectConfirm(false);
    } catch (error) {
      console.error("[ProfileReceiptsPage] Failed to disconnect Gmail:", error);
    } finally {
      setGmailActionBusy(null);
    }
  }, [gmail, user?.uid]);

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
          fallback:
            "We couldn't sync your receipts. Please try again in a moment.",
          authFallback: "Reconnect Gmail to continue syncing your receipts.",
        }),
      );
    }
  }, [gmail, isConnected, syncing, user?.uid]);

  const progressPercent = useMemo(
    () => computeSyncProgressPercent(gmail.syncRun),
    [gmail.syncRun],
  );
  const latestRunMetrics = useMemo(() => {
    if (!gmail.syncRun) return null;
    return {
      listed: gmail.syncRun.listed_count || 0,
      filtered: gmail.syncRun.filtered_count || 0,
      synced: gmail.syncRun.synced_count || 0,
      extracted: gmail.syncRun.extracted_count || 0,
    };
  }, [gmail.syncRun]);
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const pageTitle = useMemo(
    () =>
      isConnected && gmail.status?.google_email
        ? `Connected to ${gmail.status.google_email}`
        : connectorState === "connected_initial_scan_running"
          ? "Connected to your Gmail"
          : connectorState === "connected_backfill_running"
            ? "Connected to your Gmail"
            : hasStoredReceipts
              ? "Saved receipts are still available here."
              : "Sync receipt emails into One.",
    [
      connectorState,
      gmail.status?.google_email,
      hasStoredReceipts,
      isConnected,
    ],
  );
  const isSyncingState =
    connectorState === "connected_initial_scan_running" ||
    connectorState === "connected_backfill_running" ||
    connectorState === "syncing";
  const hasStaleBackgroundSync = gmail.isStale && isSyncingState;
  // A zero is meaningful only after Gmail is connected and a scan can have
  // completed. Before then it reads like a result rather than an unavailable
  // source. Saved receipts remain countable after a deliberate disconnect.
  const shouldShowReceiptCount = isConnected || hasStoredReceipts;
  const canBuildReceiptMemoryPreview =
    Boolean(user?.uid) &&
    hasSealedReceiptAccess &&
    (total > 0 || hasStoredReceipts);
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
    () =>
      isReceiptMemoryWatermarkCurrent(receiptMemoryArtifact, cachedReceipts),
    [cachedReceipts, receiptMemoryArtifact],
  );
  const statusSummary = useMemo(
    () =>
      resolveGmailStatusSummary({
        status: gmail.status,
        loading: loadingStatus,
        errorText: gmail.statusError,
      }),
    [gmail.status, gmail.statusError, loadingStatus],
  );
  const primaryActionLabel = isConnected
    ? syncing
      ? "Syncing receipts…"
      : "Sync receipts"
    : connectorState === "needs_reauthentication" || gmail.status?.revoked
      ? "Reconnect Gmail"
      : "Connect Gmail";
  const statusToneClassName =
    statusSummary.tone === "success"
      ? "border-emerald-500/18 bg-emerald-500/[0.05]"
      : statusSummary.tone === "error"
        ? "border-rose-500/22 bg-rose-500/[0.06]"
        : statusSummary.tone === "loading"
          ? "border-accent-border bg-accent-surface"
          : "border-border/60 bg-background/68";
  const receiptsVoiceSurfaceMetadata = useMemo(() => {
    const visibleModules = ["Receipt status", "Receipts list"];
    if (isConnected && receiptMemoryArtifact) {
      visibleModules.push("Shopping summary");
    }

    const controls = [
      ...(isConnected
        ? [
            {
              id: "sync_gmail_receipts",
              label: "Sync receipts",
              purpose: "starts or refreshes Gmail receipt sync.",
              actionId: "profile.gmail.sync_now",
              role: "button",
              voiceAliases: ["sync gmail", "sync receipts"],
            },
            {
              id: "disconnect_gmail",
              label: "Disconnect Gmail",
              purpose:
                "disconnects Gmail sync while keeping already saved receipts available.",
              role: "button",
              voiceAliases: ["disconnect gmail", "turn off gmail sync"],
            },
          ]
        : [
            {
              id: "open_gmail_connector",
              label: primaryActionLabel,
              purpose:
                "starts Gmail connection or reconnection from this receipts page.",
              actionId:
                journeyVariant === "onboarding"
                  ? "setup.connect_gmail"
                  : null,
              role: "button",
              voiceAliases: [
                "connect gmail",
                "open gmail connector",
                "open gmail",
              ],
            },
          ]),
      ...(journeyVariant === "onboarding" && onFinishSetup && onSkipSetup
        ? isConnected
          ? [
              {
                id: "finish_gmail_setup",
                label: "Finish Gmail setup",
                purpose:
                  "records the verified Gmail connection and returns to setup.",
                actionId: "setup.finish_gmail",
                role: "button",
                voiceAliases: ["finish gmail setup", "finish gmail"],
              },
            ]
          : gmailActionBusy === null
            ? [
                {
                  id: "skip_gmail_setup",
                  label: "Skip Gmail setup",
                  purpose:
                    "returns to setup without marking Gmail as complete.",
                  actionId: "setup.skip_gmail",
                  role: "button",
                  voiceAliases: ["skip gmail setup", "skip gmail", "not now"],
                },
              ]
            : []
        : []),
      ...(hasMore
        ? [
            {
              id: "load_older_receipts",
              label: "Load older receipts",
              purpose:
                "loads older stored receipt records from the receipts list.",
              role: "button",
              voiceAliases: ["load older receipts"],
            },
          ]
        : []),
    ];
    const availableActions = controls.map((control) => control.label);
    const surfaceDefinition = {
      screenId: journeyVariant === "onboarding" ? "one_setup_gmail" : "gmail",
      title: "Receipts",
      purpose:
        journeyVariant === "onboarding"
          ? "Connect Gmail, review receipt-based purchase signals, then explicitly finish Gmail setup."
          : "This page shows your Gmail receipts, lets you sync new ones, and lets you choose when to save a private shopping summary.",
      sections: [
        {
          id: "receipt_status",
          title: "Receipt status",
          purpose:
            "This section shows whether Gmail is connected and whether receipts are syncing right now.",
        },
        {
          id: "receipt_insights",
          title: "Shopping summary",
          purpose:
            "This section prepares a private shopping summary from your receipts for you to review and save explicitly.",
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
          label: "Private memory",
          explanation:
            "Private memory is where One can save summaries for you to reuse later.",
          aliases: ["private memory", "personal memory"],
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
      activeSection:
        isConnected && receiptMemoryArtifact
          ? "Shopping summary"
          : isSyncingState
            ? "Receipt status"
            : "Stored receipts",
      visibleModules,
      focusedWidget:
        activeControl?.label ||
        (isConnected && receiptMemoryArtifact
          ? "Shopping summary"
          : "Receipts list"),
      modalState: showVaultUnlock ? "vault_unlock" : null,
      availableActions,
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(syncing ? ["gmail_sync"] : []),
        ...(gmailActionBusy === "connect" ? ["gmail_connect"] : []),
        ...(gmailActionBusy === "disconnect" ? ["gmail_disconnect"] : []),
        ...(receiptMemoryLoading ? ["receipt_memory_preview"] : []),
        ...(receiptMemorySaveState === "saving" ? ["receipt_memory_save"] : []),
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
                  authFallback:
                    "Reconnect Gmail to continue syncing your receipts.",
                },
              )
            : null,
        preview_available: Boolean(isConnected && receiptMemoryArtifact),
        preview_summary_editable: false,
        summary_persistence_state: receiptMemorySaveState,
        preview_stale: receiptMemoryArtifact?.freshness.is_stale || false,
        preview_stale_after_days:
          receiptMemoryArtifact?.freshness.stale_after_days || null,
        preview_merchant_count:
          receiptMemoryArtifact?.deterministic_projection.observed_facts
            .merchant_affinity.length || 0,
        preview_pattern_count:
          receiptMemoryArtifact?.deterministic_projection.observed_facts
            .purchase_patterns.length || 0,
        preview_highlight_count:
          receiptMemoryArtifact?.deterministic_projection.observed_facts
            .recent_highlights.length || 0,
        preview_signal_count:
          receiptMemoryArtifact?.deterministic_projection.inferred_preferences
            .length || 0,
      },
    };
  }, [
    connectorState,
    gmail.presentation.badgeLabel,
    gmail.status?.last_sync_error,
    gmail.syncRun,
    gmailActionBusy,
    hasMore,
    activeVoiceControlId,
    isConnected,
    isSyncingState,
    lastVoiceControlId,
    latestSyncBadge,
    latestSyncText,
    loadingReceipts,
    primaryActionLabel,
    receiptMemoryArtifact,
    receiptMemoryLoading,
    receiptMemorySaveState,
    statusSummary.detail,
    showVaultUnlock,
    syncing,
    total,
    journeyVariant,
    onFinishSetup,
    onSkipSetup,
  ]);

  const requestVaultUnlock = useCallback(() => {
    setShowVaultUnlock(true);
    toast.info("Set up your private vault to save this summary to memory.");
  }, []);

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
        setReceiptMemorySaveState("idle");
        setReceiptMemoryArtifact(artifact);
        setReceiptMemoryMessage("Saving your shopping summary to memory...");
      } catch (error) {
        console.error(
          "[ProfileReceiptsPage] Failed to build receipt summary:",
          error,
        );
        const message = sanitizeGmailUserMessage(error, {
          fallback:
            "We couldn't create a shopping summary right now. Please try again in a moment.",
        });
        setReceiptMemoryMessage(message);
        toast.error(message);
      } finally {
        setReceiptMemoryLoading(false);
      }
    },
    [isVaultUnlocked, user, vaultOwnerToken],
  );

  usePublishVoiceSurfaceMetadata(receiptsVoiceSurfaceMetadata, {
    role: voicePublisherRole,
  });

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
      Boolean(receiptMemoryArtifact) && !receiptMemoryWatermarkCurrent,
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

  const persistReceiptMemory = useCallback(
    async (artifact: ReceiptMemoryArtifact) => {
      if (!user?.uid) return;
      if (!vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
        setReceiptMemorySaveState("error");
        setReceiptMemoryMessage(
          "Set up your private vault to save this summary to memory.",
        );
        return;
      }

      setReceiptMemorySaveState("saving");
      setReceiptMemoryMessage("Saving your shopping summary to memory...");
      try {
        const existingContext =
          await PkmDomainResourceService.prepareDomainWriteContext({
            userId: user.uid,
            domain: "shopping",
            vaultKey,
            vaultOwnerToken,
          });
        if (
          existingContext.domainData &&
          hasMatchingReceiptMemoryProvenance(
            existingContext.domainData,
            artifact,
          )
        ) {
          setReceiptMemorySaveState("saved");
          setReceiptMemoryMessage(
            "Your shopping summary is saved to your private memory.",
          );
          return;
        }

        const result = await PkmWriteCoordinator.savePreparedDomain({
          userId: user.uid,
          domain: "shopping",
          vaultKey,
          vaultOwnerToken,
          // Required by the write-coordinator's confirmation-gated mutation
          // contract (branch): explicit user confirmation provenance for
          // this save action.
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "gmail_receipt_memory_save_button",
          },
          build: async (context) => {
            const prepared = buildShoppingReceiptMemoryPreparedDomain({
              currentDomainData: context.currentDomainData,
              currentManifest: context.currentManifest,
              artifact,
            });
            const validation =
              await PersonalKnowledgeModelService.validatePreparedDomainStore({
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
                  context.currentEncryptedDomain?.dataVersion ??
                  context.expectedDataVersion,
                upgradeContext: context.upgradeContext,
              });
            if (!validation.success) {
              throw new Error("Failed to validate receipt memory.");
            }
            return prepared;
          },
        });

        if (!result.success) {
          throw new Error("Failed to save receipt memory.");
        }
        setReceiptMemorySaveState("saved");
        setReceiptMemoryMessage(
          "Your shopping summary is saved to your private memory.",
        );
      } catch (error) {
        console.error(
          "[ProfileReceiptsPage] Failed to save receipt insights:",
          error,
        );
        const message = sanitizeGmailUserMessage(error, {
          fallback:
            "We couldn't save your shopping summary to memory. Sync receipts again to retry.",
        });
        setReceiptMemorySaveState("error");
        setReceiptMemoryMessage(message);
        toast.error(message);
      }
    },
    [isVaultUnlocked, user, vaultKey, vaultOwnerToken],
  );

  const handleLoadMore = useCallback(async () => {
    try {
      await loadReceipts(page + 1);
    } catch (error) {
      console.error(
        "[ProfileReceiptsPage] Failed to load older receipts:",
        error,
      );
      toast.error(
        "We couldn't load older receipts right now. Please try again.",
      );
    }
  }, [loadReceipts, page]);

  return (
    <AppPageShell
      as="div"
      width="reading"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={
        journeyVariant === "workspace"
          ? {
              routeId: ROUTES.GMAIL,
              marker: "native-route-gmail",
              authState: user ? "authenticated" : "pending",
              dataState: loadingReceipts
                ? "loading"
                : !isConnected
                  ? "unavailable-valid"
                  : receipts.length > 0
                    ? "loaded"
                    : "empty-valid",
            }
          : undefined
      }
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Receipts"
          description={pageTitle}
          actions={
            isConnected ? (
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Button
                  onClick={() => void handleSyncNow()}
                  disabled={syncing || gmailActionBusy !== null}
                  className="min-w-[150px]"
                  data-voice-control-id="sync_gmail_receipts"
                  data-voice-action-id="profile.gmail.sync_now"
                  data-voice-label={primaryActionLabel}
                  data-voice-purpose="starts or refreshes Gmail receipt sync."
                >
                  {syncing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {primaryActionLabel}
                </Button>
                <Button
                  variant="destructive"
                  effect="fade"
                  onClick={() => setShowDisconnectConfirm(true)}
                  disabled={syncing || gmailActionBusy !== null}
                  className="min-w-[150px]"
                  data-voice-control-id="disconnect_gmail"
                  data-voice-label="Disconnect Gmail"
                  data-voice-purpose="disconnects Gmail sync while keeping stored receipts available."
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Disconnect
                </Button>
              </div>
            ) : null
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
                <p className="text-sm text-muted-foreground">
                  {statusSummary.detail}
                </p>
                {statusSummary.helper ? (
                  <p className="text-xs text-muted-foreground">
                    {statusSummary.helper}
                  </p>
                ) : null}
              </div>
              {shouldShowReceiptCount ? (
                <Badge variant="secondary">
                  {total} receipt{total === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>

            {isSyncingState && latestRunMetrics && !isPassiveBackfillState ? (
              <div className="space-y-2">
                <Progress value={progressPercent} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  {describeGmailReceiptScanProgress({
                    scanned: latestRunMetrics.listed,
                    matched: latestRunMetrics.filtered,
                  })}
                </p>
              </div>
            ) : null}
            {hasStaleBackgroundSync ? (
              <p className="text-xs text-amber-600">
                Gmail is still running in the background. This status may lag
                behind for a bit.
              </p>
            ) : null}
            {!isConnected && !loadingStatus ? (
              <div className="flex flex-col items-center justify-center gap-2 pt-2 sm:flex-row">
                <Button
                  onClick={() => void handleConnectGmail()}
                  disabled={gmailActionBusy !== null}
                  className="h-12 w-full px-8 text-base shadow-lg sm:w-auto sm:min-w-[260px]"
                  data-voice-control-id="open_gmail_connector"
                  data-voice-action-id={
                    journeyVariant === "onboarding"
                      ? "setup.connect_gmail"
                      : undefined
                  }
                  data-voice-label={primaryActionLabel}
                  data-voice-purpose="starts Gmail connection or reconnection from this receipts page."
                >
                  {gmailActionBusy === "connect" ? (
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  ) : (
                    <Mail className="mr-2 h-5 w-5" />
                  )}
                  {primaryActionLabel}
                </Button>
                {hasKnownGmailAccount ? (
                  <Button
                    variant="none"
                    effect="fade"
                    onClick={() => setShowDisconnectConfirm(true)}
                    disabled={gmailActionBusy !== null}
                    className="h-12 w-full px-8 text-base sm:w-auto"
                    data-voice-control-id="disconnect_gmail"
                    data-voice-label="Disconnect Gmail"
                    data-voice-purpose="disconnects Gmail sync while keeping stored receipts available."
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Disconnect
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SurfaceInset>

          {journeyVariant === "onboarding" && onFinishSetup && onSkipSetup ? (
            <SetupCompletionFooter
              label={isConnected ? "Finish Gmail setup" : "Skip Gmail setup"}
              onComplete={isConnected ? onFinishSetup : onSkipSetup}
              busy={isConnected ? finishingSetup : skippingSetup}
              disabled={gmailActionBusy !== null}
              controlId={
                isConnected ? "finish_gmail_setup" : "skip_gmail_setup"
              }
              actionId={isConnected ? "setup.finish_gmail" : "setup.skip_gmail"}
              purpose={
                isConnected
                  ? "records verified Gmail connection and returns to setup."
                  : "returns to setup without recording Gmail as complete."
              }
              variant={isConnected ? "blue-gradient" : "none"}
              effect={isConnected ? "fill" : "fade"}
              supportingText={
                isConnected
                  ? undefined
                  : "You can connect Gmail from setup whenever you are ready."
              }
            />
          ) : null}

          {isConnected ? (
            <GmailChatPanel vaultOwnerToken={vaultOwnerToken} />
          ) : null}

          {isConnected ? (
            <GmailNudgesSection
              userId={user?.uid || null}
              vaultOwnerToken={vaultOwnerToken}
              isConnected
              idTokenProvider={
                user?.getIdToken ? () => user.getIdToken() : null
              }
            />
          ) : null}

          {isConnected ? (
            <SurfaceInset className="space-y-3 px-4 py-4 text-sm sm:px-5 sm:py-5">
              <div className="space-y-1">
                <p className="font-medium text-foreground">Shopping summary</p>
                <p className="text-muted-foreground">
                  Generated from your synced receipts. You choose when to save
                  it to your private memory.
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
                      {receiptMemoryArtifact.freshness.is_stale
                        ? "Needs refresh"
                        : receiptMemorySaveState === "saving"
                          ? "Saving memory"
                          : receiptMemorySaveState === "saved"
                            ? "Saved to memory"
                            : receiptMemorySaveState === "error"
                              ? "Save failed"
                              : "Preparing"}
                    </Badge>
                    <Badge variant="outline">
                      {
                        receiptMemoryArtifact.deterministic_projection
                          .budget_stats.eligible_receipt_count
                      }{" "}
                      receipts
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      Shopping summary
                    </p>
                    <p className="min-h-[96px] whitespace-pre-wrap rounded-xl border border-border/70 bg-background px-3 py-3 text-sm leading-6 text-foreground">
                      {
                        receiptMemoryArtifact.candidate_pkm_payload
                          .receipts_memory.readable_summary.text
                      }
                    </p>
                  </div>

                  {receiptMemoryArtifact.candidate_pkm_payload.receipts_memory
                    .readable_summary.highlights.length > 0 ? (
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {receiptMemoryArtifact.candidate_pkm_payload.receipts_memory.readable_summary.highlights.map(
                        (item) => (
                          <Badge key={item} variant="outline">
                            {item}
                          </Badge>
                        ),
                      )}
                    </div>
                  ) : null}

                  {receiptMemoryArtifact.freshness.is_stale ? (
                    <p className="text-xs text-amber-600">
                      This summary is a little older. We&apos;ll refresh it
                      again after your next sync.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {!canBuildReceiptMemoryPreview ? (
                <p className="text-xs text-muted-foreground">
                  Sync receipts first to create a shopping summary.
                </p>
              ) : isSyncingState ? (
                <p className="text-xs text-muted-foreground">
                  We&apos;ll prepare your shopping summary after Gmail finishes
                  syncing.
                </p>
              ) : null}
              {!vaultKey || !vaultOwnerToken || !isVaultUnlocked ? (
                <p className="text-xs text-muted-foreground">
                  Set up your private vault to create and save this summary to
                  memory.
                </p>
              ) : null}
              {receiptMemoryArtifact && receiptMemorySaveState !== "saved" ? (
                <Button
                  type="button"
                  onClick={() =>
                    void persistReceiptMemory(receiptMemoryArtifact)
                  }
                  disabled={receiptMemorySaveState === "saving"}
                  className="w-full sm:w-auto"
                >
                  {receiptMemorySaveState === "saving"
                    ? "Saving summary…"
                    : "Save shopping summary"}
                </Button>
              ) : null}
              {receiptMemoryMessage ? (
                <p className="text-xs text-muted-foreground">
                  {receiptMemoryMessage}
                </p>
              ) : null}
            </SurfaceInset>
          ) : null}

          {isSyncingState && gmail.syncRun ? (
            <SurfaceInset className="space-y-1 px-4 py-3 text-sm">
              <p className="font-medium text-foreground">Latest scan</p>
              <p className="text-muted-foreground">
                Receipt emails capture purchase interactions, helping One
                understand the brands you care about.
              </p>
              {latestRunMetrics ? (
                <div className="space-y-2 pt-1">
                  <Progress value={progressPercent} className="h-2" />
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <span>Emails checked: {latestRunMetrics.listed}</span>
                    <span>Receipt matches: {latestRunMetrics.filtered}</span>
                    <span>Saved receipts: {latestRunMetrics.synced}</span>
                    <span>
                      Details recognized: {latestRunMetrics.extracted}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {describeGmailReceiptScanProgress({
                      scanned: latestRunMetrics.listed,
                      matched: latestRunMetrics.filtered,
                    })}
                  </p>
                </div>
              ) : null}
              {gmail.syncRun.error_message ? (
                <p className="text-destructive">
                  {gmail.syncRun.error_message}
                </p>
              ) : null}
            </SurfaceInset>
          ) : null}

          {isConnected && !hasSealedReceiptAccess && !loadingStatus ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Lock className="h-4 w-4" />
                Set up or open your private vault to view and summarize synced
                receipts.
              </div>
              <Button onClick={requestVaultUnlock}>Set up vault</Button>
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          loadingReceipts &&
          !loadingStatus ? (
            <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your receipts…
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          !loadingReceipts &&
          receipts.length === 0 &&
          !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {gmail.syncRun?.synced_count
                ? "Your receipts are still finishing up. Please try syncing again in a moment."
                : "No receipts yet. Sync receipts to bring in your recent purchases."}
            </SurfaceInset>
          ) : null}

          {receipts.length > 0 ? (
            <DataTable
              columns={receiptColumns}
              data={receipts}
              searchKey="merchant_name"
              globalSearchKeys={[
                "merchant_name",
                "from_name",
                "subject",
                "order_id",
              ]}
              searchPlaceholder="Search receipts"
              initialPageSize={8}
              pageSizeOptions={[8, 16, 24]}
              density="compact"
              stickyHeader
              tableClassName="min-w-[720px]"
            />
          ) : null}

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

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={setShowVaultUnlock}
          title="Set up your private vault"
          description="Set up your private vault to create and save receipt summaries to memory."
          onSuccess={() => {
            setShowVaultUnlock(false);
            toast.success("Private vault is ready.");
          }}
        />
      ) : null}
      <AlertDialog
        open={showDisconnectConfirm}
        onOpenChange={setShowDisconnectConfirm}
      >
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops future Gmail receipt sync. Receipts already saved in
              your account stay available on this page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel disabled={gmailActionBusy === "disconnect"}>
              Keep connected
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={gmailActionBusy === "disconnect"}
              onClick={(event) => {
                event.preventDefault();
                void handleDisconnectGmail();
              }}
            >
              {gmailActionBusy === "disconnect" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Disconnect Gmail
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}
