"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { GmailReceiptMemorySave } from "@/components/gmail/gmail-receipt-memory-save";
import { DurableResourceError, durableResourceError } from "@/lib/services/durable-resource-error";
import { captureReceiptSnapshot, receiptAccountBinding, receiptSnapshotRows, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { resolveSavedReceiptMerchantBrand } from "@/lib/mail/receipt-merchant-registry";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import { loadReceiptSnapshot, receiptStoreVersion, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { GmailVerificationOnboarding } from "@/components/gmail/gmail-verification-onboarding";
import { GmailReceiptOnboardingHero } from "@/components/gmail/gmail-receipt-onboarding-hero";
import {
  GmailWorkspaceNavigation,
  GmailWorkspacePanels,
  type GmailWorkspace,
} from "@/components/gmail/gmail-workspace-navigation";
import { MailConnectionStatus } from "@/components/gmail/mail-kyc-connect-entry";
import { MailOverview, MailConnectedAccount } from "@/components/gmail/mail-overview";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
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
import { MailActionButton as Button } from "./mail-action-button";
import mailStyles from "./mail-workspace.module.css";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { roleSolid } from "@/lib/morphy-ux/tokens/semantic-roles";
import { withDeadline } from "@/lib/utils/with-deadline";
import { useAuth } from "@/hooks/use-auth";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
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
  cachedGmailReceiptDisplayItems,
  clearCachedGmailReceipts,
  getGmailReceiptCacheRevision,
  getCachedGmailReceipts,
  isCachedGmailReceiptScanResumable,
  mergeCachedReceiptItems,
  primeCachedGmailReceipts,
  upsertCachedGmailReceipt,
} from "@/lib/profile/gmail-receipts-cache";
import {
  getGmailWorkspaceSession,
  setGmailWorkspaceSession,
} from "@/lib/profile/gmail-workspace-session";
import {
  GmailReceiptsService,
  isReceiptConnectionLostError,
  isReceiptScanInProgressError,
  isReceiptScanContinuationExpiredError,
  isRetryableReceiptScanPageError,
  type ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";
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
const RECEIPT_SCAN_PAGE_RETRIES = 2;
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
} from "@/lib/kai/actions/voice-surface-metadata";
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
  const [savedReceiptSnapshot, setSavedReceiptSnapshot] = useState<{ scope: string | null; value: ReceiptSnapshot } | null>(null);
  const savedReceiptSnapshotRef = useRef(savedReceiptSnapshot);
  savedReceiptSnapshotRef.current = savedReceiptSnapshot;
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [receiptListReady, setReceiptListReady] = useState(false);
  const [receiptListError, setReceiptListError] = useState<string | null>(null);
  const [receiptListRetryPage, setReceiptListRetryPage] = useState(1);
  // Mail rejected the saved login (expired or revoked). Another read cannot
  // succeed, so the page asks for a reconnect instead of offering Try again.
  const [receiptConnectionLost, setReceiptConnectionLost] = useState(false);
  // Counts finished syncs. The memory save control saves each one once; the ref
  // records which are already covered, across the control's own remounts.
  const [receiptCompletion, setReceiptCompletion] = useState<{ scope: string; count: number; generation?: number; revision?: number } | null>(null);
  const [receiptSourceAliases, setReceiptSourceAliases] = useState<Record<string, string>>({});
  const receiptMemorySavedCompletionRef = useRef(0);
  const [receiptScanReachedLimit, setReceiptScanReachedLimit] = useState(false);
  const [receiptScanInProgress, setReceiptScanInProgress] = useState(false);
  const [receiptScanProgress, setReceiptScanProgress] = useState<{
    page: number;
    maxPages: number;
    waitingForActiveScan: boolean;
  } | null>(null);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
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
  const receiptReadsClosedRef = useRef(false);
  const receiptLoadSequenceRef = useRef(0);
  const receiptScanAbortRef = useRef<AbortController | null>(null);
  const receiptConnectionLostRef = useRef(false);
  const receiptPersistenceFailedRef = useRef(false);
  const receiptConnectionLostAtRef = useRef<string | null>(null);
  const refreshGmailStatusRef = useRef<
    ((options?: { force?: boolean }) => Promise<unknown>) | null
  >(null);
  const receiptScanPromiseRef = useRef<Promise<boolean | null> | null>(null);
  const receiptScanCursorsRef = useRef(new Map<number, string>());
  const receiptAccountKeyRef = useRef<string | null>(null);
  const displayedReceiptScopeRef = useRef<string | null>(null);
  const settledGmailPopupAttemptRef = useRef<string | null>(null);
  const gmailPopupRef = useRef<Window | null>(null);
  const gmailOwnerIdRef = useRef<string | null>(user?.uid ?? null);
  const sealedReceiptAccessRef = useRef({
    isUnlocked: isVaultUnlocked,
    ownerToken: vaultOwnerToken,
  });
  useLayoutEffect(() => {
    const owner = user?.uid ?? null;
    const previousAccess = sealedReceiptAccessRef.current;
    if (gmailOwnerIdRef.current !== owner || previousAccess.ownerToken !== vaultOwnerToken || previousAccess.isUnlocked !== isVaultUnlocked) {
      receiptLoadSequenceRef.current += 1;
      receiptScanAbortRef.current?.abort();
      receiptScanAbortRef.current = null;
      receiptScanPromiseRef.current = null;
      if (gmailOwnerIdRef.current !== owner) receiptReadsClosedRef.current = false;
    }
    gmailOwnerIdRef.current = owner;
    sealedReceiptAccessRef.current = { isUnlocked: isVaultUnlocked, ownerToken: vaultOwnerToken };
  }, [user?.uid, vaultOwnerToken, isVaultUnlocked]);
  useEffect(() => {
    setLoadingReceipts(false);
    setReceiptScanInProgress(false);
    setReceiptScanProgress(null);
  }, [user?.uid, vaultOwnerToken, isVaultUnlocked]);
  useEffect(() => { setGmailActionBusy(null); }, [user?.uid]);
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
  const [verificationIntake, setVerificationIntake] = useState<{
    ownerId: string | undefined; vaultKey: string | null; deferred: boolean; draft: string;
  } | null>(null);
  const verificationIntakeCurrent = verificationIntake?.ownerId === user?.uid &&
    verificationIntake?.vaultKey === vaultKey;
  const verificationDeferred = verificationIntakeCurrent ? verificationIntake?.deferred ?? false : false;
  const verificationDraft = verificationIntakeCurrent ? verificationIntake?.draft ?? "" : "";
  const setVerificationDeferred = (deferred: boolean) => setVerificationIntake({
    ownerId: user?.uid, vaultKey, deferred, draft: verificationDraft,
  });
  const setVerificationDraft = (draft: string) => setVerificationIntake({
    ownerId: user?.uid, vaultKey, deferred: verificationDeferred, draft,
  });
  const receiptsWorkspaceActive =
    journeyVariant === "onboarding" || workspace === "receipts";

  useEffect(() => {
    receiptsRef.current = receipts;
  }, [receipts]);

  const canLoad = Boolean(user?.uid);
  const hasSealedReceiptAccess = Boolean(vaultOwnerToken && isVaultUnlocked);

  const runReceiptScan = useCallback(
    async (nextPage: number): Promise<boolean | null> => {
      const operationDeadline = Date.now() + 300_000;
      if (!user?.uid || !vaultOwnerToken || !isVaultUnlocked || receiptReadsClosedRef.current) return null;
      const startPage = Math.max(
        1,
        Math.min(RECEIPT_SCAN_MAX_PAGES, Math.trunc(nextPage)),
      );
      const controller = new AbortController();
      receiptScanAbortRef.current = controller;
      const loadSequence = receiptLoadSequenceRef.current + 1;
      receiptLoadSequenceRef.current = loadSequence;
      const loadOwnerId = user.uid;
      const loadAccountKey = receiptAccountKeyRef.current;
      const loadCacheRevision = getGmailReceiptCacheRevision(loadOwnerId);
      const loadOwnerToken = vaultOwnerToken;
      const loadVaultEpoch = snapshotVaultSessionEpoch();
      const isCurrentLoad = () => {
        const currentAccess = sealedReceiptAccessRef.current;
        return (
          gmailOwnerIdRef.current === loadOwnerId &&
          receiptAccountKeyRef.current === loadAccountKey &&
          getGmailReceiptCacheRevision(loadOwnerId) === loadCacheRevision &&
          currentAccess.isUnlocked &&
          currentAccess.ownerToken === loadOwnerToken &&
          receiptLoadSequenceRef.current === loadSequence &&
          !receiptReadsClosedRef.current &&
          !controller.signal.aborted &&
          isVaultSessionEpochCurrent(loadVaultEpoch)
        );
      };
      setLoadingReceipts(true);
      let requestedPage = startPage;
      // One scan pass reads pages 1..N under one signed continuation window.
      // `passItems` are the rows this pass has read; `previousItems` are rows
      // already on screen that it has not re-read yet. They stay visible
      // until the pass completes, then the pass result replaces them exactly.
      let passItems: ReceiptListItem[];
      let previousItems: ReceiptListItem[] | null;
      let scanStartedAt: number;
      if (startPage === 1) {
        receiptScanCursorsRef.current.clear();
        passItems = [];
        previousItems = receiptsRef.current.length ? receiptsRef.current : null;
        scanStartedAt = Date.now();
      } else {
        const cached = getCachedGmailReceipts(loadOwnerId, loadAccountKey);
        if (cached?.page === startPage - 1 && cached.next_cursor) {
          receiptScanCursorsRef.current.set(startPage, cached.next_cursor);
        }
        passItems = cached ? cached.items : receiptsRef.current;
        previousItems = cached?.previous_items?.length
          ? cached.previous_items
          : null;
        scanStartedAt = cached?.scan_started_at ?? Date.now();
      }
      let activeScanRetries = 0;
      let pageRetries = 0;
      receiptPersistenceFailedRef.current = false;
      try {
        // Capture before provider work. Reset cannot be followed by a stale write.
        let durableVersion: Awaited<ReturnType<typeof receiptStoreVersion>> | null = null;
        const persistenceFailure = (error: unknown, stage: "version" | "schema") => {
          const typed = durableResourceError(error, stage);
          console.error("[ProfileReceiptsPage] Receipt persistence failed", { code: typed.code, stage: typed.stage });
          if (!isCurrentLoad()) return;
          receiptPersistenceFailedRef.current = true;
          setReceiptSyncFeedback({ tone: "error", message: "Receipts are visible for this session, but couldn't be saved on this device. Sync again before reloading." });
        };
        try {
          if (!vaultKey || !loadAccountKey) throw new DurableResourceError("key_unavailable", "authority", "Unlock your vault to save receipts.");
          durableVersion = await withDeadline(receiptStoreVersion(loadOwnerId, loadAccountKey), operationDeadline);
        } catch (error) { persistenceFailure(error, "version"); }
        const scanOwnerGeneration = durableVersion?.generation ?? -1;
        const idToken = await withDeadline(user.getIdToken(), operationDeadline);
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
            response = await withDeadline(GmailReceiptsService.scanReceipts({
              idToken,
              vaultOwnerToken: loadOwnerToken,
              userId: loadOwnerId,
              page: requestedPage,
              cursor: receiptScanCursorsRef.current.get(requestedPage),
              perPage: 6,
              signal: controller.signal,
            }), operationDeadline);
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
              await withDeadline(waitForReceiptScanRetry(controller.signal), operationDeadline);
              continue;
            }
            // A transient page failure (a concurrent connection-row update, or
            // a model failure that outlasted the backend's own re-ask) is read
            // again with the same signed cursor, up to twice; every retried
            // page is validated in full again.
            if (
              isRetryableReceiptScanPageError(error) &&
              pageRetries < RECEIPT_SCAN_PAGE_RETRIES &&
              !controller.signal.aborted &&
              isCurrentLoad()
            ) {
              pageRetries += 1;
              await withDeadline(waitForReceiptScanRetry(controller.signal), operationDeadline);
              continue;
            }
            throw error;
          }
          pageRetries = 0;
          if (!isCurrentLoad()) return null;

          if (response.next_cursor) receiptScanCursorsRef.current.set(response.page + 1, response.next_cursor);

          passItems =
            requestedPage > 1
              ? mergeCachedReceiptItems({
                  existing: passItems,
                  incoming: response.items,
                  mode: "append",
                })
              : response.items;
          const nextLoadedPage = response.page;
          const nextHasMore = response.has_more;
          const shouldContinueScan =
            nextHasMore &&
            nextLoadedPage < response.coverage.max_pages;
          const displayItems = previousItems
            ? mergeCachedReceiptItems({
                existing: previousItems,
                incoming: passItems,
                mode: "prepend_refresh",
              })
            : passItems;
          const nextItems = shouldContinueScan ? displayItems : passItems;
          const nextTotal = nextItems.length;

          // Only Reset may discard good rows when a provider returns an empty pass.
          if (!shouldContinueScan && !nextItems.length &&
            (receiptsRef.current.length > 0 || savedReceiptSnapshotRef.current?.value.rows.length)) {
            persistenceFailure(new DurableResourceError("schema_invalid", "schema", "An empty scan cannot replace saved receipts."), "schema");
            return false;
          }

          // Keep a restored projection and its counts coherent until replacement is verified.
          // An empty scan must also keep currently visible live rows on failure.
          const deferReplacement = Boolean(savedReceiptSnapshotRef.current) || (!nextItems.length && receiptsRef.current.length > 0);
          if (displayItems.length || !deferReplacement) {
            const aliases = Object.fromEntries(await withDeadline(Promise.all(displayItems.map(async item => {
              const key = item.source_id || item.receipt_key || String(item.id);
              return [await receiptAccountBinding(`event:${key}`), key] as const;
            })), operationDeadline));
            if (!isCurrentLoad()) return null;
            setReceiptSourceAliases(previous => ({ ...previous, ...aliases }));
            receiptsRef.current = displayItems;
            setReceipts(displayItems);
          }
          if (!deferReplacement && shouldContinueScan) {
            setPage(nextLoadedPage);
            setHasMore(nextHasMore);
            setTotal(nextTotal);
            setReceiptScanReachedLimit(response.coverage?.reached_limit === true);
          }
          setReceiptListError(null);
          setReceiptListRetryPage(1);
          receiptConnectionLostRef.current = false;
          setReceiptConnectionLost(false);
          if (!deferReplacement) primeCachedGmailReceipts({
            userId: loadOwnerId,
            accountKey: loadAccountKey,
            response: {
              ...response,
              items: passItems,
              page: nextLoadedPage,
              total: passItems.length,
              has_more: nextHasMore,
            },
            scanStartedAt,
            previousItems,
          });

          // A failed/incomplete provider pass never replaces the prior verified snapshot.
          if (durableVersion && vaultKey && loadAccountKey && !shouldContinueScan) {
            try {
              const snapshot = await withDeadline(captureReceiptSnapshot(nextItems, loadAccountKey, {
                partial: shouldContinueScan || response.coverage.reached_limit,
                truncated: response.coverage.reached_limit, source_count: nextItems.length,
                window_from: null, window_to: null, source: "gmail_live",
              }), operationDeadline);
              const liveRows = buildRecentReceiptRows(nextItems, loadAccountKey);
              const aliases: Record<string, string> = {};
              for (const row of snapshot.rows) {
                const live = liveRows.find(item => item.id === row.display_id);
                row.events.forEach((event, index) => { const key = live?.eventTimeline[index]?.sourceReceiptKey; if (key) aliases[event.ref] = key; });
              }
              durableVersion = await withDeadline(writeReceiptSnapshot({ userId: loadOwnerId, vaultKey,
                vaultOwnerToken: loadOwnerToken, isCurrent: isCurrentLoad }, snapshot, durableVersion), operationDeadline);
              if (isCurrentLoad()) setReceiptSourceAliases(aliases);
            } catch (error) {
              durableVersion = null;
              persistenceFailure(error, "schema");
            }
          }

          if (!shouldContinueScan) {
            if (!isCurrentLoad()) return null;
            if (!durableVersion) return false;
            const committedRevision = durableVersion.revision;
            receiptsRef.current = nextItems;
            setReceipts(nextItems);
            setPage(nextLoadedPage);
            setHasMore(nextHasMore);
            setTotal(nextTotal);
            setReceiptScanReachedLimit(response.coverage?.reached_limit === true);
            primeCachedGmailReceipts({ userId: loadOwnerId, accountKey: loadAccountKey, response: { ...response, items: passItems, total: passItems.length }, scanStartedAt });
            setSavedReceiptSnapshot(null);
            setReceiptCompletion(previous => ({ scope: `${loadOwnerId}\u0000${String(loadAccountKey || "")}`, count: (previous?.count ?? 0) + 1, generation: scanOwnerGeneration, revision: committedRevision }));
            return true;
          }
          requestedPage = nextLoadedPage + 1;
        }
        return false;
      } catch (error) {
        if (controller.signal.aborted || isReceiptScanAbort(error)) return null;
        if (!isCurrentLoad()) return null;
        if (isReceiptConnectionLostError(error)) {
          receiptConnectionLostRef.current = true;
          setReceiptConnectionLost(true);
          setReceiptListError(null);
          // The stored status still says connected; read the real one so the
          // page moves to its reconnect state.
          void refreshGmailStatusRef.current?.({ force: true });
          return false;
        }
        if (isReceiptScanContinuationExpiredError(error)) {
          receiptScanCursorsRef.current.clear();
          setHasMore(false);
          const cached = getCachedGmailReceipts(loadOwnerId, loadAccountKey);
          if (cached) primeCachedGmailReceipts({
            userId: loadOwnerId,
            accountKey: loadAccountKey,
            response: { ...cached, has_more: false, next_cursor: null },
            previousItems: cached.previous_items,
          });
          setReceiptListRetryPage(1);
        } else {
          setReceiptListRetryPage(requestedPage);
        }
        setReceiptListError(
          sanitizeGmailUserMessage(error, {
            fallback:
              "We couldn't load your receipts right now. Please try again.",
          }),
        );
        return false;
      } finally {
        const ownsScanState = receiptScanAbortRef.current === controller;
        if (ownsScanState) {
          receiptScanAbortRef.current = null;
          receiptScanPromiseRef.current = null;
        }
        if (isCurrentLoad() && startPage === 1) {
          setReceiptListReady(true);
        }
        // Nothing restarts a stopped scan automatically any more, so the scan
        // that still owns the indicator always clears it.
        if (isCurrentLoad() || ownsScanState) {
          setLoadingReceipts(false);
          setReceiptScanProgress(null);
        }
        controller.abort();
      }
    },
    [isVaultUnlocked, user, vaultOwnerToken, vaultKey],
  );

  // A scan starts only from an explicit action (Start sync, Load older
  // receipts, Try again, or the setup view's first read). It keeps running
  // across Mail tabs, and a repeated action joins the running scan instead of
  // aborting it or starting another provider scan.
  const loadReceipts = useCallback(
    (nextPage: number): Promise<boolean | null> => {
      if (receiptScanAbortRef.current && receiptScanPromiseRef.current) {
        return receiptScanPromiseRef.current;
      }
      const scan = runReceiptScan(nextPage);
      if (receiptScanAbortRef.current) receiptScanPromiseRef.current = scan;
      return scan;
    },
    [runReceiptScan],
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
  const receiptDisplayScope = user?.uid
    ? `${user.uid}\u0000${String(receiptAccountKey || "")}`
    : null;
  const receiptSyncCompletion = receiptCompletion?.scope === receiptDisplayScope ? receiptCompletion?.count ?? 0 : 0;
  // Effects clear the previous account's state after paint. Gate every
  // receipt projection during the first render of a different owner/account.
  const receiptDisplayScopeCurrent =
    displayedReceiptScopeRef.current === receiptDisplayScope;
  const visibleReceipts = useMemo(() => receiptDisplayScopeCurrent ? receipts : [], [receiptDisplayScopeCurrent, receipts]);
  const visibleSavedRows = useMemo(() => {
    if (!savedReceiptSnapshot || savedReceiptSnapshot.scope !== receiptDisplayScope || !hasSealedReceiptAccess) return undefined;
    const savedRows = receiptSnapshotRows(savedReceiptSnapshot.value);
    const savedIds = new Set(savedRows.map(row => row.id));
    const savedSources = new Set(savedRows.flatMap(row => row.sourceReceiptKeys.map(key => receiptSourceAliases[key]).filter(Boolean)));
    const normalizedIdentifier = (value: string) => value.trim().toUpperCase().replace(/\s+/g, " ");
    // Preserve already-decided saved groups until the complete pass is verified.
    // Source hashes also catch a single event whose display group ID later changes.
    const freshRows = buildRecentReceiptRows(visibleReceipts, receiptAccountKey).filter(row =>
      !savedIds.has(row.id) && !row.sourceReceiptKeys.some(key => savedSources.has(key)) &&
      // Defer a possible new event for a saved transaction until the complete
      // pass can use the unchanged canonical grouping rules.
      (row.eventTimeline.some(event => event.eventKind === "refund" || event.eventKind === "cancellation") ||
        savedRows.filter(saved => saved.displayKind === "merchant" && row.displayKind === "merchant" &&
          (saved.brandKey ? saved.brandKey === row.brandKey : saved.merchantName === row.merchantName && saved.logoDomain === row.logoDomain) &&
          !saved.eventTimeline.some(event => event.eventKind === "refund" || event.eventKind === "cancellation") &&
          row.identifiers.some(identifier => ["order", "invoice", "receipt", "pnr"].includes(identifier.kind) &&
            saved.identifiers.some(other => other.kind === identifier.kind && normalizedIdentifier(other.value) === normalizedIdentifier(identifier.value))) &&
          !row.identifiers.some(identifier => saved.identifiers.some(other => other.kind === identifier.kind &&
            normalizedIdentifier(other.value) !== normalizedIdentifier(identifier.value))))
          .length !== 1));
    return [...freshRows, ...savedRows];
  }, [savedReceiptSnapshot, receiptDisplayScope, hasSealedReceiptAccess, visibleReceipts, receiptAccountKey, receiptSourceAliases]);
  const visibleTotal = receiptDisplayScopeCurrent ? total : 0;
  const visibleHasMore = receiptDisplayScopeCurrent && hasMore;
  const hasStoredReceipts = visibleReceipts.length > 0 || Boolean(visibleSavedRows?.length);

  useEffect(() => {
    if (displayedReceiptScopeRef.current === receiptDisplayScope) return;
    displayedReceiptScopeRef.current = receiptDisplayScope;
    receiptLoadSequenceRef.current += 1;
    receiptScanAbortRef.current?.abort();
    receiptScanAbortRef.current = null;
    receiptScanPromiseRef.current = null;
    receiptsRef.current = [];
    setReceipts([]);
    setSavedReceiptSnapshot(null);
    setReceiptSourceAliases({});
    setPage(1);
    setHasMore(false);
    setTotal(0);
    setReceiptScanReachedLimit(false);
    setLoadingReceipts(false);
    setReceiptScanInProgress(false);
    setReceiptScanProgress(null);
    setReceiptListReady(false);
    setReceiptListError(null);
    receiptConnectionLostRef.current = false;
    setReceiptConnectionLost(false);
    setReceiptSyncFeedback(null);
  }, [receiptDisplayScope]);

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
      // A scanned row already carries this owner/account's validated
      // extraction and its source passages, so opening it reuses that answer
      // instead of re-reading and re-classifying the message.
      const scanned = receiptsRef.current.find(
        (receipt) => String(receipt.source_id || "").trim() === sourceId,
      );
      if (scanned && Array.isArray(scanned.source_evidence)) {
        ensureCurrent();
        return {
          item: scanned,
          email_excerpt: null,
          source_evidence: scanned.source_evidence,
        };
      }
      const saved = savedReceiptSnapshotRef.current?.value.rows.find(r => r.events.some(e => e.ref === sourceId));
      const event = saved?.events.find(e => e.ref === sourceId);
      const locator = event?.locator;
      const savedDetail = () => ({ item: {
        id: 0, gmail_message_id: "", merchant_name: saved!.merchant, category: saved!.category,
        amount: saved!.amount === null ? null : Number(saved!.amount), currency: saved!.currency,
        status: saved!.status, recurrence: saved!.recurrence, identifiers: saved!.identifiers.map(i => ({ ...i })),
        transaction_date: saved!.transaction_date, document_kind: saved!.document_kind,
        classification_confidence: saved!.confidence, category_confidence: saved!.category ? 1 : null,
        merchant_domain: resolveSavedReceiptMerchantBrand(saved!.brand, saved!.merchant)?.logoDomain ?? null,
      } satisfies ReceiptListItem, source_evidence: [], email_excerpt: null,
      live_unavailable: "Saved receipt details are available. Reconnect Mail or sync again to load the original email and source evidence." });
      if (saved && (!locator || !gmail.presentation.isConnected || (typeof navigator !== "undefined" && navigator.onLine === false))) {
        ensureCurrent(); return savedDetail();
      }
      const idToken = await user.getIdToken();
      ensureCurrent();
      const detail = await GmailReceiptsService.getReceiptDetail({
        idToken,
        vaultOwnerToken: detailOwnerToken,
        userId: detailOwnerId,
        sourceId: locator ?? sourceId,
        signal,
      }).catch(error => { ensureCurrent(); if (saved && !signal?.aborted) return savedDetail(); throw error; });
      ensureCurrent();
      if ("live_unavailable" in detail) return detail;
      if (String(detail.item.source_id || "").trim() !== (locator ?? sourceId)) {
        throw new Error("Mail returned details for a different receipt.");
      }
      return detail;
    },
    [isVaultUnlocked, receiptAccountKey, user, vaultOwnerToken, gmail.presentation.isConnected],
  );

  const handleReceiptDetailLoaded = useCallback(
    (item: ReceiptListItem) => {
      const ownerId = user?.uid;
      const sourceId = String(item.source_id || "").trim();
      if (!ownerId || !sourceId) return;
      // A detail opened from the scanned row is that row; nothing to merge.
      if (receiptsRef.current.includes(item)) return;
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
      if (!savedReceiptSnapshotRef.current) upsertCachedGmailReceipt({
        userId: ownerId,
        accountKey: receiptAccountKey,
        item,
      });
    },
    [receiptAccountKey, user?.uid],
  );

  useEffect(() => {
    if (loading || !canLoad || !user?.uid) return;
    if (!hasSealedReceiptAccess) {
      receiptLoadSequenceRef.current += 1;
      receiptScanAbortRef.current?.abort();
      receiptScanAbortRef.current = null;
      receiptsRef.current = [];
      setReceipts([]);
      setSavedReceiptSnapshot(null);
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

    if (!receiptsWorkspaceActive) return;

    // A running user-started scan already publishes each page it reads.
    if (receiptScanAbortRef.current) return;

    // Opening, revisiting or remounting Receipts never starts a Gmail scan:
    // it shows this owner/account's last scanned rows from process memory.
    // A scan starts only from Start sync, Load older receipts or Try again.
    const cached = getCachedGmailReceipts(user.uid, receiptAccountKey);
    if (cached) {
      const cachedItems = cachedGmailReceiptDisplayItems(cached);
      receiptsRef.current = cachedItems;
      setReceipts(cachedItems);
      setPage(cached.page);
      setHasMore(cached.has_more);
      setTotal(cachedItems.length);
      setReceiptScanReachedLimit(cached.receipt_scan_reached_limit);
      setReceiptListReady(true);
      return;
    }

    // Setup has no Receipts tab to return to, so its first view still reads
    // the newly connected mailbox once.
    if (journeyVariant === "onboarding") {
      setReceiptListReady(false);
      void loadReceipts(1);
    }
  }, [
    canLoad,
    gmail.loadingStatus,
    gmail.presentation.isConnected,
    hasSealedReceiptAccess,
    journeyVariant,
    loadReceipts,
    loading,
    receiptAccountKey,
    receiptsWorkspaceActive,
    user?.uid,
  ]);

  useEffect(() => {
    if (!receiptsWorkspaceActive || gmail.loadingStatus || loading || !user?.uid || !vaultKey || !vaultOwnerToken || !hasSealedReceiptAccess || receiptScanAbortRef.current) return;
    if (gmail.presentation.isConnected && getCachedGmailReceipts(user.uid, receiptAccountKey)) return;
    let current = true;
    const scope = receiptDisplayScope;
    void loadReceiptSnapshot({ userId: user.uid, vaultKey, vaultOwnerToken,
      isCurrent: () => current && displayedReceiptScopeRef.current === scope }, receiptAccountKey)
      .then(saved => {
        if (!current || receiptScanAbortRef.current || displayedReceiptScopeRef.current !== scope || !saved) return;
        setSavedReceiptSnapshot({ scope, value: saved.value });
        setReceiptListReady(true);
        setTotal(saved.value.coverage.source_count);
      }).catch(() => { /* Absence/storage failure never triggers an inbox read. */ });
    return () => { current = false; };
  }, [receiptsWorkspaceActive, gmail.loadingStatus, gmail.presentation.isConnected, loading, user?.uid, vaultKey, vaultOwnerToken, hasSealedReceiptAccess, receiptAccountKey, receiptDisplayScope]);

  useEffect(() => subscribeDurableOwnerReset(owner => {
    if (owner !== user?.uid) return;
    receiptScanAbortRef.current?.abort();
    receiptsRef.current = []; savedReceiptSnapshotRef.current = null;
    clearCachedGmailReceipts(owner);
    setReceipts([]); setSavedReceiptSnapshot(null); setReceiptSourceAliases({}); setTotal(0); setHasMore(false);
    setReceiptCompletion(null); receiptMemorySavedCompletionRef.current = 0;
    void import("@/lib/pkm/markdown-memory").then(memory => memory.clearMarkdownMemory(owner));
  }), [user?.uid]);

  const isConnected = gmail.presentation.isConnected;
  useEffect(() => {
    if (isConnected) receiptReadsClosedRef.current = false;
  }, [isConnected, user?.uid]);
  const loadingStatus = gmail.loadingStatus;
  const receiptStorageReadOnly =
    gmail.status?.receipt_storage_mode === "legacy_read_only";
  const receiptSyncAvailable = Boolean(isConnected && hasSealedReceiptAccess);
  const oauthCompletionPending = gmail.oauthCompletionPending;
  // Known rows are never covered: the skeleton appears only while a scan is
  // actually reading with nothing to show yet (or setup's first read).
  const showReceiptPlaceholders =
    isConnected &&
    hasSealedReceiptAccess &&
    !loadingStatus &&
    !hasStoredReceipts &&
    (loadingReceipts ||
      (!receiptListReady && journeyVariant === "onboarding"));
  const connectorState = gmail.presentation.state;
  const latestSyncText = gmail.presentation.latestSyncText;
  const latestSyncBadge = gmail.presentation.latestSyncBadge;
  const isPassiveBackfillState =
    connectorState === "connected_backfill_running";

  const refreshGmailStatus = gmail.refreshStatus;
  refreshGmailStatusRef.current = gmail.refreshStatus;

  // A new connection (a different connected_at) replaces the rejected one.
  useEffect(() => {
    if (!receiptConnectionLost) {
      receiptConnectionLostAtRef.current = null;
      return;
    }
    const connectedAt = String(gmail.status?.connected_at ?? "");
    if (receiptConnectionLostAtRef.current === null) {
      receiptConnectionLostAtRef.current = connectedAt;
      return;
    }
    if (isConnected && connectedAt !== receiptConnectionLostAtRef.current) {
      receiptConnectionLostRef.current = false;
      setReceiptConnectionLost(false);
    }
  }, [gmail.status?.connected_at, isConnected, receiptConnectionLost]);

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
  const handleConnectGmail = useCallback((purpose: "read" | "send" = "send"): Promise<boolean> => {
    const operationDeadline = Date.now() + GMAIL_OAUTH_POPUP_TIMEOUT_MS;
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
              ? await withDeadline(PreVaultUserStateService.bootstrapState(user.uid, {
                  force: true,
                }).catch(() => null), operationDeadline)
              : null;
          const fromSetup = Boolean(
            journeyVariant === "onboarding" &&
            journey &&
            !PreVaultUserStateService.isSetupResolved(journey) &&
            journey.onboardingActiveCapability === "gmail",
          );
          const idToken = await withDeadline(user.getIdToken(), operationDeadline);
          const nativeStart = await withDeadline(GmailReceiptsService.startNativeConnect({
            idToken,
            userId: user.uid,
            purpose,
          }), operationDeadline);
          if (!nativeStart.configured || !nativeStart.server_client_id) {
            throw new Error(
              "Mail OAuth is not configured for this environment.",
            );
          }

          let serverAuthCode: string;
          try {
            ({ serverAuthCode } = await withDeadline(HushhAuth.connectGmail({
              serverClientId: nativeStart.server_client_id,
              purpose: nativeStart.purpose,
              preserveModify: preserveGmailModify,
            }), operationDeadline));
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

          await withDeadline(GmailReceiptsService.completeNativeConnect({
            idToken,
            userId: user.uid,
            serverAuthCode,
            purpose,
          }), operationDeadline);
          await withDeadline(refreshGmailStatus({ force: true }), operationDeadline);

          if (fromSetup && journey) {
            await withDeadline(PreVaultUserStateService.syncOnboardingJourney({
              userId: user.uid,
              phase: "capability_setup",
              activeCapability: "gmail",
              callbackState: "succeeded",
              expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            }).catch(() => undefined), operationDeadline);
          }

          toast.success("Mail connected. You can read and send after reviewing each email.");
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
            ? await withDeadline(PreVaultUserStateService.bootstrapState(user.uid, {
                force: true,
              }).catch(() => null), operationDeadline)
            : null;
        const fromSetup = Boolean(
          journeyVariant === "onboarding" &&
          journey &&
          !PreVaultUserStateService.isSetupResolved(journey) &&
          journey.onboardingActiveCapability === "gmail",
        );
        const idToken = await withDeadline(user.getIdToken(), operationDeadline);
        const isGoogleProvider =
          user.providerData?.some(
            (provider) => provider.providerId === "google.com",
          ) ?? false;

        const payload = await withDeadline(GmailReceiptsService.startConnect({
          idToken,
          userId: user.uid,
          loginHint: isGoogleProvider ? user.email : null,
          includeGrantedScopes: purpose === "send" || isGoogleProvider,
          purpose,
        }), operationDeadline);

        if (!payload.configured || !payload.authorize_url) {
          throw new Error(
            "Mail OAuth is not configured for this environment.",
          );
        }

        if (fromSetup) {
          const intent = createOnboardingConnectorIntent("gmail");
          await withDeadline(PreVaultUserStateService.syncOnboardingJourney({
            userId: user.uid,
            phase: "external_connector",
            activeCapability: "gmail",
            callbackState: "pending",
            callbackAttemptId: intent.correlationId,
            expectedJourneyUpdatedAt: journey?.onboardingJourneyUpdatedAt,
          }), operationDeadline);
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
    const operationDeadline = Date.now() + 120_000;
    if (!user?.uid) return;
    // Revoke local read admission before starting disconnect, not after an
    // old read has had a chance to repopulate the cleared collection.
    receiptLoadSequenceRef.current += 1;
    receiptScanAbortRef.current?.abort();
    receiptScanAbortRef.current = null;
    receiptReadsClosedRef.current = true;
    setLoadingReceipts(false);
    setReceiptScanInProgress(false);
    setReceiptScanProgress(null);
    const owner = user.uid;
    const vaultEpoch = snapshotVaultSessionEpoch();
    const isCurrentOwner = () => gmailOwnerIdRef.current === owner && isVaultSessionEpochCurrent(vaultEpoch);

    try {
      setGmailActionBusy("disconnect");
      const savedReceiptsRemain = Boolean(receiptAccountKey && (await withDeadline(receiptStoreVersion(user.uid, receiptAccountKey).catch(() => null), operationDeadline))?.revision);
      await morphyToast
        .promise(
          (async () => {
            const next = await withDeadline(gmail.disconnectGmail(), operationDeadline);
            if (!next || next.connected) {
              throw new Error("Mail could not be disconnected.");
            }
            return next;
          })(),
          {
            loading: "Disconnecting Mail...",
            success: savedReceiptsRemain ? "Mail disconnected. Saved receipts remain available; reconnect to open their original emails." : "Mail disconnected and Mail receipt data was deleted.",
            error: (error) =>
              sanitizeGmailUserMessage(error, {
                fallback:
                  "We couldn't disconnect Mail right now. Please try again in a moment.",
              }),
            variant: "destructive",
          },
        )
        .unwrap();
      if (!isCurrentOwner()) return;
      receiptLoadSequenceRef.current += 1;
      receiptsRef.current = [];
      setReceipts([]);
      setPage(1);
      setHasMore(false);
      setTotal(0);
      setReceiptScanReachedLimit(false);
      setShowDisconnectConfirm(false);
    } catch {
      if (!isCurrentOwner()) return;
      receiptReadsClosedRef.current = false;
      console.warn("MAIL_DISCONNECT_FAILED");
    } finally {
      if (isCurrentOwner()) setGmailActionBusy(null);
    }
  }, [gmail, user?.uid, receiptAccountKey]);

  const handleSyncNow = useCallback(async () => {
    if (!user?.uid || !receiptSyncAvailable || receiptReadsClosedRef.current) return;
    // The ref closes the double-click window before React re-renders.
    if (!isConnected || receiptScanInProgress || loadingReceipts || receiptScanAbortRef.current) return;
    const owner = user.uid;
    const accountKey = receiptAccountKeyRef.current;
    const ownerToken = vaultOwnerToken;
    const vaultEpoch = snapshotVaultSessionEpoch();
    const sequence = receiptLoadSequenceRef.current + 1;
    const isCurrent = () => gmailOwnerIdRef.current === owner && receiptAccountKeyRef.current === accountKey &&
      sealedReceiptAccessRef.current.ownerToken === ownerToken && sealedReceiptAccessRef.current.isUnlocked &&
      receiptLoadSequenceRef.current === sequence && !receiptReadsClosedRef.current && isVaultSessionEpochCurrent(vaultEpoch);
    try {
      // The ref closes the double-click window before React re-renders.
      if (
        !isConnected ||
        receiptScanInProgress ||
        loadingReceipts ||
        receiptScanAbortRef.current
      ) {
        return;
      }
      if (!receiptSyncAvailable) {
        return;
      }
      if (receiptConnectionLostRef.current) {
        // Syncing cannot work until Mail is reconnected, so start that.
        setReceiptSyncFeedback({
          message: "Reconnect Mail to continue syncing your receipts.",
          tone: "error",
        });
        void handleConnectGmail();
        return;
      }
      setReceiptScanInProgress(true);
      setReceiptSyncFeedback({
        message: "Looking through your recent purchases…",
        tone: "neutral",
      });
      // An interrupted pass continues from its signed cursor instead of
      // re-reading the pages it already finished; otherwise a new pass starts.
      const cached = getCachedGmailReceipts(user.uid, receiptAccountKey);
      const loaded = await loadReceipts(
        isCachedGmailReceiptScanResumable(cached) &&
          cached.page < RECEIPT_SCAN_MAX_PAGES
          ? cached.page + 1
          : 1,
      );
      if (loaded === null || !isCurrent()) return;
      if (!loaded && receiptConnectionLostRef.current) {
        setReceiptSyncFeedback({ message: "Reconnect Mail to continue syncing your receipts.", tone: "error" });
        return;
      }
      if (!loaded) {
        if (receiptPersistenceFailedRef.current) return;
        // The scan already retained its sanitized error and retry cursor.
        // An unsuccessful result is not a second, synthetic exception.
        setReceiptSyncFeedback({
          message: "Couldn’t finish scanning your receipts.",
          tone: "error",
        });
        return;
      }
      setReceiptSyncFeedback(previous => previous?.tone === "error" ? previous : {
        message: "Receipts updated.",
        tone: "success",
      });
      if (!receiptPersistenceFailedRef.current) toast.success("Receipts updated");
    } catch {
      if (!isCurrent()) return;
      console.warn("MAIL_RECEIPT_SCAN_FAILED");
      const message = "Couldn’t finish scanning your receipts.";
      setReceiptSyncFeedback({ message, tone: "error" });
    } finally {
      if (isCurrent()) setReceiptScanInProgress(false);
    }
  }, [
    handleConnectGmail,
    isConnected,
    loadReceipts,
    loadingReceipts,
    receiptAccountKey,
    receiptScanInProgress,
    receiptSyncAvailable,
    user?.uid,
    vaultOwnerToken,
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
  // A disconnected account cannot expose the old receipt count while the
  // local projection is being cleared.
  const shouldShowReceiptCount = isConnected && receiptDisplayScopeCurrent;
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
      ...(visibleHasMore
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
        receipt_count: visibleTotal,
        has_more_receipts: visibleHasMore,
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
    visibleHasMore,
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
    visibleTotal,
    journeyVariant,
    onFinishSetup,
    onSkipSetup,
    workspace,
  ]);

  const requestVaultUnlock = useCallback(() => {
    setShowVaultUnlock(true);
    toast.info("Set up or open your private vault to view synced receipts.");
  }, []);

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
    <MailConnectionStatus
      statusSummary={statusSummary}
      primaryActionLabel={primaryActionLabel}
      onConnect={() => void handleConnectGmail()}
      loadingStatus={loadingStatus}
      oauthCompletionPending={oauthCompletionPending}
      isConnected={isConnected}
      busy={gmailActionBusy !== null}
      receiptCount={shouldShowReceiptCount ? visibleTotal : undefined}
      receiptSyncInProgress={receiptSyncInProgress}
      isPassiveBackfillState={isPassiveBackfillState}
      hasStaleBackgroundSync={hasStaleBackgroundSync}
      onRetry={
        gmail.statusError
          ? () => void refreshGmailStatus({ force: true, reconcile: false })
          : undefined
      }
      connectActionId={journeyVariant === "onboarding" ? "setup.connect_gmail" : undefined}
    />
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

      {(receiptsWorkspaceActive && isConnected) || (receiptsWorkspaceActive && Boolean(visibleSavedRows?.length)) ? (
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

          {isConnected && hasSealedReceiptAccess && receiptConnectionLost ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm">
              <p className="text-muted-foreground">
                Mail needs to be reconnected before it can sync your receipts.
              </p>
              <Button
                variant="none"
                effect="fade"
                onClick={() => void handleConnectGmail()}
              >
                Reconnect Mail
              </Button>
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          receiptListError &&
          !hasStoredReceipts &&
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
          !hasStoredReceipts &&
          !visibleHasMore &&
          !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {!receiptListReady
                ? "Start sync to find receipts in your Mail."
                : receiptScanReachedLimit
                ? `No receipts were found within the ${RECEIPT_SCAN_MAX_PAGES} Mail pages checked.`
                : gmail.syncRun?.synced_count
                  ? "Your receipts are still finishing up. Please try again in a moment."
                  : "No receipts are available for this account yet."}
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          receiptListError &&
          hasStoredReceipts &&
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

          {hasSealedReceiptAccess && (visibleReceipts.length > 0 || Boolean(visibleSavedRows?.length)) ? (
            <GmailRecentReceipts
              accountKey={
                gmail.status?.google_sub || gmail.status?.google_email || null
              }
              loadReceiptDetail={loadReceiptDetail}
              onReceiptDetailLoaded={handleReceiptDetailLoaded}
              receipts={visibleReceipts}
              savedRows={visibleSavedRows}
              sourceKeyAliases={receiptSourceAliases}
            />
          ) : null}

          {isConnected && hasSealedReceiptAccess && visibleHasMore ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="none"
                effect="fade"
                onClick={() => void handleLoadMore()}
                disabled={loadingReceipts}
                data-voice-control-id="load_older_receipts"
                data-voice-label={
                  visibleReceipts.length > 0
                    ? "Load older receipts"
                    : "Check older Mail"
                }
                data-voice-purpose="checks the next bounded Mail receipt page."
              >
                {visibleReceipts.length > 0
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
      width="reading"
      headerContentSpacing="compact"
      className={`${mailStyles.typography} ${journeyVariant === "workspace" ? mailStyles.workspace : ""} pb-[calc(var(--app-bottom-fixed-ui,96px)+1.5rem)]`}
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
              : visibleReceipts.length > 0
                ? "loaded"
                : "empty-valid",
        errorCode: receiptListError ? "gmail_receipts_load_failed" : null,
        errorMessage: receiptListError,
      }}
    >
      <AppPageHeaderRegion
        className={
          undefined
        }
      >
        <PageHeader
          title="Mail"
          titleVisuallyHidden={journeyVariant === "workspace"}
          titleRole={journeyVariant === "workspace" ? "agent" : "page"}
          description={pageTitle}
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
          undefined
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
                        receiptCount={
                          receiptListReady && receiptDisplayScopeCurrent
                            ? visibleTotal
                            : undefined
                        }
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
                    {!isConnected ? mailStatusPanel : null}

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
                            accountKey={receiptAccountKey ?? undefined}
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
        <AlertDialogContent className={`${mailStyles.typography} ${mailStyles.portal} w-[calc(100%-1rem)] sm:max-w-md`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Mail?</AlertDialogTitle>
            <AlertDialogDescription>
              Stops Mail access and receipt sync, and deletes Mail receipts and
              summaries from Hussh. Information saved to private memory stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel disabled={gmailActionBusy === "disconnect"}>
              Keep connected
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={`${roleSolid("danger").fill} ${roleSolid("danger").fg} hover:bg-[color:var(--app-destructive)] hover:opacity-90`}
              disabled={gmailActionBusy === "disconnect"}
              onClick={(event) => {
                event.preventDefault();
                void handleDisconnectGmail();
              }}
            >
              {gmailActionBusy === "disconnect" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* No control: a finished sync saves itself to private memory, so Chat
          with One can answer from it. */}
      {isConnected && hasSealedReceiptAccess ? (
        <GmailReceiptMemorySave
          accountKey={
            gmail.status?.google_sub || gmail.status?.google_email || null
          }
          receipts={visibleReceipts}
          partialScan={visibleHasMore || receiptScanReachedLimit}
          syncCompletion={receiptSyncCompletion}
          savedCompletionRef={receiptMemorySavedCompletionRef}
          ownerGeneration={receiptCompletion?.generation}
          snapshotRevision={receiptCompletion?.revision}
          autoSave={journeyVariant !== "onboarding"}
        />
      ) : null}
    </AppPageShell>
  );
}
