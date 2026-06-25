"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { usePathname } from "next/navigation";
import { Loader2, Lock, RefreshCw } from "@/components/icons";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader, SectionHeader } from "@/components/app-ui/page-sections";
import GmailInformationRequestsSection from "@/components/gmail/gmail-information-requests-section";
import { GmailRecentReceipts } from "@/components/gmail/gmail-recent-receipts";
import { GmailVerificationOnboarding } from "@/components/gmail/gmail-verification-onboarding";
import { GmailReceiptOnboardingHero } from "@/components/gmail/gmail-receipt-onboarding-hero";
import {
  GmailWorkspaceNavigation,
  GmailWorkspacePanels,
  type GmailWorkspace,
} from "@/components/gmail/gmail-workspace-navigation";
import { MailKycConnectEntry } from "@/components/gmail/mail-kyc-connect-entry";
import { MailOverview, MailConnectedAccount } from "@/components/gmail/mail-overview";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useHeldValue } from "@/hooks/use-held-value";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import { ROUTES } from "@/lib/navigation/routes";
import {
  resolveGmailStatusSummary,
  resolveGmailLastUpdatedLabel,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  buildShoppingReceiptMemoryPreparedDomain,
  hasMatchingReceiptMemoryProvenance,
} from "@/lib/profile/gmail-receipt-memory-pkm";
import {
  clearCachedGmailReceipts,
  getCachedGmailReceipts,
  mergeCachedReceiptItems,
  primeCachedGmailReceipts,
  upsertCachedGmailReceipt,
} from "@/lib/profile/gmail-receipts-cache";
import {
  getGmailWorkspaceSession,
  setGmailWorkspaceSession,
} from "@/lib/profile/gmail-workspace-session";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  GmailReceiptMemoryService,
  type ReceiptMemoryArtifact,
} from "@/lib/services/gmail-receipt-memory-service";
import {
  GmailReceiptsService,
  isReceiptScanInProgressError,
  type ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  clearOnboardingConnectorIntent,
  createOnboardingConnectorIntent,
  persistOnboardingConnectorIntent,
  persistOnboardingConnectorIntentInStorage,
  readOnboardingConnectorIntent,
} from "@/lib/onboarding/onboarding-connector-intent";

const GMAIL_OAUTH_POPUP_TIMEOUT_MS = 2 * 60 * 1000;
const RECEIPT_SCAN_MAX_PAGES = 50;
const RECEIPT_SCAN_ACTIVE_RETRIES = 2;
const RECEIPT_SCAN_ACTIVE_RETRY_MS = 750;
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  clearGmailOAuthPopupAttempt,
  consumeStoredGmailOAuthPopupSettlement,
  createGmailOAuthPopupAttempt,
  getGmailOAuthPopupSessionStorage,
  isGmailOAuthPopupSettlement,
  navigateGmailOAuthPopup,
  openGmailOAuthPopup,
  persistGmailOAuthPopupAttempt,
  readGmailOAuthPopupSettlementFallback,
  type GmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
  type VoiceSurfacePublisherRole,
} from "@/lib/voice/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { HushhAuth } from "@/lib/capacitor";

/**
 * Older purchases are fetched as a chain of runs: each one finishes, then the
 * next is queued a moment later. The overview holds its "fetching" state this
 * long past a finished run so that hand-off never reads as "ready" in between.
 */
const OVERVIEW_RECEIPT_SYNC_SETTLE_MS = 4_000;

function isReceiptScanAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function waitForReceiptScanRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Receipt scan was cancelled.", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Receipt scan was cancelled.", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, RECEIPT_SCAN_ACTIVE_RETRY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
const RECEIPT_PLACEHOLDER_ROWS = 8;
const SHOW_RECEIPT_MEMORY_SUMMARY_ON_LANDING = false;

function ReceiptListSkeleton() {
  return (
    <SurfaceInset
      aria-busy="true"
      aria-label="Loading receipts"
      aria-live="polite"
      className="space-y-3 px-3 py-3 sm:px-4 sm:py-4"
    >
      <p className="sr-only">
        Loading your receipts. Mail remains available while the list is
        prepared.
      </p>
      <Skeleton className="h-9 w-full" />
      <div className="divide-y divide-border/70 overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]">
        {Array.from({ length: RECEIPT_PLACEHOLDER_ROWS }, (_, index) => (
          <div
            className="flex items-center justify-between gap-3 px-3 py-2.5"
            key={index}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <Skeleton className="size-9 shrink-0 rounded-[10px]" />
              <Skeleton className="h-4 w-full max-w-40" />
            </div>
            <Skeleton className="h-4 w-24 shrink-0" />
          </div>
        ))}
      </div>
    </SurfaceInset>
  );
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
          {row.original.merchant_name || row.original.from_name || "Unknown merchant"}
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
        {formatDate(row.original.receipt_date || row.original.gmail_internal_date)}
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

  if (!latestReceiptDate || !latestReceiptUpdatedAt) return null;

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
  /** The normal Gmail route owns lightweight local workspace selection. */
  initialWorkspace?: GmailWorkspace;
  /** Explicit Feed navigation takes precedence over the last session tab. */
  forceWorkspace?: GmailWorkspace;
};

export default function GmailReceiptsPage({
  journeyVariant = "workspace",
  onConnectionStateChange,
  onFinishSetup,
  finishingSetup = false,
  onSkipSetup,
  skippingSetup = false,
  voicePublisherRole = "route",
  initialWorkspace = "overview",
  forceWorkspace,
}: GmailReceiptsPageProps) {
  // This component is hosted on both /one/gmail and /one/setup/gmail, so the
  // origin handed to the agent has to be the live path, not a route constant.
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [receipts, setReceipts] = useState<ReceiptListItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [receiptListReady, setReceiptListReady] = useState(false);
  const [receiptListError, setReceiptListError] = useState<string | null>(null);
  const [receiptListRetryPage, setReceiptListRetryPage] = useState(1);
  const [receiptScanReachedLimit, setReceiptScanReachedLimit] = useState(false);
  const [receiptScanInProgress, setReceiptScanInProgress] = useState(false);
  const [receiptScanProgress, setReceiptScanProgress] = useState<{
    page: number;
    maxPages: number;
    waitingForActiveScan: boolean;
  } | null>(null);
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
  const [receiptSyncFeedback, setReceiptSyncFeedback] = useState<{
    message: string;
    tone: "neutral" | "success" | "error";
  } | null>(null);
  const [gmailActionBusy, setGmailActionBusy] = useState<
    "connect" | "disconnect" | null
  >(null);
  const [gmailPopupAttempt, setGmailPopupAttempt] =
    useState<GmailOAuthPopupAttempt | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const receiptsRef = useRef<ReceiptListItem[]>([]);
  const receiptLoadSequenceRef = useRef(0);
  const receiptScanAbortRef = useRef<AbortController | null>(null);
  const receiptScanCursorsRef = useRef(new Map<number, string>());
  const receiptAccountKeyRef = useRef<string | null>(null);
  const displayedReceiptScopeRef = useRef<string | null>(null);
  const settledGmailPopupAttemptRef = useRef<string | null>(null);
  const autoReceiptSummaryKeyRef = useRef<string | null>(null);
  const gmailPopupRef = useRef<Window | null>(null);
  const gmailOwnerIdRef = useRef<string | null>(user?.uid ?? null);
  gmailOwnerIdRef.current = user?.uid ?? null;
  const sealedReceiptAccessRef = useRef({
    isUnlocked: isVaultUnlocked,
    ownerToken: vaultOwnerToken,
  });
  sealedReceiptAccessRef.current = {
    isUnlocked: isVaultUnlocked,
    ownerToken: vaultOwnerToken,
  };
  const resolvedInitialWorkspace =
    journeyVariant === "onboarding"
      ? "receipts"
      : (forceWorkspace ??
        getGmailWorkspaceSession(user?.uid, pathname, initialWorkspace));
  const [workspace, setWorkspaceState] = useState<GmailWorkspace>(
    resolvedInitialWorkspace,
  );
  const [kycVisitedOwner, setKycVisitedOwner] = useState<string | null>(
    resolvedInitialWorkspace === "kyc" ? (user?.uid ?? null) : null,
  );
  useEffect(() => {
    if (workspace === "kyc" && user?.uid) setKycVisitedOwner(user.uid);
  }, [workspace, user?.uid]);

  const setWorkspace = useCallback(
    (nextWorkspace: GmailWorkspace) => {
      setWorkspaceState(nextWorkspace);
      if (journeyVariant !== "onboarding") {
        setGmailWorkspaceSession(user?.uid, pathname, nextWorkspace);
      }
    },
    [journeyVariant, pathname, user?.uid],
  );

  useEffect(() => {
    setWorkspaceState(
      journeyVariant === "onboarding"
        ? "receipts"
        : forceWorkspace ??
          getGmailWorkspaceSession(user?.uid, pathname, initialWorkspace),
    );
  }, [forceWorkspace, initialWorkspace, journeyVariant, pathname, user?.uid]);
  // This is intentionally memory-only. A KYC summary can be
  // sensitive, so workspace navigation must not write unfinished text to
  // browser storage just to preserve it.
  const [verificationDeferred, setVerificationDeferred] = useState(false);
  const [verificationDraft, setVerificationDraft] = useState("");
  const receiptsWorkspaceActive =
    journeyVariant === "onboarding" || workspace === "receipts";

  useEffect(() => {
    receiptsRef.current = receipts;
  }, [receipts]);

  const canLoad = Boolean(user?.uid);
  const hasSealedReceiptAccess = Boolean(vaultOwnerToken && isVaultUnlocked);
  const hasStoredReceipts = receipts.length > 0;

  const loadReceipts = useCallback(
    async (nextPage: number) => {
      if (!user?.uid || !vaultOwnerToken || !isVaultUnlocked) return false;
      const startPage = Math.max(
        1,
        Math.min(RECEIPT_SCAN_MAX_PAGES, Math.trunc(nextPage)),
      );
      receiptScanAbortRef.current?.abort();
      const controller = new AbortController();
      receiptScanAbortRef.current = controller;
      const loadSequence = receiptLoadSequenceRef.current + 1;
      receiptLoadSequenceRef.current = loadSequence;
      const loadOwnerId = user.uid;
      const loadAccountKey = receiptAccountKeyRef.current;
      const loadOwnerToken = vaultOwnerToken;
      const loadVaultEpoch = snapshotVaultSessionEpoch();
      const isCurrentLoad = () => {
        const currentAccess = sealedReceiptAccessRef.current;
        return (
          gmailOwnerIdRef.current === loadOwnerId &&
          receiptAccountKeyRef.current === loadAccountKey &&
          currentAccess.isUnlocked &&
          currentAccess.ownerToken === loadOwnerToken &&
          receiptLoadSequenceRef.current === loadSequence &&
          isVaultSessionEpochCurrent(loadVaultEpoch)
        );
      };
      setLoadingReceipts(true);
      let requestedPage = startPage;
      if (startPage === 1) receiptScanCursorsRef.current.clear();
      else {
        const cached = getCachedGmailReceipts(loadOwnerId, loadAccountKey);
        if (cached?.page === startPage - 1 && cached.next_cursor) {
          receiptScanCursorsRef.current.set(startPage, cached.next_cursor);
        }
      }
      let activeScanRetries = 0;
      try {
        const idToken = await user.getIdToken();
        if (!isCurrentLoad()) return null;
        while (requestedPage <= RECEIPT_SCAN_MAX_PAGES) {
          if (controller.signal.aborted || !isCurrentLoad()) return null;
          setReceiptScanProgress({
            page: requestedPage,
            maxPages: RECEIPT_SCAN_MAX_PAGES,
            waitingForActiveScan: false,
          });
          let response;
          try {
            response = await GmailReceiptsService.scanReceipts({
              idToken,
              vaultOwnerToken: loadOwnerToken,
              userId: loadOwnerId,
              page: requestedPage,
              cursor: receiptScanCursorsRef.current.get(requestedPage),
              perPage: 6,
              signal: controller.signal,
            });
            activeScanRetries = 0;
          } catch (error) {
            if (
              isReceiptScanInProgressError(error) &&
              activeScanRetries < RECEIPT_SCAN_ACTIVE_RETRIES &&
              !controller.signal.aborted &&
              isCurrentLoad()
            ) {
              activeScanRetries += 1;
              setReceiptScanProgress({
                page: requestedPage,
                maxPages: RECEIPT_SCAN_MAX_PAGES,
                waitingForActiveScan: true,
              });
              await waitForReceiptScanRetry(controller.signal);
              continue;
            }
            throw error;
          }
          if (!isCurrentLoad()) return null;

          if (response.next_cursor) receiptScanCursorsRef.current.set(response.page + 1, response.next_cursor);

          const previousItems = receiptsRef.current;
          const nextItems =
            requestedPage > 1
              ? mergeCachedReceiptItems({
                  existing: previousItems,
                  incoming: response.items,
                  mode: "append",
                })
              : response.items;
          const nextLoadedPage = response.page;
          const nextHasMore = response.has_more;
          const nextTotal = nextItems.length;

          receiptsRef.current = nextItems;
          setReceipts(nextItems);
          setPage(nextLoadedPage);
          setHasMore(nextHasMore);
          setTotal(nextTotal);
          setReceiptScanReachedLimit(response.coverage?.reached_limit === true);
          setReceiptListError(null);
          setReceiptListRetryPage(1);
          primeCachedGmailReceipts({
            userId: loadOwnerId,
            accountKey: loadAccountKey,
            response: {
              ...response,
              items: nextItems,
              page: nextLoadedPage,
              total: nextTotal,
              has_more: nextHasMore,
            },
          });

          const shouldContinueScan =
            nextHasMore &&
            nextLoadedPage < response.coverage.max_pages;
          if (!shouldContinueScan) return true;
          requestedPage = nextLoadedPage + 1;
        }
        return true;
      } catch (error) {
        if (controller.signal.aborted || isReceiptScanAbort(error)) return null;
        if (!isCurrentLoad()) return null;
        setReceiptListRetryPage(requestedPage);
        setReceiptListError(
          sanitizeGmailUserMessage(error, {
            fallback:
              "We couldn't load your receipts right now. Please try again.",
          }),
        );
        return false;
      } finally {
        if (receiptScanAbortRef.current === controller) {
          receiptScanAbortRef.current = null;
        }
        if (isCurrentLoad() && startPage === 1) {
          setReceiptListReady(true);
        }
        if (isCurrentLoad()) {
          setLoadingReceipts(false);
          setReceiptScanProgress(null);
        }
      }
    },
    [isVaultUnlocked, user, vaultOwnerToken],
  );

  useEffect(
    () => () => {
      receiptLoadSequenceRef.current += 1;
      receiptScanAbortRef.current?.abort();
      receiptScanAbortRef.current = null;
    },
    [],
  );

  const idTokenProvider = useCallback(
    () => (user?.getIdToken ? user.getIdToken() : Promise.resolve("")),
    [user],
  );

  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !loading,
    idTokenProvider: user?.getIdToken ? idTokenProvider : null,
    routeHref:
      journeyVariant === "onboarding" ? ROUTES.ONE_SETUP_GMAIL : ROUTES.GMAIL,
    refreshKey: user?.uid || "",
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  receiptAccountKeyRef.current = receiptAccountKey;

  useEffect(() => {
    const nextScope = user?.uid
      ? `${user.uid}\u0000${String(receiptAccountKey || "")}`
      : null;
    if (displayedReceiptScopeRef.current === nextScope) return;
    displayedReceiptScopeRef.current = nextScope;
    receiptLoadSequenceRef.current += 1;
    receiptScanAbortRef.current?.abort();
    receiptScanAbortRef.current = null;
    receiptsRef.current = [];
    setReceipts([]);
    setPage(1);
    setHasMore(false);
    setTotal(0);
    setReceiptScanReachedLimit(false);
    setLoadingReceipts(false);
    setReceiptListReady(false);
    setReceiptListError(null);
    setReceiptSyncFeedback(null);
  }, [receiptAccountKey, user?.uid]);

  useEffect(() => {
    if (receiptsWorkspaceActive && user?.uid) return;
    receiptLoadSequenceRef.current += 1;
    receiptScanAbortRef.current?.abort();
    receiptScanAbortRef.current = null;
  }, [receiptsWorkspaceActive, user?.uid]);

  const loadReceiptDetail = useCallback(
    async (sourceId: string, signal: AbortSignal) => {
      if (!user?.uid || !vaultOwnerToken || !isVaultUnlocked) {
        throw new Error("Open your private vault to view this receipt.");
      }
      const detailOwnerId = user.uid;
      const detailAccountKey = receiptAccountKey;
      const detailOwnerToken = vaultOwnerToken;
      const detailVaultEpoch = snapshotVaultSessionEpoch();
      const ensureCurrent = () => {
        const access = sealedReceiptAccessRef.current;
        if (
          signal.aborted ||
          gmailOwnerIdRef.current !== detailOwnerId ||
          receiptAccountKeyRef.current !== detailAccountKey ||
          !access.isUnlocked ||
          access.ownerToken !== detailOwnerToken ||
          !isVaultSessionEpochCurrent(detailVaultEpoch)
        ) {
          throw new DOMException(
            "Receipt detail request was cancelled.",
            "AbortError",
          );
        }
      };
      const idToken = await user.getIdToken();
      ensureCurrent();
      const detail = await GmailReceiptsService.getReceiptDetail({
        idToken,
        vaultOwnerToken: detailOwnerToken,
        userId: detailOwnerId,
        sourceId,
        signal,
      });
      ensureCurrent();
      if (String(detail.item.source_id || "").trim() !== sourceId) {
        throw new Error("Mail returned details for a different receipt.");
      }
      return detail;
    },
    [isVaultUnlocked, receiptAccountKey, user, vaultOwnerToken],
  );

  const handleReceiptDetailLoaded = useCallback(
    (item: ReceiptListItem) => {
      const ownerId = user?.uid;
      const sourceId = String(item.source_id || "").trim();
      if (!ownerId || !sourceId) return;
      if (
        !receiptsRef.current.some(
          (receipt) => String(receipt.source_id || "").trim() === sourceId,
        )
      ) return;
      const nextReceipts = mergeCachedReceiptItems({
        existing: receiptsRef.current,
        incoming: [item],
        mode: "append",
      });
      receiptsRef.current = nextReceipts;
      setReceipts(nextReceipts);
      upsertCachedGmailReceipt({
        userId: ownerId,
        accountKey: receiptAccountKey,
        item,
      });
    },
    [receiptAccountKey, user?.uid],
  );

  useEffect(() => {
    if (loading || !canLoad || !user?.uid || !receiptsWorkspaceActive) return;
    if (!hasSealedReceiptAccess) {
      receiptLoadSequenceRef.current += 1;
      receiptScanAbortRef.current?.abort();
      receiptScanAbortRef.current = null;
      setReceipts([]);
      setPage(1);
      setHasMore(false);
      setTotal(0);
      setReceiptScanReachedLimit(false);
      setLoadingReceipts(false);
      setReceiptListReady(false);
      setReceiptListError(null);
      return;
    }
    if (gmail.loadingStatus || !gmail.presentation.isConnected) {
      if (!gmail.loadingStatus) {
        receiptLoadSequenceRef.current += 1;
        receiptScanAbortRef.current?.abort();
        receiptScanAbortRef.current = null;
        receiptsRef.current = [];
        setReceipts([]);
        setPage(1);
        setHasMore(false);
        setTotal(0);
        setReceiptScanReachedLimit(false);
        setLoadingReceipts(false);
        setReceiptListReady(false);
        setReceiptListError(null);
      }
      return;
    }

    const cached = getCachedGmailReceipts(user.uid, receiptAccountKey);
    if (cached) {
      setReceipts(cached.items);
      setPage(cached.page);
      setHasMore(cached.has_more);
      setTotal(cached.total);
      setReceiptScanReachedLimit(cached.receipt_scan_reached_limit);
      setReceiptListReady(true);
      // A warm in-memory page is only a temporary paint; every mount still
      // performs an authoritative backend read-through before enabling paging.
      void loadReceipts(1);
      return;
    }

    setReceiptListReady(false);
    void loadReceipts(1);
  }, [
    canLoad,
    gmail.loadingStatus,
    gmail.presentation.isConnected,
    hasSealedReceiptAccess,
    loadReceipts,
    loading,
    receiptAccountKey,
    receiptsWorkspaceActive,
    user?.uid,
  ]);

  const isConnected = gmail.presentation.isConnected;
  const loadingStatus = gmail.loadingStatus;
  const receiptStorageReadOnly =
    gmail.status?.receipt_storage_mode === "legacy_read_only";
  const receiptSyncAvailable = Boolean(isConnected && hasSealedReceiptAccess);
  const oauthCompletionPending = gmail.oauthCompletionPending;
  const showReceiptPlaceholders =
    isConnected &&
    hasSealedReceiptAccess &&
    !loadingStatus &&
    receipts.length === 0 &&
    (!receiptListReady || loadingReceipts);
  const connectorState = gmail.presentation.state;
  const latestSyncText = gmail.presentation.latestSyncText;
  const latestSyncBadge = gmail.presentation.latestSyncBadge;
  const isPassiveBackfillState =
    connectorState === "connected_backfill_running";

  const refreshGmailStatus = gmail.refreshStatus;

  useEffect(() => {
    if (!gmailPopupAttempt || !user?.uid) return;
    const attempt = gmailPopupAttempt;
    const isAttemptOwnerCurrent = () =>
      gmailOwnerIdRef.current === attempt.ownerId;
    const statusSatisfiesAttemptPurpose = (
      status: Awaited<ReturnType<typeof refreshGmailStatus>> | null,
    ) =>
      Boolean(
        status?.connected &&
          (attempt.purpose !== "send" ||
            status.send_permission_granted === true),
      );

    if (!isAttemptOwnerCurrent()) {
      gmailPopupRef.current?.close();
      clearGmailOAuthPopupAttempt();
      gmailPopupRef.current = null;
      setGmailPopupAttempt(null);
      setGmailActionBusy((current) => (current === "connect" ? null : current));
      return;
    }

    const clearAttempt = () => {
      clearGmailOAuthPopupAttempt();
      gmailPopupRef.current = null;
      setGmailPopupAttempt((current) =>
        current?.attemptId === attempt.attemptId ? null : current,
      );
      setGmailActionBusy((current) => (current === "connect" ? null : current));
    };

    const settleClosedPopup = async (
      message?: string,
      failureCode = "USER_CANCELLED",
    ) => {
      const intent = readOnboardingConnectorIntent();
      const callbackSettlement = consumeStoredGmailOAuthPopupSettlement(
        attempt.attemptId,
      );
      if (!isAttemptOwnerCurrent()) return;
      if (callbackSettlement && callbackSettlement.outcome !== "succeeded") {
        settledGmailPopupAttemptRef.current = attempt.attemptId;
        clearOnboardingConnectorIntent();
        toast.error(
          callbackSettlement.message ||
            (callbackSettlement.outcome === "cancelled"
              ? "Mail connection was cancelled."
              : "Mail connection could not be completed."),
        );
        return;
      }
      const status = await refreshGmailStatus({
        force: true,
        reconcile: false,
      }).catch(() => null);
      if (!isAttemptOwnerCurrent()) return;
      const journey = await PreVaultUserStateService.bootstrapState(user.uid, {
        force: true,
      }).catch(() => null);
      if (!isAttemptOwnerCurrent()) return;
      const matchesPendingSetupAttempt = Boolean(
        intent &&
        journey &&
        !PreVaultUserStateService.isSetupResolved(journey) &&
        journey.onboardingPhase === "external_connector" &&
        journey.onboardingActiveCapability === "gmail" &&
        journey.onboardingCallbackState === "pending" &&
        journey.onboardingCallbackAttemptId === intent.correlationId,
      );
      if (matchesPendingSetupAttempt && intent && journey) {
        await PreVaultUserStateService.syncOnboardingJourney({
          userId: user.uid,
          phase: "capability_setup",
          activeCapability: "gmail",
          callbackState: statusSatisfiesAttemptPurpose(status)
            ? "succeeded"
            : "cancelled",
          expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
          expectedCallbackAttemptId: intent.correlationId,
        }).catch(() => undefined);
      }
      clearOnboardingConnectorIntent();
      const statusSatisfiesPurpose = statusSatisfiesAttemptPurpose(status);
      if (statusSatisfiesPurpose) {
        toast.success("Mail connected. You can finish setup when ready.");
      } else {
        if (!callbackSettlement) {
          GmailReceiptsService.recordConsentFailure({
            code: failureCode,
          }, user.uid);
        }
        toast.message(
          message ||
            "The Mail window closed. You can try again whenever you are ready.",
        );
      }
    };

    const applySettlement = (settlement: {
      outcome: "succeeded" | "cancelled" | "failed";
      message?: string;
    }) => {
      if (settledGmailPopupAttemptRef.current === attempt.attemptId) return;
      if (!isAttemptOwnerCurrent()) return;
      consumeStoredGmailOAuthPopupSettlement(attempt.attemptId);
      settledGmailPopupAttemptRef.current = attempt.attemptId;
      const intent = readOnboardingConnectorIntent();
      clearAttempt();
      if (settlement.outcome === "succeeded") {
        void (async () => {
          const status = await refreshGmailStatus({
            force: true,
            reconcile: false,
          });
          if (!isAttemptOwnerCurrent()) return;
          if (journeyVariant === "onboarding" && intent) {
            const journey = await PreVaultUserStateService.bootstrapState(
              user.uid,
              { force: true },
            ).catch(() => null);
            if (!isAttemptOwnerCurrent()) return;
            const matchesPendingSetupAttempt = Boolean(
              journey &&
              !PreVaultUserStateService.isSetupResolved(journey) &&
              journey.onboardingPhase === "external_connector" &&
              journey.onboardingActiveCapability === "gmail" &&
              journey.onboardingCallbackState === "pending" &&
              journey.onboardingCallbackAttemptId === intent.correlationId,
            );
            if (matchesPendingSetupAttempt && journey) {
              await PreVaultUserStateService.syncOnboardingJourney({
                userId: user.uid,
                phase: "capability_setup",
                activeCapability: "gmail",
                callbackState: statusSatisfiesAttemptPurpose(status)
                  ? "succeeded"
                  : "cancelled",
                expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
                expectedCallbackAttemptId: intent.correlationId,
              }).catch(() => undefined);
            }
          }
          clearOnboardingConnectorIntent();
          if (statusSatisfiesAttemptPurpose(status)) {
            toast.success("Mail connected. You can finish setup when ready.");
          } else {
            toast.error(
              "Google authorization finished, but Mail is still connecting. Check again in a moment.",
            );
          }
        })();
        return;
      }
      clearOnboardingConnectorIntent();
      toast.error(
        settlement.message ||
          (settlement.outcome === "cancelled"
            ? "Mail connection was cancelled."
            : "Mail connection could not be completed."),
      );
    };

    const handlePopupSettlement = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== gmailPopupRef.current) return;
      if (!isGmailOAuthPopupSettlement(event.data)) return;
      if (event.data.attemptId !== attempt.attemptId) return;
      applySettlement(event.data);
    };

    // Fallback channel: if the popup's `window.opener` reference was lost,
    // postMessage never arrives. The popup also writes the same settlement
    // to localStorage, which fires a same-origin "storage" event here.
    const handleStorageSettlement = (event: StorageEvent) => {
      const settlement = readGmailOAuthPopupSettlementFallback(event);
      if (!settlement || settlement.attemptId !== attempt.attemptId) return;
      applySettlement(settlement);
    };

    window.addEventListener("message", handlePopupSettlement);
    window.addEventListener("storage", handleStorageSettlement);
    const closeWatcher = window.setInterval(() => {
      const popup = gmailPopupRef.current;
      if (popup?.closed) {
        clearAttempt();
        void settleClosedPopup();
        return;
      }
      if (Date.now() - attempt.startedAt < GMAIL_OAUTH_POPUP_TIMEOUT_MS) return;
      popup?.close();
      clearAttempt();
      void settleClosedPopup(
        "Mail is taking longer than expected. Check your connection and try again.",
        "POPUP_TIMEOUT",
      );
    }, 500);

    return () => {
      window.removeEventListener("message", handlePopupSettlement);
      window.removeEventListener("storage", handleStorageSettlement);
      window.clearInterval(closeWatcher);
    };
  }, [gmailPopupAttempt, journeyVariant, refreshGmailStatus, user?.uid]);

  useEffect(() => {
    onConnectionStateChange?.(isConnected);
  }, [isConnected, onConnectionStateChange]);

  const preserveGmailModify = gmail.status?.modify_permission_granted === true;
  const handleConnectGmail = useCallback((purpose: "read" | "send" = "read"): Promise<boolean> => {
    if (!user?.uid || gmailActionBusy !== null) return Promise.resolve(false);

    if (Capacitor.isNativePlatform()) {
      setGmailActionBusy("connect");
      return (async () => {
        try {
          // The normal Gmail workspace has no setup state to persist. Do not
          // leave its trusted popup on a placeholder while an unrelated
          // onboarding read waits on the database.
          const journey =
            journeyVariant === "onboarding"
              ? await PreVaultUserStateService.bootstrapState(user.uid, {
                  force: true,
                }).catch(() => null)
              : null;
          const fromSetup = Boolean(
            journeyVariant === "onboarding" &&
            journey &&
            !PreVaultUserStateService.isSetupResolved(journey) &&
            journey.onboardingActiveCapability === "gmail",
          );
          const idToken = await user.getIdToken();
          const nativeStart = await GmailReceiptsService.startNativeConnect({
            idToken,
            userId: user.uid,
            purpose,
          });
          if (!nativeStart.configured || !nativeStart.server_client_id) {
            throw new Error(
              "Mail OAuth is not configured for this environment.",
            );
          }

          let serverAuthCode: string;
          try {
            ({ serverAuthCode } = await HushhAuth.connectGmail({
              serverClientId: nativeStart.server_client_id,
              purpose: nativeStart.purpose,
              preserveModify: preserveGmailModify,
            }));
          } catch (error) {
            GmailReceiptsService.recordConsentFailure(error, user.uid);
            throw error;
          }
          if (!serverAuthCode?.trim()) {
            const error = new Error(
              "Google did not return a Mail authorization code.",
            );
            GmailReceiptsService.recordConsentFailure(error, user.uid);
            throw error;
          }

          await GmailReceiptsService.completeNativeConnect({
            idToken,
            userId: user.uid,
            serverAuthCode,
            purpose,
          });
          await refreshGmailStatus({ force: true });

          if (purpose === "read" && fromSetup && journey) {
            await PreVaultUserStateService.syncOnboardingJourney({
              userId: user.uid,
              phase: "capability_setup",
              activeCapability: "gmail",
              callbackState: "succeeded",
              expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            }).catch(() => undefined);
          }

          toast.success(
            purpose === "send"
              ? "Mail sending is enabled. Review your reply again before sending it."
              : "Mail connected. Your receipt scan will continue in the background.",
          );
          return true;
        } catch (error) {
          const message = sanitizeGmailUserMessage(error, {
            fallback:
              "We couldn't connect Mail right now. Please try again in a moment.",
          });
          console.warn(
            "[ProfileReceiptsPage] Failed to connect Gmail from native:",
            error instanceof Error ? error.message : error,
          );
          toast.error(message);
          return false;
        } finally {
          setGmailActionBusy(null);
        }
      })();
    }

    const attempt = createGmailOAuthPopupAttempt(user.uid, purpose);
    const popup = openGmailOAuthPopup(attempt);
    if (popup) {
      gmailPopupRef.current = popup;
      setGmailPopupAttempt(attempt);
    } else if (!persistGmailOAuthPopupAttempt(window, attempt)) {
      toast.error(
        "Mail sign-in could not be started safely. Please allow popups or try again.",
      );
      return Promise.resolve(false);
    }

    setGmailActionBusy("connect");

    return (async () => {
      try {
        const journey =
          journeyVariant === "onboarding"
            ? await PreVaultUserStateService.bootstrapState(user.uid, {
                force: true,
              }).catch(() => null)
            : null;
        const fromSetup = Boolean(
          purpose === "read" &&
            journeyVariant === "onboarding" &&
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
          includeGrantedScopes: purpose === "send" || isGoogleProvider,
          purpose,
        });

        if (!payload.configured || !payload.authorize_url) {
          throw new Error(
            "Mail OAuth is not configured for this environment.",
          );
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
          const popupIntentPersisted =
            !popup ||
            persistOnboardingConnectorIntentInStorage(
              getGmailOAuthPopupSessionStorage(popup),
              intent,
            );
          if (popup && !popupIntentPersisted) {
            console.warn(
              "[ProfileReceiptsPage] Gmail setup popup could not persist its browser correlation; the return route will recover from the durable journey.",
            );
          }
        }

        if (popup) {
          navigateGmailOAuthPopup(popup, payload.authorize_url);
        } else {
          assignWindowLocation(payload.authorize_url);
        }
        return true;
      } catch (error) {
        clearOnboardingConnectorIntent();
        if (popup) {
          clearGmailOAuthPopupAttempt(popup);
          popup.close();
        }
        gmailPopupRef.current = null;
        setGmailPopupAttempt(null);
        setGmailActionBusy(null);
        const message = sanitizeGmailUserMessage(error, {
          fallback:
            "We couldn't start Mail connection right now. Please try again in a moment.",
        });
        console.warn(
          "[ProfileReceiptsPage] Failed to start Gmail OAuth:",
          error instanceof Error ? error.message : error,
        );
        toast.error(message);
        return false;
      }
    })();
  }, [gmailActionBusy, journeyVariant, preserveGmailModify, refreshGmailStatus, user]);

  const handleEnableGmailSend = useCallback(() => {
    void handleConnectGmail("send");
  }, [handleConnectGmail]);

  /**
   * Opens One with an empty composer.
   *
   * This used to queue a demonstration prompt -- "explain all the features of
   * the Gmail agent" -- so every press started One drafting a sample email
   * about itself, and the card above it promised exactly that. Someone opening
   * chat from their Gmail workspace is going somewhere to write a real email,
   * so neither the promise nor the draft is made any more.
   */
  const handleOpenOneChat = useCallback(() => {
    navigateToAgentChat();
  }, []);

  useLocalOnboardingActionHandler("setup.connect_gmail", () => {
    if (journeyVariant !== "onboarding") {
      return {
        status: "blocked",
        summary: "Open Mail setup before connecting Mail.",
      };
    }
    if (gmailActionBusy !== null) {
      return {
        status: "blocked",
        summary: "Mail connection is already being prepared.",
      };
    }
    return handleConnectGmail().then((opened) => {
      if (!opened) {
        return {
          status: "blocked",
          summary:
            "Use the Connect Mail button to open the secure Mail connection window.",
        };
      }
      return {
        status: "started",
        summary:
          "Mail connection is open in its secure window. Finish setup after it verifies.",
      };
    });
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
              throw new Error("Mail could not be disconnected.");
            }
            return next;
          })(),
          {
            loading: "Disconnecting Mail...",
            success: "Mail disconnected and Mail receipt data was deleted.",
            error: (error) =>
              sanitizeGmailUserMessage(error, {
                fallback:
                  "We couldn't disconnect Mail right now. Please try again in a moment.",
              }),
            variant: "destructive",
          },
        )
        .unwrap();
      clearCachedGmailReceipts(user.uid);
      receiptsRef.current = [];
      setReceipts([]);
      setPage(1);
      setHasMore(false);
      setTotal(0);
      setReceiptScanReachedLimit(false);
      setReceiptMemoryArtifact(null);
      setReceiptMemorySaveState("idle");
      setReceiptMemoryMessage(null);
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
      if (!isConnected || receiptScanInProgress || loadingReceipts) {
        return;
      }
      if (!receiptSyncAvailable) {
        return;
      }
      setReceiptScanInProgress(true);
      setReceiptSyncFeedback({
        message: "Looking through your recent purchases…",
        tone: "neutral",
      });
      const loaded = await loadReceipts(1);
      if (loaded === null) return;
      if (!loaded) throw new Error("Receipt scan did not complete.");
      setReceiptSyncFeedback({
        message: "Receipts updated.",
        tone: "success",
      });
      toast.success("Receipts updated");
    } catch (error) {
      console.error("[ProfileReceiptsPage] Failed to start Gmail sync:", error);
      const message = "Couldn’t finish scanning your receipts.";
      setReceiptSyncFeedback({ message, tone: "error" });
    } finally {
      setReceiptScanInProgress(false);
    }
  }, [
    isConnected,
    loadReceipts,
    loadingReceipts,
    receiptScanInProgress,
    receiptSyncAvailable,
    user?.uid,
  ]);

  const progressPercent = receiptScanProgress
    ? Math.min(
        95,
        Math.max(
          5,
          Math.round(
            ((receiptScanProgress.page - 1) / receiptScanProgress.maxPages) *
              100,
          ),
        ),
      )
    : null;
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const pageTitle = useMemo(
    () =>
      isConnected && gmail.status?.google_email
        ? `Connected to ${gmail.status.google_email}`
        : connectorState === "connected_initial_scan_running"
          ? "Connected to your Mail"
          : connectorState === "connected_backfill_running"
            ? "Connected to your Mail"
            : hasStoredReceipts
              ? "Saved receipts are still available here."
              : undefined,
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
  const receiptSyncInProgress =
    receiptSyncAvailable && (receiptScanInProgress || loadingReceipts);
  const receiptSyncInlineFeedback =
    !receiptSyncAvailable && !loadingStatus
      ? {
          message: hasSealedReceiptAccess
            ? "Receipt sync is not available for this account right now."
            : "Open your private vault before scanning Mail receipts.",
          tone: "neutral" as const,
        }
      : receiptSyncInProgress
        ? {
            message: "Looking through your recent purchases…",
            tone: "neutral" as const,
          }
        : receiptListError
          ? null
          : receiptSyncFeedback;
  const hasStaleBackgroundSync = gmail.isStale && receiptSyncInProgress;
  // A zero is meaningful only after Gmail is connected and a scan can have
  // completed. Before then it reads like a result rather than an unavailable
  // source. Saved receipts remain countable after a deliberate disconnect.
  const shouldShowReceiptCount = isConnected || hasStoredReceipts;
  const canBuildReceiptMemoryPreview =
    Boolean(user?.uid) &&
    hasSealedReceiptAccess &&
    !receiptStorageReadOnly &&
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
  const cachedReceipts = user?.uid
    ? getCachedGmailReceipts(user.uid, receiptAccountKey)
    : null;
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
  // The run response settles before the aggregate status refresh. Prefer it
  // so a completed fetch never keeps the overview spinner alive.
  const overviewReceiptsActive = gmail.syncRun
    ? gmail.syncRun.status === "queued" || gmail.syncRun.status === "running"
    : isSyncingState;
  const overviewReceiptIssue =
    statusSummary.tone === "error" ||
    gmail.syncRun?.status === "failed" ||
    gmail.syncRun?.status === "canceled";
  // After connecting, every fetch is the person's past purchases; only a
  // manual refresh is about the latest ones. The status-cache age is not shown
  // here (the receipts workspace carries that note): it would swap the copy
  // mid-fetch for no reason the person can act on.
  const overviewFetchingDetail = useHeldValue(
    overviewReceiptsActive
      ? isPassiveBackfillState ||
        connectorState === "connected_initial_scan_running"
        ? "Fetching older purchases…"
        : "Fetching your latest purchases…"
      : null,
    OVERVIEW_RECEIPT_SYNC_SETTLE_MS,
  );
  // A failure is never held back: only a run that ended cleanly can be a seam
  // between two fetches.
  const heldOverviewFetchingDetail = overviewReceiptIssue
    ? null
    : overviewFetchingDetail;
  const overviewReceiptsFetching = heldOverviewFetchingDetail !== null;
  const overviewReceiptDetail = loadingStatus
    ? "Checking your Mail status…"
    : heldOverviewFetchingDetail
      ? heldOverviewFetchingDetail
      : statusSummary.tone === "error"
        ? `${statusSummary.title}. ${statusSummary.detail}`
        : gmail.syncRun?.status === "failed" ||
            gmail.syncRun?.status === "canceled"
          ? "Sync interrupted. Open receipts to retry."
          : receiptStorageReadOnly
            ? "Existing receipts are available while private on-device sync is prepared."
            : gmail.status?.last_sync_at ||
                gmail.syncRun?.status === "completed"
              ? "Your latest receipts are ready."
              : "Organize your purchases in one place.";
  const primaryActionLabel = isConnected
    ? receiptSyncAvailable
      ? receiptSyncInProgress
        ? "Syncing receipts…"
        : "Sync receipts"
      : "Sync unavailable"
    : connectorState === "needs_reauthentication" || gmail.status?.revoked
      ? "Reconnect Mail"
      : "Connect Mail";
  const connectGmailHelper = Capacitor.isNativePlatform()
    ? "A secure Google account sheet opens next. Approve Mail access and return here automatically."
    : null;
  // "loading" intentionally shares the neutral tone: it is a transient state
  // between page load and a real status, and briefly painting it in the
  // brand-accent colour before it resolves to success/error reads as a flash.
  const statusToneClassName =
    statusSummary.tone === "success"
      ? "border-emerald-500/18 bg-emerald-500/[0.05]"
      : statusSummary.tone === "error"
        ? "border-rose-500/22 bg-rose-500/[0.06]"
        : "border-border/60 bg-background/68";
  const receiptsVoiceSurfaceMetadata = useMemo(() => {
    const receiptsWorkspaceForVoice =
      journeyVariant === "onboarding" ||
      (isConnected && workspace === "receipts");
    if (!receiptsWorkspaceForVoice) {
      const controls = !isConnected
        ? [
            {
              id: "open_gmail_connector",
              label: primaryActionLabel,
              purpose:
                "starts Mail connection or reconnection from this Mail workspace.",
              actionId: null,
              role: "button",
              voiceAliases: [
                "connect gmail",
                "open gmail connector",
                "open gmail",
              ],
            },
          ]
        : [];
      const title = workspace === "kyc" ? "KYC" : "Mail overview";
      const purpose =
        workspace === "kyc"
          ? isConnected
            ? "This workspace helps you import KYC details, monitor new requests, and review every reply before sending."
            : "Connect Gmail here to find KYC requests and manage the identity details used in replies."
          : "This workspace lets you choose receipts, KYC monitoring, or One Chat mail help.";
      const activeControl =
        controls.find((control) => control.id === activeVoiceControlId) ||
        controls.find((control) => control.id === lastVoiceControlId) ||
        null;
      return {
        surfaceDefinition: {
          screenId: "gmail",
          title,
          purpose,
          sections: [
            {
              id: workspace === "kyc" ? "kyc_requests" : "gmail_overview",
              title,
              purpose,
            },
          ],
          actions: controls.map((control) => ({
            id: control.id,
            label: control.label,
            purpose: control.purpose,
          })),
          controls,
          concepts: [],
          activeControlId: activeVoiceControlId,
          lastInteractedControlId: lastVoiceControlId,
        },
        activeSection: title,
        visibleModules: [title],
        focusedWidget: activeControl?.label || title,
        modalState: showVaultUnlock ? "vault_unlock" : null,
        availableActions: controls.map((control) => control.label),
        activeControlId: activeVoiceControlId,
        lastInteractedControlId: lastVoiceControlId,
        busyOperations: gmailActionBusy === "connect" ? ["gmail_connect"] : [],
        screenMetadata: {
          connector_state: connectorState,
          connector_badge_label: gmail.presentation.badgeLabel,
          connector_summary: statusSummary.detail,
          workspace,
        },
      };
    }
    const visibleModules = ["Receipt sync", "Recent receipts"];

    const controls = [
      ...(isConnected
        ? [
            ...(receiptSyncAvailable
              ? [
                  {
                    id: "sync_gmail_receipts",
                    label: "Sync receipts",
                    purpose: "starts or refreshes Mail receipt sync.",
                    actionId: "profile.gmail.sync_now",
                    role: "button",
                    voiceAliases: ["sync gmail", "sync receipts"],
                  },
                ]
              : []),
            {
              id: "disconnect_gmail",
              label: "Disconnect Mail",
              purpose:
                "disconnects Mail sync while keeping already saved receipts available.",
              role: "button",
              voiceAliases: ["disconnect gmail", "turn off gmail sync"],
            },
          ]
        : [
            {
              id: "open_gmail_connector",
              label: primaryActionLabel,
              purpose:
                "starts Mail connection or reconnection from this receipts page.",
              actionId:
                journeyVariant === "onboarding" ? "setup.connect_gmail" : null,
              role: "button",
              voiceAliases: [
                "connect gmail",
                "open gmail connector",
                "open gmail",
              ],
            },
          ]),
      ...(!isConnected && gmail.statusError
        ? [
            {
              id: "retry_gmail_status",
              label: "Retry Mail status",
              purpose:
                "rechecks the saved Mail connection without opening Google consent.",
              role: "button",
              voiceAliases: [
                "retry gmail status",
                "retry gmail",
                "check gmail",
              ],
            },
          ]
        : []),
      ...(journeyVariant === "onboarding" && onFinishSetup && onSkipSetup
        ? isConnected
          ? [
              {
                id: "finish_gmail_setup",
                label: "Finish Mail setup",
                purpose:
                  "records the verified Mail connection and returns to setup.",
                actionId: "setup.finish_gmail",
                role: "button",
                voiceAliases: ["finish gmail setup", "finish gmail"],
              },
            ]
          : gmailActionBusy === null
            ? [
                {
                  id: "skip_gmail_setup",
                  label: "Skip Mail setup",
                  purpose: "returns to setup without marking Mail as complete.",
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
          ? "Connect Mail, review receipt-based purchase signals, then explicitly finish Mail setup."
          : "This page keeps receipt sync and recent Mail receipts together in one view.",
      sections: [
        {
          id: "receipt_sync",
          title: "Receipt sync",
          purpose:
            "This section starts supported receipt sync and shows its progress in place.",
        },
        {
          id: "stored_receipts",
          title: "Recent receipts",
          purpose: "This section lists the receipts we already found in Mail.",
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
          label: "Mail receipts",
          explanation:
            "Mail receipts brings receipt records into one place while keeping access behind the private vault.",
          aliases: ["gmail receipts", "receipt sync"],
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
      activeSection: receiptSyncInProgress ? "Receipt sync" : "Recent receipts",
      visibleModules,
      focusedWidget: activeControl?.label || "Receipts list",
      modalState: showVaultUnlock ? "vault_unlock" : null,
      availableActions,
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(receiptSyncInProgress ? ["gmail_sync"] : []),
        ...(gmailActionBusy === "connect" ? ["gmail_connect"] : []),
        ...(gmailActionBusy === "disconnect" ? ["gmail_disconnect"] : []),
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
                    "Reconnect Mail to continue syncing your receipts.",
                },
              )
            : null,
      },
    };
  }, [
    connectorState,
    gmail.presentation.badgeLabel,
    gmail.statusError,
    gmail.status?.last_sync_error,
    gmail.syncRun,
    gmailActionBusy,
    hasMore,
    activeVoiceControlId,
    isConnected,
    receiptSyncInProgress,
    lastVoiceControlId,
    latestSyncBadge,
    latestSyncText,
    loadingReceipts,
    primaryActionLabel,
    receiptSyncAvailable,
    statusSummary.detail,
    showVaultUnlock,
    total,
    journeyVariant,
    onFinishSetup,
    onSkipSetup,
    workspace,
  ]);

  const requestVaultUnlock = useCallback(() => {
    setShowVaultUnlock(true);
    toast.info("Set up or open your private vault to view synced receipts.");
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
        setReceiptMemoryMessage(null);
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

  useEffect(() => {
    if (
      !autoReceiptSummaryKey ||
      !receiptsWorkspaceActive ||
      loadingStatus ||
      loadingReceipts ||
      isSyncingState ||
      receiptMemoryLoading
    ) {
      return;
    }
    if (autoReceiptSummaryKeyRef.current === autoReceiptSummaryKey) return;

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
    receiptMemoryLoading,
    receiptMemoryWatermarkCurrent,
    receiptsWorkspaceActive,
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
      setReceiptMemoryMessage(null);
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

        if (!result.success) throw new Error("Failed to save receipt memory.");
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

  usePublishVoiceSurfaceMetadata(receiptsVoiceSurfaceMetadata, {
    role: voicePublisherRole,
  });

  const handleLoadMore = useCallback(async () => {
    const loaded = await loadReceipts(page + 1);
    if (loaded === false) {
      toast.error(
        "We couldn't load older receipts right now. Please try again.",
      );
    }
  }, [loadReceipts, page]);

  // Workspace status belongs inside the pager too: a disconnected or loading
  // pane must follow the same gesture and inactive-action boundary.
  const mailStatusPanel = (
    <SurfaceInset
      className={`space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5 ${statusToneClassName}`}
    >
      {loadingStatus ? (
        <div
          aria-busy="true"
          aria-label="Checking your Gmail status"
          className="space-y-3"
        >
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Gmail
            </p>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {oauthCompletionPending
                ? "Finishing Gmail connection"
                : "Checking your Gmail status"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {oauthCompletionPending
                ? "Your Gmail page is ready. Inbox details and receipts will appear here in the background."
                : "Your inbox and receipts will appear here as they are ready."}
            </p>
          </div>
          <div aria-hidden="true" className="space-y-2 pt-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Status
            </p>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {statusSummary.title}
            </h2>
            {statusSummary.detail &&
            (!isConnected || !statusSummary.detail.startsWith("Connected to")) ? (
              <p className="break-words text-sm text-muted-foreground">
                {statusSummary.detail}
              </p>
            ) : null}
            {statusSummary.helper ? (
              <p className="break-words text-xs text-muted-foreground">
                {statusSummary.helper}
              </p>
            ) : null}
          </div>
          {shouldShowReceiptCount ? (
            <Badge variant="secondary" className="shrink-0">
              {total} receipt{total === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      )}

      {receiptSyncInProgress && !isPassiveBackfillState ? (
        <p className="text-xs text-muted-foreground">
          Scanning Mail for receipts. Your list will refresh here when it
          finishes.
        </p>
      ) : null}
      {hasStaleBackgroundSync ? (
        <p className="text-xs text-amber-600">
          Mail is still running in the background. This status may lag behind for
          a bit.
        </p>
      ) : null}
      {!isConnected && !loadingStatus ? (
        <div className="flex flex-col items-center justify-center gap-2 pt-2 sm:flex-row">
          <Button
            onClick={() => void handleConnectGmail()}
            disabled={gmailActionBusy !== null}
            className="h-12 w-full max-w-[244px] justify-center px-8 text-center text-base shadow-lg"
            data-voice-control-id="open_gmail_connector"
            data-voice-action-id={
              journeyVariant === "onboarding" ? "setup.connect_gmail" : undefined
            }
            data-voice-label={primaryActionLabel}
            data-voice-purpose="starts Mail connection or reconnection from this receipts page."
          >
            {primaryActionLabel}
          </Button>
          {gmail.statusError ? (
            <Button
              variant="none"
              effect="fade"
              onClick={() =>
                void refreshGmailStatus({
                  force: true,
                  reconcile: false,
                })
              }
              disabled={gmailActionBusy !== null || loadingStatus}
              className="h-12 w-full max-w-[244px] justify-center px-8 text-center text-base"
              data-voice-control-id="retry_gmail_status"
              data-voice-label="Retry Mail status"
              data-voice-purpose="rechecks the Mail connection without opening Google consent."
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry Mail status
            </Button>
          ) : null}
          {connectGmailHelper ? (
            <p className="w-full text-center text-xs text-muted-foreground sm:basis-full">
              {connectGmailHelper}
            </p>
          ) : null}
        </div>
      ) : null}
    </SurfaceInset>
  );

  const receiptsPanel = (
    <div className="space-y-4">
      {journeyVariant === "workspace" && !isConnected ? mailStatusPanel : null}
      {journeyVariant === "workspace" && isConnected ? (
        <GmailReceiptOnboardingHero
          onStartReceiptSync={() => void handleSyncNow()}
          progressPercent={progressPercent}
          statusMessage={receiptSyncInlineFeedback?.message}
          statusTone={receiptSyncInlineFeedback?.tone}
          syncAvailable={receiptSyncAvailable}
          syncing={receiptSyncInProgress}
        />
      ) : null}

      {/* Keep the governed preview/save pipeline intact while the generic
        summary card is intentionally absent from this landing view. */}
      {SHOW_RECEIPT_MEMORY_SUMMARY_ON_LANDING &&
      isConnected &&
      receiptsWorkspaceActive ? (
        <SurfaceInset className="space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Shopping summary
            </h2>
            <p className="text-sm text-muted-foreground">
              Generated from your receipts for your private memory.
            </p>
          </div>
          {receiptMemoryLoading && !receiptMemoryArtifact ? (
            <div className="flex items-center gap-2.5 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating summary…
            </div>
          ) : null}
          {receiptMemoryArtifact ? (
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
              {
                receiptMemoryArtifact.candidate_pkm_payload.receipts_memory
                  .readable_summary.text
              }
            </p>
          ) : null}
          {!canBuildReceiptMemoryPreview ? (
            <p className="text-xs text-muted-foreground">
              Sync receipts first to create a shopping summary.
            </p>
          ) : null}
          {receiptMemoryArtifact && receiptMemorySaveState !== "saved" ? (
            <Button
              type="button"
              onClick={() => void persistReceiptMemory(receiptMemoryArtifact)}
              disabled={receiptMemorySaveState === "saving"}
            >
              {receiptMemorySaveState === "saving"
                ? "Saving summary…"
                : "Save shopping summary"}
            </Button>
          ) : null}
          {receiptMemoryMessage && receiptMemorySaveState !== "saving" ? (
            <p className="text-xs text-muted-foreground">
              {receiptMemoryMessage}
            </p>
          ) : null}
        </SurfaceInset>
      ) : null}

      {receiptsWorkspaceActive && (isConnected || receipts.length > 0) ? (
        <section
          aria-labelledby="recent-receipts-title"
          className="space-y-3"
          data-testid="recent-receipts"
        >
          <SectionHeader
            id="recent-receipts-title"
            testId="recent-receipts-header"
            title="Recent receipts"
          />

          {isConnected && !hasSealedReceiptAccess && !loadingStatus ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Lock className="h-4 w-4" />
                Set up or open your private vault to view synced receipts.
              </div>
              <Button onClick={requestVaultUnlock}>Set up vault</Button>
            </SurfaceInset>
          ) : null}

          {showReceiptPlaceholders ? <ReceiptListSkeleton /> : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          receiptListError &&
          receipts.length === 0 &&
          !loadingReceipts ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm">
              <p className="text-muted-foreground">
                Couldn’t finish scanning your receipts.
              </p>
              <Button
                variant="none"
                effect="fade"
                onClick={() => void loadReceipts(receiptListRetryPage)}
              >
                Try again
              </Button>
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          !loadingReceipts &&
          !showReceiptPlaceholders &&
          !receiptListError &&
          receipts.length === 0 &&
          !hasMore &&
          !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {receiptScanReachedLimit
                ? `No receipts were found within the ${RECEIPT_SCAN_MAX_PAGES} Mail pages checked.`
                : gmail.syncRun?.synced_count
                  ? "Your receipts are still finishing up. Please try again in a moment."
                  : "No receipts are available for this account yet."}
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          receiptListError &&
          receipts.length > 0 &&
          !loadingReceipts ? (
            <SurfaceInset className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
              <p className="text-muted-foreground">
                Couldn’t finish scanning your receipts.
              </p>
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => void loadReceipts(receiptListRetryPage)}
              >
                Try again
              </Button>
            </SurfaceInset>
          ) : null}

          {hasSealedReceiptAccess && receipts.length > 0 ? (
            <GmailRecentReceipts
              accountKey={
                gmail.status?.google_sub || gmail.status?.google_email || null
              }
              loadReceiptDetail={loadReceiptDetail}
              onReceiptDetailLoaded={handleReceiptDetailLoaded}
              receipts={receipts}
            />
          ) : null}

          {hasSealedReceiptAccess && hasMore ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="none"
                effect="fade"
                onClick={() => void handleLoadMore()}
                disabled={loadingReceipts}
                data-voice-control-id="load_older_receipts"
                data-voice-label={
                  receipts.length > 0
                    ? "Load older receipts"
                    : "Check older Mail"
                }
                data-voice-purpose="checks the next bounded Mail receipt page."
              >
                {receipts.length > 0
                  ? "Load older receipts"
                  : "Check older Mail"}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );

  return (
    <AppPageShell
      as="div"
      width={journeyVariant === "workspace" ? "agent" : "reading"}
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.5rem)]"
      nativeTest={{
        routeId:
          journeyVariant === "workspace"
            ? ROUTES.GMAIL
            : ROUTES.ONE_SETUP_GMAIL,
        marker:
          journeyVariant === "workspace"
            ? "native-route-gmail"
            : "native-route-one-setup-gmail",
        authState: user ? "authenticated" : loading ? "pending" : "anonymous",
        dataState: loadingReceipts
          ? "loading"
          : receiptListError
            ? "error"
            : !isConnected
              ? "unavailable-valid"
              : receipts.length > 0
                ? "loaded"
                : "empty-valid",
        errorCode: receiptListError ? "gmail_receipts_load_failed" : null,
        errorMessage: receiptListError,
      }}
    >
      <AppPageHeaderRegion
        className={
          journeyVariant === "workspace" ? "mx-auto max-w-[820px]" : undefined
        }
      >
        <PageHeader
          title="Mail"
          titleRole={journeyVariant === "workspace" ? "agent" : "page"}
          description={pageTitle}
          className={
            journeyVariant === "workspace"
              ? "[&_[data-slot=page-header-copy]]:!space-y-3"
              : undefined
          }
          actions={
            isConnected && journeyVariant === "onboarding" ? (
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Button
                  onClick={() => void handleSyncNow()}
                  disabled={
                    receiptSyncInProgress ||
                    !receiptSyncAvailable ||
                    gmailActionBusy !== null
                  }
                  className="w-full sm:w-auto sm:min-w-[150px]"
                  data-voice-control-id="sync_gmail_receipts"
                  data-voice-action-id="profile.gmail.sync_now"
                  data-voice-label={primaryActionLabel}
                  data-voice-purpose="starts or refreshes Mail receipt sync."
                >
                  {receiptSyncInProgress ? (
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
                  disabled={receiptSyncInProgress || gmailActionBusy !== null}
                  className="w-full sm:w-auto sm:min-w-[150px]"
                  data-voice-control-id="disconnect_gmail"
                  data-voice-label="Disconnect Mail"
                  data-voice-purpose="disconnects Mail sync while keeping stored receipts available."
                >
                  Disconnect
                </Button>
              </div>
            ) : null
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion
        className={
          journeyVariant === "workspace"
            ? "mx-auto !mt-0 max-w-[820px]"
            : undefined
        }
      >
        <SurfaceStack compact>
          {journeyVariant === "workspace" ? (
            <GmailWorkspaceNavigation
              value={workspace}
              onValueChange={setWorkspace}
            />
          ) : null}

          {journeyVariant === "onboarding" ? mailStatusPanel : null}

          {journeyVariant === "onboarding" && onFinishSetup && onSkipSetup ? (
            <SetupCompletionFooter
              label={isConnected ? "Finish Mail setup" : "Skip Mail setup"}
              onComplete={isConnected ? onFinishSetup : onSkipSetup}
              busy={isConnected ? finishingSetup : skippingSetup}
              disabled={gmailActionBusy !== null}
              controlId={
                isConnected ? "finish_gmail_setup" : "skip_gmail_setup"
              }
              actionId={isConnected ? "setup.finish_gmail" : "setup.skip_gmail"}
              purpose={
                isConnected
                  ? "records verified Mail connection and returns to setup."
                  : "returns to setup without recording Mail as complete."
              }
              variant={isConnected ? "blue-gradient" : "none"}
              effect={isConnected ? "fill" : "fade"}
              supportingText={
                isConnected
                  ? undefined
                  : "You can connect Mail from setup whenever you are ready."
              }
            />
          ) : null}

          {journeyVariant === "workspace" ? (
            <GmailWorkspacePanels
              value={workspace}
              onValueChange={setWorkspace}
              panels={{
                overview: (
                  <>
                    {!isConnected ? mailStatusPanel : null}
                    {isConnected ? (
                      <MailConnectedAccount
                        busy={gmailActionBusy !== null || loadingStatus}
                        onReconnect={() => void handleConnectGmail()}
                        onDisconnect={() => setShowDisconnectConfirm(true)}
                      />
                    ) : null}
                    {isConnected ? (
                      <MailOverview
                        fetching={overviewReceiptsFetching}
                        receiptIssue={overviewReceiptIssue}
                        receiptCount={receiptListReady ? total : undefined}
                        receiptDetail={overviewReceiptDetail}
                        receiptUpdated={resolveGmailLastUpdatedLabel(
                          gmail.status,
                          gmail.syncRun,
                        )}
                        onOpenChat={handleOpenOneChat}
                      />
                    ) : null}
                  </>
                ),
                kyc: (
                  <>
                    {!isConnected && (loadingStatus || gmail.statusError) ? mailStatusPanel : null}
                    {!isConnected && !loadingStatus && !gmail.statusError ? (
                      <MailKycConnectEntry
                        busy={gmailActionBusy !== null}
                        onConnect={() => void handleConnectGmail()}
                      />
                    ) : null}

                    {isConnected &&
                    (kycVisitedOwner === user?.uid || workspace === "kyc") ? (
                      <div
                        key={`${user?.uid ?? "guest"}:${Boolean(vaultKey && vaultOwnerToken)}`}
                      >
                        <GmailVerificationOnboarding
                          userId={user?.uid || null}
                          vaultKey={vaultKey}
                          vaultOwnerToken={vaultOwnerToken}
                          onRequestVaultUnlock={requestVaultUnlock}
                          deferred={verificationDeferred}
                          onDeferredChange={setVerificationDeferred}
                          details={verificationDraft}
                          onDetailsChange={setVerificationDraft}
                        >
                          <GmailInformationRequestsSection
                            active={workspace === "kyc"}
                            userId={user?.uid || null}
                            vaultKey={vaultKey}
                            vaultOwnerToken={vaultOwnerToken}
                            isConnected
                            idTokenProvider={
                              user?.getIdToken ? idTokenProvider : null
                            }
                            onRequestVaultUnlock={requestVaultUnlock}
                            onEnableGmailSend={handleEnableGmailSend}
                          />
                        </GmailVerificationOnboarding>
                      </div>
                    ) : null}

                    {isConnected &&
                    kycVisitedOwner !== user?.uid &&
                    workspace !== "kyc" ? (
                      <Skeleton
                        aria-label="Loading KYC"
                        className="h-32 w-full"
                      />
                    ) : null}
                  </>
                ),
                receipts: receiptsPanel,
              }}
            />
          ) : (
            receiptsPanel
          )}
        </SurfaceStack>
      </AppPageContentRegion>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={setShowVaultUnlock}
          title="Set up your private vault"
          description="Set up your private vault to view synced receipt records."
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
            <AlertDialogTitle>Disconnect Mail?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes Mail access, stops future receipt sync, and deletes
              Mail-derived receipts and receipt summaries from Hushh.
              Information you explicitly saved to private memory remains there.
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
              Disconnect Mail
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}
