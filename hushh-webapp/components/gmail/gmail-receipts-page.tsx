"use client";

import { ownerContentIsPrivate } from '@/lib/services/private-agent-specialist-chat';
import { connectGoogleConnector, connectRefusalMessage } from '@/lib/one/google-native-connect';
import { requestGoogleConnectorPhoneHandoff } from '@/lib/one/google-connector-intent';
import { useGoogleConnectorTransitionReview } from '@/components/connections/google-connector-transition-review';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { usePathname } from "next/navigation";
import { Loader2, Lock, RefreshCw } from "@/components/icons";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import GmailInformationRequestsSection from "@/components/gmail/gmail-information-requests-section";
import { ReceiptHistory } from "@/components/gmail/receipt-history";
import { ReceiptSyncToolbar } from "@/components/gmail/receipt-sync-toolbar";
import { GmailRecentReceipts } from "@/components/gmail/gmail-recent-receipts";
import { GmailReceiptMemorySave } from "@/components/gmail/gmail-receipt-memory-save";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { MailReceiptResourceService } from "@/lib/services/mail-receipt-resource-service";
import { receiptSnapshotRows, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { resolveSavedReceiptMerchantBrand } from "@/lib/mail/receipt-merchant-registry";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import { loadReceiptSnapshot, receiptStoreVersion } from "@/lib/mail/receipt-store";
import { GmailVerificationOnboarding } from "@/components/gmail/gmail-verification-onboarding";
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
  clearCachedGmailReceipts,
  getCachedGmailReceipts,
  isCachedGmailReceiptScanResumable,
  mergeCachedReceiptItems,
  upsertCachedGmailReceipt,
} from "@/lib/profile/gmail-receipts-cache";
import {
  getGmailWorkspaceSession,
  setGmailWorkspaceSession,
} from "@/lib/profile/gmail-workspace-session";
import {
  GmailReceiptsService,
  isReceiptConnectionLostError,
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
  const { user, loading, userId } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { confirmTransition, transitionDialog } = useGoogleConnectorTransitionReview(userId ?? undefined, snapshotVaultSessionEpoch());
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
  const [receiptRestoreFailed, setReceiptRestoreFailed] = useState(false);
  const [receiptRestorePending, setReceiptRestorePending] = useState(false);
  const receiptListRetryPage = 1;
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
  const [_receiptScanProgress, setReceiptScanProgress] = useState<{
    page: number;
    maxPages: number;
    waitingForActiveScan: boolean;
  } | null>(null);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const [_receiptSyncFeedback, setReceiptSyncFeedback] = useState<{
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
  const receiptEvidenceRef = useRef<ReceiptListItem[]>([]);
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
  const receiptAccountKeyRef = useRef<string | null>(null);
  const displayedReceiptScopeRef = useRef<string | null>(null);
  const settledGmailPopupAttemptRef = useRef<string | null>(null);
  const gmailPopupRef = useRef<Window | null>(null);
  const gmailOwnerIdRef = useRef<string | null>(userId);
  const sealedReceiptAccessRef = useRef({
    isUnlocked: isVaultUnlocked,
    ownerToken: vaultOwnerToken,
    key: vaultKey,
  });
  useLayoutEffect(() => {
    const owner = userId;
    const previousAccess = sealedReceiptAccessRef.current;
    if (gmailOwnerIdRef.current !== owner || previousAccess.ownerToken !== vaultOwnerToken || previousAccess.isUnlocked !== isVaultUnlocked) {
      receiptLoadSequenceRef.current += 1;
      receiptScanAbortRef.current?.abort();
      receiptScanAbortRef.current = null;
      receiptScanPromiseRef.current = null;
      if (gmailOwnerIdRef.current !== owner) receiptReadsClosedRef.current = false;
    }
    if (!isVaultUnlocked || gmailOwnerIdRef.current !== owner || previousAccess.key !== vaultKey) {
      if (gmailOwnerIdRef.current) MailReceiptResourceService.clear(gmailOwnerIdRef.current);
      receiptsRef.current = []; receiptEvidenceRef.current = []; savedReceiptSnapshotRef.current = null;
      setReceipts([]); setSavedReceiptSnapshot(null); setReceiptSourceAliases({});
      setReceiptRestoreFailed(false); setReceiptRestorePending(false);
      setReceiptCompletion(null); setTotal(0); setReceiptListReady(false);
    }
    gmailOwnerIdRef.current = owner;
    sealedReceiptAccessRef.current = { isUnlocked: isVaultUnlocked, ownerToken: vaultOwnerToken, key: vaultKey };
    if (owner) MailReceiptResourceService.retireObsolete(owner);
  }, [userId, vaultOwnerToken, isVaultUnlocked, vaultKey]);
  useEffect(() => {
    setLoadingReceipts(false);
    setReceiptScanInProgress(false);
    setReceiptScanProgress(null);
  }, [userId, vaultOwnerToken, isVaultUnlocked, vaultKey]);
  useEffect(() => { setGmailActionBusy(null); }, [userId]);
  const resolvedInitialWorkspace =
    journeyVariant === "onboarding"
      ? "receipts"
      : (forceWorkspace ??
        getGmailWorkspaceSession(userId, pathname, initialWorkspace));
  const [workspace, setWorkspaceState] = useState<GmailWorkspace>(
    resolvedInitialWorkspace,
  );
  const [kycVisitedOwner, setKycVisitedOwner] = useState<string | null>(
    resolvedInitialWorkspace === "kyc" ? userId : null,
  );
  useEffect(() => {
    if (workspace === "kyc" && userId) setKycVisitedOwner(userId);
  }, [workspace, userId]);

  const setWorkspace = useCallback(
    (nextWorkspace: GmailWorkspace) => {
      setWorkspaceState(nextWorkspace);
      if (journeyVariant !== "onboarding") {
        setGmailWorkspaceSession(userId, pathname, nextWorkspace);
      }
    },
    [journeyVariant, pathname, userId],
  );

  useEffect(() => {
    setWorkspaceState(
      journeyVariant === "onboarding"
        ? "receipts"
        : forceWorkspace ??
          getGmailWorkspaceSession(userId, pathname, initialWorkspace),
    );
  }, [forceWorkspace, initialWorkspace, journeyVariant, pathname, userId]);
  // This is intentionally memory-only. A KYC summary can be
  // sensitive, so workspace navigation must not write unfinished text to
  // browser storage just to preserve it.
  const [verificationIntake, setVerificationIntake] = useState<{
    ownerId: string | null; vaultKey: string | null; deferred: boolean; draft: string;
  } | null>(null);
  const verificationIntakeCurrent = verificationIntake?.ownerId === userId &&
    verificationIntake?.vaultKey === vaultKey;
  const verificationDeferred = verificationIntakeCurrent ? verificationIntake?.deferred ?? false : false;
  const verificationDraft = verificationIntakeCurrent ? verificationIntake?.draft ?? "" : "";
  const setVerificationDeferred = (deferred: boolean) => setVerificationIntake({
    ownerId: userId, vaultKey, deferred, draft: verificationDraft,
  });
  const setVerificationDraft = (draft: string) => setVerificationIntake({
    ownerId: userId, vaultKey, deferred: verificationDeferred, draft,
  });
  const receiptsWorkspaceActive =
    journeyVariant === "onboarding" || workspace === "receipts";

  useEffect(() => {
    receiptsRef.current = receipts;
  }, [receipts]);

  const hasSealedReceiptAccess = Boolean(vaultOwnerToken && isVaultUnlocked);
  const receiptSyncAllowedRef = useRef(true);

  const runReceiptScan = useCallback(async (_nextPage: number): Promise<boolean | null> => {
    const owner = userId; const account = receiptAccountKeyRef.current;
    if (!user || !owner || !account || !vaultKey || !vaultOwnerToken || !isVaultUnlocked || receiptReadsClosedRef.current || !receiptSyncAllowedRef.current) return null;
    const controller = new AbortController(); receiptScanAbortRef.current = controller;
    const sequence = ++receiptLoadSequenceRef.current;
    const isCurrent = () => !controller.signal.aborted && gmailOwnerIdRef.current === owner &&
      receiptAccountKeyRef.current === account && receiptLoadSequenceRef.current === sequence &&
      sealedReceiptAccessRef.current.isUnlocked && !receiptReadsClosedRef.current;
    setLoadingReceipts(true); receiptPersistenceFailedRef.current = false;
    try {
      const result = await MailReceiptResourceService.refresh({ userId: owner, vaultKey, vaultOwnerToken,
        isCurrent: () => gmailOwnerIdRef.current === owner && receiptAccountKeyRef.current === account &&
          sealedReceiptAccessRef.current.key === vaultKey && sealedReceiptAccessRef.current.ownerToken === vaultOwnerToken &&
          sealedReceiptAccessRef.current.isUnlocked && !receiptReadsClosedRef.current && receiptSyncAllowedRef.current }, account,
        () => user.getIdToken(), { onPage: (_items, page) => {
          if (isCurrent()) {
            receiptsRef.current = _items; receiptEvidenceRef.current = _items;
            setReceiptSourceAliases(previous => ({ ...previous, ...Object.fromEntries(_items.flatMap(item => item.event_id && item.source_id ? [[item.event_id, item.source_id]] : [])) }));
            setReceiptScanProgress({ page, maxPages: RECEIPT_SCAN_MAX_PAGES, waitingForActiveScan: false });
          }
        } });
      if (!isCurrent()) return null;
      setReceipts([]);
      setSavedReceiptSnapshot({ scope: `${owner}\u0000${account}`, value: result.snapshot });
      setReceiptListReady(true); setReceiptListError(null); setHasMore(false);
      setTotal(result.snapshot.coverage.source_count); setReceiptScanReachedLimit(!result.complete);
      if (result.complete) setReceiptCompletion(previous => ({ scope: `${owner}\u0000${account}`, count: (previous?.count ?? 0) + 1,
        generation: result.generation, revision: result.revision }));
      return result.complete;
    } catch (error) {
      if (!isCurrent()) return null;
      if ((error as { code?: string }).code === "GMAIL_RECEIPT_ACCOUNT_CHANGED") {
        void refreshGmailStatusRef.current?.({ force: true });
      }
      if (isReceiptConnectionLostError(error)) {
        receiptConnectionLostRef.current = true; setReceiptConnectionLost(true);
        void refreshGmailStatusRef.current?.({ force: true });
      }
      setReceiptListError("Mail couldn’t update. Your saved receipts are safe.");
      return false;
    } finally {
      if (receiptScanAbortRef.current === controller) {
        receiptScanAbortRef.current = null; receiptScanPromiseRef.current = null;
        setLoadingReceipts(false); setReceiptScanProgress(null);
      }
    }
  }, [isVaultUnlocked, user, userId, vaultOwnerToken, vaultKey]);

  // Connected Mail starts automatically; saved collections catch up when stale.
  // A shared scan keeps running
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
    userId,
    enabled: Boolean(userId) && !loading,
    idTokenProvider: user?.getIdToken ? idTokenProvider : null,
    routeHref:
      journeyVariant === "onboarding" ? ROUTES.ONE_SETUP_GMAIL : ROUTES.GMAIL,
    refreshKey: userId || "",
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  receiptSyncAllowedRef.current = gmail.status?.receipt_sync_available !== false;
  receiptAccountKeyRef.current = receiptAccountKey;
  useEffect(() => {
    if (userId) MailReceiptResourceService.retireObsolete(userId);
  }, [userId, gmail.status?.receipt_sync_available]);
  const historySession = useMemo(() => userId && vaultKey && vaultOwnerToken && isVaultUnlocked ? {
    userId, vaultKey, vaultOwnerToken,
    isCurrent: () => gmailOwnerIdRef.current === userId && sealedReceiptAccessRef.current.isUnlocked &&
      sealedReceiptAccessRef.current.key === vaultKey && sealedReceiptAccessRef.current.ownerToken === vaultOwnerToken,
  } : null, [userId, vaultKey, vaultOwnerToken, isVaultUnlocked]);
  const receiptDisplayScope = userId
    ? `${userId}\u0000${String(receiptAccountKey || "")}`
    : null;
  const receiptResource = useSyncExternalStore(MailReceiptResourceService.subscribe,
    () => MailReceiptResourceService.peek(userId ?? "", receiptAccountKey ?? ""),
    () => MailReceiptResourceService.peek("", ""));
  const currentSavedSnapshot = hasSealedReceiptAccess && sealedReceiptAccessRef.current.key === vaultKey ? receiptResource.snapshot ?? (savedReceiptSnapshot?.scope === receiptDisplayScope
    ? savedReceiptSnapshot.value : null) : null;
  const hasVerifiedReceiptSnapshot = Boolean(currentSavedSnapshot && hasSealedReceiptAccess);
  const receiptSyncCompletion = receiptCompletion?.scope === receiptDisplayScope ? receiptCompletion?.count ?? 0 : 0;
  // Effects clear the previous account's state after paint. Gate every
  // receipt projection during the first render of a different owner/account.
  const receiptDisplayScopeCurrent =
    displayedReceiptScopeRef.current === receiptDisplayScope;
  const visibleReceipts = useMemo(() => receiptDisplayScopeCurrent ? receipts : [], [receiptDisplayScopeCurrent, receipts]);
  const visibleSavedRows = useMemo(() => {
    if (!currentSavedSnapshot || !hasSealedReceiptAccess) return undefined;
    const savedRows = receiptSnapshotRows(currentSavedSnapshot);
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
  }, [currentSavedSnapshot, hasSealedReceiptAccess, visibleReceipts, receiptAccountKey, receiptSourceAliases]);
  const visibleTotal = currentSavedSnapshot?.coverage.source_count ?? (receiptDisplayScopeCurrent ? total : 0);
  const visibleHasMore = receiptDisplayScopeCurrent && hasMore;
  const hasStoredReceipts = visibleReceipts.length > 0 || Boolean(visibleSavedRows?.length);

  useEffect(() => {
    if (displayedReceiptScopeRef.current === receiptDisplayScope) return;
    displayedReceiptScopeRef.current = receiptDisplayScope;
    setReceiptRestoreFailed(false); setReceiptRestorePending(false);
    receiptLoadSequenceRef.current += 1;
    receiptScanAbortRef.current?.abort();
    receiptScanAbortRef.current = null;
    receiptScanPromiseRef.current = null;
    receiptsRef.current = []; receiptEvidenceRef.current = [];
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
      if (!user || !userId || !vaultOwnerToken || !isVaultUnlocked) {
        throw new Error("Open your private vault to view this receipt.");
      }
      const detailOwnerId = userId;
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
      const scanned = receiptEvidenceRef.current.find(
        (receipt) => (String(receipt.source_id || "").trim() === sourceId || receipt.event_id === sourceId),
      );
      if (scanned && Array.isArray(scanned.source_evidence)) {
        ensureCurrent();
        return {
          item: scanned,
          email_excerpt: null,
          source_evidence: scanned.source_evidence,
        };
      }
      const detailSnapshot = receiptAccountKey ? MailReceiptResourceService.peek(detailOwnerId, receiptAccountKey).snapshot ?? savedReceiptSnapshotRef.current?.value : savedReceiptSnapshotRef.current?.value;
      const saved = detailSnapshot?.rows.find(r => r.events.some(e => e.ref === sourceId));
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
      if (saved && (detailSnapshot?.sync?.unavailable.includes(sourceId) || !locator || !gmail.presentation.isConnected || (typeof navigator !== "undefined" && navigator.onLine === false))) {
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
    [isVaultUnlocked, receiptAccountKey, user, userId, vaultOwnerToken, gmail.presentation.isConnected],
  );

  const handleReceiptDetailLoaded = useCallback(
    (item: ReceiptListItem) => {
      const ownerId = userId;
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
    [receiptAccountKey, userId],
  );

  useEffect(() => {
    if (loading || !userId || !vaultKey || !vaultOwnerToken || !hasSealedReceiptAccess || !receiptsWorkspaceActive) return;
    const owner = userId;
    let active = true;
    const restore = async () => {
      if (!receiptAccountKey) {
        if (!gmail.loadingStatus && (!gmail.presentation.isConnected || gmail.status?.receipt_sync_available === false)) {
          const saved = await loadReceiptSnapshot({ userId: owner, vaultKey, vaultOwnerToken,
            isCurrent: () => active }, null);
          if (active && saved) { setSavedReceiptSnapshot({ scope: receiptDisplayScope, value: saved.value }); setReceiptListReady(true); }
        }
        return;
      }
      const saved = await MailReceiptResourceService.hydrate({ userId: owner, vaultKey, vaultOwnerToken }, receiptAccountKey);
      if (!active) return;
      setReceiptListReady(true); setReceiptRestoreFailed(false);
      if (saved) { setSavedReceiptSnapshot({ scope: receiptDisplayScope, value: saved }); setTotal(saved.coverage.source_count); }
      // A connected, unlocked Mail account updates automatically after a successful
      // local restore. Failed hydration stays unknown and never starts a scan.
      if (gmail.presentation.isConnected && gmail.status?.receipt_sync_available !== false && !receiptScanAbortRef.current &&
          MailReceiptResourceService.isStale(owner, receiptAccountKey))
        void loadReceipts(1);
    };
    void restore().catch(() => { if (active) { setReceiptRestoreFailed(true); setReceiptListError("Saved receipts couldn’t be opened. Try again."); } });
    const wake = () => {
      if (document.visibilityState === "hidden" || navigator.onLine === false || !receiptAccountKey || !gmail.presentation.isConnected || gmail.status?.receipt_sync_available === false) return;
      if (MailReceiptResourceService.isStale(owner, receiptAccountKey)) void restore().catch(() => {});
    };
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(wake);
    window.addEventListener("online", wake); document.addEventListener("visibilitychange", wake);
    return () => { active = false; unsubscribeLifecycle(); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); };
  }, [loading, userId, vaultKey, vaultOwnerToken, hasSealedReceiptAccess, receiptsWorkspaceActive,
    receiptAccountKey, receiptDisplayScope, gmail.loadingStatus, gmail.presentation.isConnected, gmail.status?.receipt_sync_available, journeyVariant, loadReceipts]);

  const retryReceiptRestore = useCallback(async () => {
    if (!historySession || !receiptAccountKey) return;
    const sequence = receiptLoadSequenceRef.current;
    const current = () => historySession.isCurrent() && receiptLoadSequenceRef.current === sequence;
    setReceiptRestorePending(true);
    let restored = false;
    try {
      const saved = await MailReceiptResourceService.hydrate({ ...historySession, isCurrent: current }, receiptAccountKey);
      if (!current()) return;
      setSavedReceiptSnapshot(saved ? { scope: receiptDisplayScope, value: saved } : null);
      setReceiptListReady(true); setReceiptRestoreFailed(false); setReceiptListError(null); restored = true;
    } catch {
      if (current()) { setReceiptRestoreFailed(true); setReceiptListError("Saved receipts couldn’t be opened. Try again."); }
    } finally { if (current()) setReceiptRestorePending(false); }
    if (current() && restored && receiptSyncAllowedRef.current) void loadReceipts(1);
  }, [historySession, receiptAccountKey, receiptDisplayScope, loadReceipts]);

  useEffect(() => subscribeDurableOwnerReset(owner => {
    if (owner !== userId) return;
    receiptScanAbortRef.current?.abort();
    receiptsRef.current = []; receiptEvidenceRef.current = []; savedReceiptSnapshotRef.current = null;
    clearCachedGmailReceipts(owner);
    setReceipts([]); setSavedReceiptSnapshot(null); setReceiptSourceAliases({}); setTotal(0); setHasMore(false);
    setReceiptCompletion(null); setReceiptListReady(true); receiptMemorySavedCompletionRef.current = 0;
    void import("@/lib/pkm/markdown-memory").then(memory => memory.clearMarkdownMemory(owner));
  }), [userId]);

  const isConnected = gmail.presentation.isConnected;
  useEffect(() => {
    if (isConnected) receiptReadsClosedRef.current = false;
  }, [isConnected, userId]);
  const loadingStatus = gmail.loadingStatus;
  const receiptStorageReadOnly =
    gmail.status?.receipt_storage_mode === "legacy_read_only";
  const receiptSyncAvailable = Boolean(isConnected && hasSealedReceiptAccess && receiptAccountKey && gmail.status?.receipt_sync_available !== false);
  const oauthCompletionPending = gmail.oauthCompletionPending;
  // Known rows are never covered: the skeleton appears only while a scan is
  // actually reading with nothing to show yet (or setup's first read).
  const showReceiptPlaceholders =
    !hasVerifiedReceiptSnapshot &&
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
    if (!gmailPopupAttempt || !user?.uid || !userId) return;
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
      const journey = await PreVaultUserStateService.bootstrapState(userId, {
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
          userId,
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
          }, userId);
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
              userId,
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
                userId,
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
  }, [gmailPopupAttempt, journeyVariant, refreshGmailStatus, user?.uid, userId]);

  useEffect(() => {
    onConnectionStateChange?.(isConnected);
  }, [isConnected, onConnectionStateChange]);

  const preserveGmailModify = gmail.status?.modify_permission_granted === true;
  const handleConnectGmail = useCallback((purpose: "read" | "send" = "send"): Promise<boolean> => {
    const operationDeadline = Date.now() + GMAIL_OAUTH_POPUP_TIMEOUT_MS;
    if (!user || !userId || gmailActionBusy !== null) return Promise.resolve(false);
    const operationOwner = userId;
    const privateConnect = async (): Promise<boolean | null> => {
      const privateAgent = await ownerContentIsPrivate();
      if (gmailOwnerIdRef.current !== operationOwner) return false;
      if (!privateAgent) return null;
      if (!vaultKey || !vaultOwnerToken || !isVaultUnlocked) { toast.error('Unlock your vault to connect Google.'); return false; }
      const outcome = await connectGoogleConnector('gmail', {
        vaultOwnerCapability: vaultOwnerToken,
        confirmLegacyTransition: confirmTransition,
        isCurrent: () => gmailOwnerIdRef.current === operationOwner,
      });
      if (gmailOwnerIdRef.current !== operationOwner) return false;
      if (!outcome.ok) {
        if (outcome.code === 'PHONE_HANDOFF_REQUIRED') requestGoogleConnectorPhoneHandoff('gmail');
        else toast.error(connectRefusalMessage(outcome.code, 'Gmail'));
        return false;
      }
      const current = await refreshGmailStatus({ force: true });
      if (gmailOwnerIdRef.current !== operationOwner) return false;
      if (current?.connected) toast.success('Gmail connected to your private agent.');
      return current?.connected === true;
    };


    if (Capacitor.isNativePlatform()) {
      setGmailActionBusy("connect");
      return (async () => {
        try {
          const privateOutcome = await privateConnect();
          if (privateOutcome !== null) return privateOutcome;
          // The normal Gmail workspace has no setup state to persist. Do not
          // leave its trusted popup on a placeholder while an unrelated
          // onboarding read waits on the database.
          const journey =
            journeyVariant === "onboarding"
              ? await withDeadline(PreVaultUserStateService.bootstrapState(userId, {
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
            userId,
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
            GmailReceiptsService.recordConsentFailure(error, userId);
            throw error;
          }
          if (!serverAuthCode?.trim()) {
            const error = new Error(
              "Google did not return a Mail authorization code.",
            );
            GmailReceiptsService.recordConsentFailure(error, userId);
            throw error;
          }

          await withDeadline(GmailReceiptsService.completeNativeConnect({
            idToken,
            userId,
            serverAuthCode,
            purpose,
          }), operationDeadline);
          await withDeadline(refreshGmailStatus({ force: true }), operationDeadline);

          if (fromSetup && journey) {
            await withDeadline(PreVaultUserStateService.syncOnboardingJourney({
              userId,
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

    const attempt = createGmailOAuthPopupAttempt(userId, purpose);
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
        if (await ownerContentIsPrivate()) {
          popup?.close();
          gmailPopupRef.current = null; setGmailPopupAttempt(null);
          clearGmailOAuthPopupAttempt();
          try { return (await privateConnect()) ?? false; } finally { setGmailActionBusy(null); }
        }
        if (gmailOwnerIdRef.current !== operationOwner) { popup?.close(); setGmailActionBusy(null); return false; }
        const journey =
          journeyVariant === "onboarding"
            ? await withDeadline(PreVaultUserStateService.bootstrapState(userId, {
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
          userId,
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
            userId,
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
  }, [confirmTransition, gmailActionBusy, journeyVariant, preserveGmailModify, refreshGmailStatus, user, userId, vaultKey, vaultOwnerToken, isVaultUnlocked]);

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
    if (!userId) return;
    // Revoke local read admission before starting disconnect, not after an
    // old read has had a chance to repopulate the cleared collection.
    receiptLoadSequenceRef.current += 1;
    receiptScanAbortRef.current?.abort();
    receiptScanAbortRef.current = null;
    receiptReadsClosedRef.current = true;
    setLoadingReceipts(false);
    setReceiptScanInProgress(false);
    setReceiptScanProgress(null);
    const owner = userId;
    const vaultEpoch = snapshotVaultSessionEpoch();
    const isCurrentOwner = () => gmailOwnerIdRef.current === owner && isVaultSessionEpochCurrent(vaultEpoch);

    try {
      setGmailActionBusy("disconnect");
      const savedReceiptsRemain = Boolean(receiptAccountKey && (await withDeadline(receiptStoreVersion(userId, receiptAccountKey).catch(() => null), operationDeadline))?.revision);
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
      clearCachedGmailReceipts(userId);
      receiptsRef.current = []; receiptEvidenceRef.current = [];
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
  }, [gmail, userId, receiptAccountKey]);

  const handleSyncNow = useCallback(async () => {
    if (!userId || !receiptSyncAvailable || receiptReadsClosedRef.current) return;
    // The ref closes the double-click window before React re-renders.
    if (!isConnected || receiptScanInProgress || loadingReceipts || receiptScanAbortRef.current) return;
    const owner = userId;
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
      const cached = getCachedGmailReceipts(userId, receiptAccountKey);
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
    userId,
    vaultOwnerToken,
  ]);

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
            ? receiptSyncAvailable ? "Receipts update automatically when you return." : "Open receipts to view saved history and update availability."
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
            ...(receiptSyncAvailable && (journeyVariant === "onboarding" || Boolean(receiptResource.error && !receiptConnectionLost))
              ? [
                  {
                    id: "sync_gmail_receipts",
                    label: journeyVariant === "onboarding" ? "Sync receipts" : "Try again",
                    purpose: "retries an interrupted Mail receipt update.",
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
            "Shows saved receipts, current availability and any active Mail receipt check.",
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
    receiptResource.error,
    receiptConnectionLost,
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
      {isConnected && hasSealedReceiptAccess ? (
        <ReceiptSyncToolbar key={`${userId}:${snapshotVaultSessionEpoch()}`} snapshot={currentSavedSnapshot} refreshing={loadingReceipts || receiptResource.refreshing}
          progress={receiptResource.progress} restoring={receiptRestorePending} migration={receiptStorageReadOnly} active={receiptsWorkspaceActive}
          error={receiptResource.error ?? receiptListError} disabled={!receiptSyncAvailable}
          onRestore={receiptRestoreFailed && receiptAccountKey ? () => void retryReceiptRestore() : undefined}
          onRefresh={receiptSyncAvailable && receiptResource.error && !receiptConnectionLost ? () => void handleSyncNow() : undefined} />
      ) : null}

      {(receiptsWorkspaceActive && isConnected) || (receiptsWorkspaceActive && Boolean(visibleSavedRows?.length)) ? (
        <section
          aria-labelledby="recent-receipts-title"
          className="space-y-3"
          data-testid="recent-receipts"
        >
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
          !receiptRestoreFailed &&
          !receiptConnectionLost &&
          !hasVerifiedReceiptSnapshot &&
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

          {isConnected && hasSealedReceiptAccess && !loadingReceipts && !showReceiptPlaceholders &&
          !receiptListError && !hasStoredReceipts && receiptResource.hydrated && !loadingStatus ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {hasVerifiedReceiptSnapshot ? "No receipts were found in the Mail checked." : "No current-account receipts are saved on this device yet."}
            </SurfaceInset>
          ) : null}

          {isConnected &&
          hasSealedReceiptAccess &&
          receiptListError &&
          !receiptRestoreFailed &&
          !hasVerifiedReceiptSnapshot &&
          !receiptConnectionLost &&
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

          {hasSealedReceiptAccess && (hasVerifiedReceiptSnapshot || visibleReceipts.length > 0 || Boolean(visibleSavedRows?.length)) ? (
            <GmailRecentReceipts
              headingId="recent-receipts-title"
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
      {historySession ? <ReceiptHistory session={historySession} getIdToken={idTokenProvider}
        allowRead={gmail.status?.receipt_history_available === true} active={receiptsWorkspaceActive && !gmail.loadingStatus} /> : null}
    </div>
  );

  return (
    <AppPageShell
      as="div"
      width="reading"
      headerContentSpacing="compact"
      className={`${mailStyles.typography} ${journeyVariant === "workspace" ? mailStyles.workspace : mailStyles.fullPageTitle} pb-[calc(var(--app-bottom-fixed-ui,96px)+1.5rem)]`}
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
      {transitionDialog}
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
            isConnected && (journeyVariant === "onboarding" || workspace === "receipts") ? (
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Button
                  onClick={() => void handleSyncNow()}
                  disabled={
                    receiptSyncInProgress ||
                    !receiptSyncAvailable ||
                    gmailActionBusy !== null
                  }
                  className={`${mailStyles.wideAction} w-full sm:w-auto sm:min-w-[150px]`}
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
                    ((userId !== null && kycVisitedOwner === userId) || workspace === "kyc") ? (
                      <div
                        key={`${userId ?? "guest"}:${Boolean(vaultKey && vaultOwnerToken)}`}
                      >
                        <GmailVerificationOnboarding
                          userId={userId}
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
                            userId={userId}
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
                    (userId === null || kycVisitedOwner !== userId) &&
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
