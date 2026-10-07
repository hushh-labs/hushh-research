import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const receiptScan = vi.fn();
  return {
    routerPush: vi.fn(),
    navigateToAgentChat: vi.fn(),
    useAuth: vi.fn(),
    useGmailConnectorStatus: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
      info: vi.fn(),
      promise: vi.fn(
        (promise: Promise<unknown> | (() => Promise<unknown>)) => ({
          unwrap: () => (typeof promise === "function" ? promise() : promise),
        }),
      ),
    },
    gmailReceiptsService: {
      // Keep the compatibility name bound to the same mock while older
      // assertions in this broad page suite migrate to the live scan name.
      listReceipts: receiptScan,
      scanReceipts: receiptScan,
      getReceiptDetail: vi.fn(),
      listNudges: vi.fn(),
      startConnect: vi.fn(),
      startNativeConnect: vi.fn(),
      completeNativeConnect: vi.fn(),
      recordConsentFailure: vi.fn(),
      syncNow: vi.fn(),
    },
    hushhAuth: {
      connectGmail: vi.fn(),
    },
    preVaultUserStateService: {
      bootstrapState: vi.fn(),
      syncOnboardingJourney: vi.fn(),
      isSetupResolved: vi.fn(),
    },
    gmailOAuthPopup: {
      attempt: {
        version: 1 as const,
        attemptId: "gmail-popup-test",
        startedAt: 1,
        ownerId: "user-123",
      },
      popup: {
        closed: false,
        close: vi.fn(),
        sessionStorage: {
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
      },
      create: vi.fn(),
      open: vi.fn(),
      navigate: vi.fn(),
      persist: vi.fn(() => true),
      clear: vi.fn(),
      consumeStoredSettlement: vi.fn(() => null),
    },
    assignWindowLocation: vi.fn(),
    capacitor: {
      isNativePlatform: vi.fn(),
    },
    pkmDomainResourceService: {
      prepareDomainWriteContext: vi.fn(),
    },
    pkmWriteCoordinator: {
      savePreparedDomain: vi.fn(),
    },
    personalKnowledgeModelService: {
      validatePreparedDomainStore: vi.fn(),
    },
    receiptMemoryPkm: {
      buildShoppingReceiptMemoryPreparedDomain: vi.fn(),
      hasMatchingReceiptMemoryProvenance: vi.fn(),
    },
    useVault: vi.fn(),
  };
});

let gmailView: ReturnType<typeof buildGmailView>;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
  usePathname: () => "/one/profile/receipts",
}));

vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: mocks.navigateToAgentChat,
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: mocks.useGmailConnectorStatus,
}));

vi.mock("@/lib/services/gmail-receipts-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/gmail-receipts-service")>();
  return {
    GmailReceiptsService: mocks.gmailReceiptsService,
    GmailReceiptRequestError: actual.GmailReceiptRequestError,
    isRetryableReceiptScanPageError: actual.isRetryableReceiptScanPageError,
    isReceiptScanInProgressError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "GMAIL_RECEIPT_SCAN_IN_PROGRESS",
      ),
  };
});

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: mocks.preVaultUserStateService,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhAuth: mocks.hushhAuth,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({
    children,
    nativeTest,
  }: {
    children: React.ReactNode;
    nativeTest?: {
      dataState?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    };
  }) => (
    <div
      data-native-data-state={nativeTest?.dataState}
      data-native-error-code={nativeTest?.errorCode || undefined}
      data-native-error-message={nativeTest?.errorMessage || undefined}
    >
      {children}
    </div>
  ),
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({
    eyebrow,
    title,
    description,
    actions,
  }: {
    eyebrow?: React.ReactNode;
    title?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      <div>{eyebrow}</div>
      <div>{title}</div>
      <div>{description}</div>
      <div>{actions}</div>
    </div>
  ),
  SectionHeader: ({
    id,
    testId,
    title,
  }: {
    id?: string;
    testId?: string;
    title?: React.ReactNode;
  }) => (
    <div id={id} data-testid={testId} role="heading" aria-level={2}>
      {title}
    </div>
  ),
}));

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceInset: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SurfaceStack: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/gmail/gmail-verification-onboarding", () => ({
  GmailVerificationOnboarding: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/gmail/gmail-information-requests-section", () => ({
  default: () => <div>KYC requests</div>,
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: ({
    value,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { value?: number }) => (
    <div
      role="progressbar"
      data-value={value}
      className={className}
      {...props}
    />
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  Loader2: () => <span />,
  Lock: () => <span />,
  Mail: () => <span />,
  MessageCircle: () => <span />,
  PenLine: () => <span />,
  RefreshCw: () => <span />,
  Search: () => <span />,
  RotateCcw: () => <span />,
  Send: () => <span />,
  ShieldCheck: () => <span />,
  ShoppingBag: () => <span />,
  Trash2: () => <span />,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: {
    PROFILE: "/one/profile",
    PROFILE_GMAIL: "/one/profile/gmail",
    GMAIL: "/one/gmail",
    ONE_SETUP: "/one/setup",
    PROFILE_RECEIPTS: "/one/profile/receipts",
    PROFILE_GMAIL_OAUTH_RETURN: "/one/profile/gmail/oauth/return",
  },
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  assignWindowLocation: mocks.assignWindowLocation,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: mocks.capacitor.isNativePlatform,
    getPlatform: vi.fn(() => "web"),
  },
  CapacitorHttp: { request: vi.fn() },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/profile/gmail-oauth-popup", () => ({
  createGmailOAuthPopupAttempt: () => {
    mocks.gmailOAuthPopup.create();
    return mocks.gmailOAuthPopup.attempt;
  },
  openGmailOAuthPopup: (...args: unknown[]) => {
    mocks.gmailOAuthPopup.open(...args);
    return mocks.gmailOAuthPopup.popup;
  },
  navigateGmailOAuthPopup: (...args: unknown[]) =>
    mocks.gmailOAuthPopup.navigate(...args),
  persistGmailOAuthPopupAttempt: (...args: unknown[]) =>
    mocks.gmailOAuthPopup.persist(...args),
  getGmailOAuthPopupSessionStorage: (target?: Window | null) => {
    try {
      return target?.sessionStorage ?? null;
    } catch {
      return null;
    }
  },
  clearGmailOAuthPopupAttempt: (...args: unknown[]) =>
    mocks.gmailOAuthPopup.clear(...args),
  consumeStoredGmailOAuthPopupSettlement: (...args: unknown[]) =>
    mocks.gmailOAuthPopup.consumeStoredSettlement(...args),
  isGmailOAuthPopupSettlement: () => false,
  readGmailOAuthPopupSettlementFallback: () => null,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mocks.useVault,
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: mocks.pkmDomainResourceService,
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: mocks.pkmWriteCoordinator,
}));

vi.mock("@/lib/services/gmail-receipt-memory-service", () => ({
  GmailReceiptMemoryService: {
    buildArtifact: vi.fn(),
    preview: vi.fn().mockResolvedValue({
      artifact_id: "artifact-1",
      user_id: "user-123",
      source_kind: "gmail_receipts",
      artifact_version: 1,
      status: "ready",
      inference_window_days: 365,
      highlights_window_days: 90,
      source_watermark_hash: "watermark-1",
      source_watermark: {
        eligible_receipt_count: 1,
        latest_receipt_updated_at: "2026-04-01T00:00:00Z",
        latest_receipt_id: 1,
        latest_receipt_date: "2026-04-01T00:00:00Z",
        deterministic_config_version: "receipt_memory_v1",
        inference_window_days: 365,
        highlights_window_days: 90,
      },
      deterministic_schema_version: 1,
      enrichment_schema_version: null,
      enrichment_cache_key: "deterministic-only",
      deterministic_projection_hash: "projection-1",
      enrichment_hash: null,
      candidate_pkm_payload_hash: "candidate-1",
      deterministic_projection: {
        schema_version: 1,
        source: {
          kind: "gmail_receipts",
          inference_window_days: 365,
          highlights_window_days: 90,
          generated_at: "2026-04-01T00:00:00Z",
          canonicalization_version: "receipt_memory_v1",
          heuristic_version: "receipt_memory_v1",
          source_watermark: {
            eligible_receipt_count: 1,
            latest_receipt_updated_at: "2026-04-01T00:00:00Z",
            latest_receipt_id: 1,
            latest_receipt_date: "2026-04-01T00:00:00Z",
            deterministic_config_version: "receipt_memory_v1",
            inference_window_days: 365,
            highlights_window_days: 90,
          },
          source_watermark_hash: "watermark-1",
          projection_hash: "projection-1",
        },
        observed_facts: {
          merchant_affinity: [],
          purchase_patterns: [],
          recent_highlights: [],
        },
        inferred_preferences: [],
        budget_stats: {
          merchant_count: 0,
          pattern_count: 0,
          highlight_count: 0,
          signal_count: 0,
          eligible_receipt_count: 1,
        },
      },
      enrichment: null,
      candidate_pkm_payload: {
        receipts_memory: {
          schema_version: 1,
          readable_summary: {
            text: "Kai sees recent shopping activity.",
            highlights: [],
            updated_at: "2026-04-01T00:00:00Z",
            source_label: "Gmail receipts",
          },
          observed_facts: {
            merchant_affinity: [],
            purchase_patterns: [],
            recent_highlights: [],
          },
          inferred_preferences: {
            preference_signals: [],
          },
          provenance: {
            source_kind: "gmail_receipts",
            artifact_id: "artifact-1",
            deterministic_projection_hash: "projection-1",
            enrichment_hash: null,
            inference_window_days: 365,
            highlights_window_days: 90,
            receipt_count_used: 1,
            latest_receipt_updated_at: "2026-04-01T00:00:00Z",
            imported_at: "2026-04-01T00:00:00Z",
          },
        },
      },
      debug_stats: {
        eligible_receipt_count: 1,
        filtered_receipt_count: 1,
        llm_input_token_budget_estimate: 10,
        enrichment_mode: "deterministic_fallback",
      },
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
      freshness: {
        status: "fresh",
        is_stale: false,
        stale_after_days: 7,
        reason: "watermark_current",
      },
      persisted_pkm_data_version: null,
      persisted_at: null,
    }),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: mocks.personalKnowledgeModelService,
}));

vi.mock("@/lib/profile/gmail-receipt-memory-pkm", () => ({
  buildShoppingReceiptMemoryPreparedDomain:
    mocks.receiptMemoryPkm.buildShoppingReceiptMemoryPreparedDomain,
  hasMatchingReceiptMemoryProvenance:
    mocks.receiptMemoryPkm.hasMatchingReceiptMemoryProvenance,
}));

import ProfileReceiptsPage from "@/components/gmail/gmail-receipts-page";
import {
  clearCachedGmailReceipts,
  getCachedGmailReceipts,
  primeCachedGmailReceipts,
} from "@/lib/profile/gmail-receipts-cache";
import {
  GmailReceiptRequestError,
  GmailReceiptsService,
} from "@/lib/services/gmail-receipts-service";
import { GmailReceiptMemoryService } from "@/lib/services/gmail-receipt-memory-service";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

function makeReceipt(id: number, merchant: string) {
  const timestamp = `2026-04-0${id}T00:00:00Z`;
  const senderDomain =
    merchant === "Amazon"
      ? "amazon.com"
      : merchant === "Apple"
        ? "apple.com"
        : "myntra.com";
  return {
    id,
    source_id: `gmail_live_Z21haWwt${id}.signature`,
    receipt_key: `gmail_live_Z21haWwt${id}.signature`,
    source_kind: "gmail_live" as const,
    gmail_message_id: `gmail-${id}`,
    gmail_thread_id: `thread-${id}`,
    merchant_name: merchant,
    merchant_domain: senderDomain,
    sender_domain: senderDomain,
    from_name: merchant,
    from_email: `orders@${senderDomain}`,
    subject: `${merchant} order`,
    snippet: `${merchant} receipt preview`,
    preview: `${merchant} receipt preview`,
    amount: 19.99,
    currency: "USD",
    classification_confidence: 0.98,
    classification_source: "agent" as const,
    event_type: "purchase" as const,
    receipt_date: timestamp,
    gmail_internal_date: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function makeLiveCoverage(
  page: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    source: "gmail_live" as const,
    listed_count: 0,
    candidate_count: 0,
    matched_count: 0,
    pages_scanned: page,
    max_messages: 6,
    max_pages: 10,
    reached_limit: false,
    query_scope: "receipt_signals_all_mail_except_spam_trash" as const,
    rejection_counts: {
      missing_receipt_signal: 0,
      extractor_not_receipt: 0,
    },
    evidence_counts: {
      gmail_category: 0,
      subject_signal: 0,
      body_signal: 0,
      verified_merchant: 0,
      order_candidate: 0,
      total_candidate: 0,
    },
    ...overrides,
  };
}

function makeGmailView(overrides?: Partial<ReturnType<typeof buildGmailView>>) {
  return {
    ...buildGmailView(),
    ...overrides,
  };
}

function buildGmailView() {
  return {
    status: {
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "gmail.readonly",
      last_sync_status: "completed",
      auto_sync_enabled: true,
      revoked: false,
      latest_run: null,
      google_email: "akshat@example.com",
      receipt_sync_available: true,
    },
    syncRun: null,
    presentation: {
      state: "connected",
      badgeLabel: "Connected",
      description: "Connected as akshat@example.com.",
      latestSyncText: "Last sync completed.",
      latestSyncBadge: null,
      isConnected: true,
    },
    loadingStatus: false,
    refreshingStatus: false,
    syncingRun: false,
    statusError: null,
    refreshStatus: vi.fn(),
    disconnectGmail: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({
      accepted: true,
      run: {
        run_id: "run-1",
        user_id: "user-123",
        trigger_source: "manual",
        status: "running",
        listed_count: 0,
        filtered_count: 0,
        synced_count: 0,
        extracted_count: 0,
        duplicates_dropped: 0,
        extraction_success_rate: 0,
      },
    }),
    seedStatus: vi.fn(),
  };
}

// Receipts never scan on open; every list read starts from Start sync.
async function startReceiptSync() {
  fireEvent.click(await screen.findByRole("button", { name: "Start sync" }));
}

describe("ProfileReceiptsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedGmailReceipts("user-123");
    mocks.gmailOAuthPopup.popup.closed = false;
    mocks.gmailOAuthPopup.popup.close.mockReset();
    mocks.gmailOAuthPopup.popup.sessionStorage.setItem.mockReset();
    mocks.gmailOAuthPopup.popup.sessionStorage.removeItem.mockReset();
    mocks.gmailOAuthPopup.consumeStoredSettlement.mockReturnValue(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
      window.localStorage.clear();
      window.localStorage.setItem(
        "hushh.gmail.receipts.onboarding.v1:user-123",
        "complete",
      );
    }
    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-123",
        email: "akshat@example.com",
        providerData: [{ providerId: "google.com" }],
        getIdToken: vi.fn().mockResolvedValue("token-abc"),
      },
      loading: false,
    });
    mocks.useVault.mockReturnValue({
      vaultKey: "vault-key-123",
      vaultOwnerToken: "vault-owner-token-123",
      isVaultUnlocked: true,
    });
    mocks.pkmDomainResourceService.prepareDomainWriteContext.mockResolvedValue({
      domainData: {},
    });
    mocks.pkmWriteCoordinator.savePreparedDomain.mockResolvedValue({
      success: true,
      conflict: false,
      saveState: "saved",
    });
    mocks.personalKnowledgeModelService.validatePreparedDomainStore.mockResolvedValue(
      {
        success: true,
      },
    );
    mocks.receiptMemoryPkm.hasMatchingReceiptMemoryProvenance.mockReturnValue(
      false,
    );
    gmailView = buildGmailView();
    mocks.useGmailConnectorStatus.mockReturnValue(gmailView);
    mocks.capacitor.isNativePlatform.mockReturnValue(false);
    mocks.preVaultUserStateService.bootstrapState.mockResolvedValue(null);
    mocks.preVaultUserStateService.syncOnboardingJourney.mockResolvedValue(
      undefined,
    );
    mocks.preVaultUserStateService.isSetupResolved.mockImplementation(
      (state: { setupCompleted?: boolean } | null) =>
        state?.setupCompleted === true,
    );

    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [],
      page: 1,
      per_page: 20,
      total: 0,
      has_more: false,
    });
    vi.mocked(GmailReceiptsService.listNudges).mockResolvedValue({
      nudges: [],
    });
    vi.mocked(GmailReceiptsService.startConnect).mockResolvedValue({
      configured: true,
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      state: "state-123",
      redirect_uri: "http://localhost:3000/one/profile/gmail/oauth/return",
      expires_at: "2026-04-01T00:00:00Z",
    });
    vi.mocked(GmailReceiptsService.startNativeConnect).mockResolvedValue({
      configured: true,
      server_client_id: "native-client-id",
      purpose: "read",
    });
    vi.mocked(GmailReceiptsService.completeNativeConnect).mockResolvedValue(
      buildGmailView().status,
    );
    mocks.hushhAuth.connectGmail.mockResolvedValue({
      serverAuthCode: "native-auth-code",
    });
  });

  it("starts supported sync without replacing the receipts landing view", async () => {
    window.localStorage.setItem(
      "hushh.gmail.receipts.onboarding.v1:user-123",
      "complete",
    );
    const rendered = render(
      <ProfileReceiptsPage initialWorkspace="receipts" />,
    );

    const button = await screen.findByRole("button", {
      name: "Start sync",
    });
    expect(button.disabled).toBe(false);

    expect(GmailReceiptsService.scanReceipts).not.toHaveBeenCalled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(1);
    });

    expect(mocks.toast.success).toHaveBeenCalledWith("Receipts updated");
    expect(screen.getByText("Receipts updated.")).toBeVisible();
    expect(screen.getByTestId("receipt-sync-hero")).toBeVisible();
    expect(screen.getByTestId("recent-receipts")).toBeVisible();
    expect(
      await screen.findByText(/No receipts are available for this account/i),
    ).toBeVisible();
    expect(screen.queryByText(/Shopping summary/i)).toBeNull();
    expect(screen.queryByText(/Latest scan/i)).toBeNull();

    rendered.unmount();
    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    expect(await screen.findByTestId("receipt-sync-hero")).toBeVisible();
  });

  it("does not claim progress when a supported sync request is rejected", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockRejectedValueOnce(
        new Error("Receipt sync is not available while storage is read-only."),
      );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start sync" }),
    );

    expect(
      await screen.findByText(
        "Couldn’t finish scanning your receipts.",
      ),
    ).toBeVisible();
    expect(screen.getByTestId("receipt-sync-hero")).toBeVisible();
    expect(screen.queryByText(/Receipts updated/i)).toBeNull();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("reports a concurrent backend scan without fake success", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockRejectedValueOnce(new Error("Receipt sync is already in progress."));

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start sync" }),
    );

    expect(
      await screen.findByText("Couldn’t finish scanning your receipts."),
    ).toBeVisible();
  });

  it("waits briefly for a genuine active receipt scan and retries in place", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockRejectedValueOnce(
        Object.assign(
          new Error("A receipt scan is already running for this account."),
          { code: "GMAIL_RECEIPT_SCAN_IN_PROGRESS", status: 409 },
        ),
      )
      .mockResolvedValueOnce({
        items: [makeReceipt(2, "Amazon")],
        page: 1,
        per_page: 6,
        total: 1,
        has_more: false,
      });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await screen.findByText("Start sync to find receipts in your Mail.");
    fireEvent.click(screen.getByRole("button", { name: "Start sync" }));

    expect(
      await screen.findByText("Looking through your recent purchases…"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Scanning" })).toBeDisabled();
    expect(screen.getByTestId("receipt-sync-hero")).not.toHaveTextContent(/page \d|\d of \d/);
    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(2);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("keeps known rows visible while one manual sync refreshes them in place", async () => {
    primeCachedGmailReceipts({
      userId: "user-123",
      accountKey: "akshat@example.com",
      response: {
        items: [makeReceipt(1, "Myntra")],
        page: 1,
        per_page: 6,
        total: 1,
        has_more: false,
      },
    });
    let resolveScan: ((value: unknown) => void) | null = null;
    vi.mocked(GmailReceiptsService.scanReceipts).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScan = resolve;
      }) as never,
    );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);
    const start = screen.getByRole("button", { name: "Start sync" });
    // Two activations before React re-renders still start one provider scan.
    act(() => {
      start.click();
      start.click();
    });

    expect(await screen.findByRole("button", { name: "Scanning" })).toBeDisabled();
    expect(screen.getAllByText("Myntra").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Loading receipts")).toBeNull();
    expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(1);

    resolveScan?.({
      items: [makeReceipt(2, "Amazon")],
      page: 1,
      per_page: 6,
      total: 1,
      has_more: false,
    });
    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    // A completed pass replaces the list exactly with what it read.
    await waitFor(() => expect(screen.queryByText("Myntra")).toBeNull());
    expect(screen.getByTestId("receipt-sync-hero")).toBeVisible();
    expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(1);
  });

  it("re-reads a page once after the Gmail connection row changes mid-scan", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockResolvedValueOnce({
        items: [makeReceipt(1, "Myntra")],
        page: 1,
        per_page: 6,
        total: 1,
        has_more: true,
        coverage: makeLiveCoverage(1),
      })
      .mockRejectedValueOnce(
        new GmailReceiptRequestError(
          "The Gmail connection changed. Retry the receipt request.",
          409,
          "GMAIL_CONNECTION_CHANGED",
        ),
      )
      .mockResolvedValueOnce({
        items: [makeReceipt(2, "Amazon")],
        page: 2,
        per_page: 6,
        total: 1,
        has_more: false,
      });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Myntra").length).toBeGreaterThan(0);
    // The same page is read again in place; earlier pages are not repeated.
    expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(3);
    expect(GmailReceiptsService.scanReceipts).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ page: 2 }),
    );
    expect(
      screen.queryByText("Couldn’t finish scanning your receipts."),
    ).toBeNull();
  });

  it("opens a scanned receipt from its validated scan data without a Gmail read", async () => {
    const scanned = {
      ...makeReceipt(1, "Myntra"),
      source_evidence: [{ kind: "amount" as const, text: "Order total USD 19.99" }],
    };
    const unscanned = makeReceipt(2, "Amazon");
    vi.mocked(GmailReceiptsService.scanReceipts).mockResolvedValue({
      items: [scanned, unscanned],
      page: 1,
      per_page: 6,
      total: 2,
      has_more: false,
    });
    vi.mocked(GmailReceiptsService.getReceiptDetail).mockResolvedValue({
      item: unscanned,
      email_excerpt: null,
      source_evidence: [],
    } as never);

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();
    const rowFor = async (merchant: string) =>
      (await screen.findAllByTestId("receipt-row")).find((row) =>
        row.textContent?.includes(merchant),
      ) as HTMLElement;

    fireEvent.click(await rowFor("Myntra"));
    const detail = await screen.findByTestId("receipt-detail");
    expect(within(detail).getByText(/Order total USD 19.99/)).toBeTruthy();
    expect(GmailReceiptsService.getReceiptDetail).not.toHaveBeenCalled();

    // A row without validated scan evidence still reads its exact source.
    fireEvent.click(await rowFor("Amazon"));
    await waitFor(() =>
      expect(GmailReceiptsService.getReceiptDetail).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: unscanned.source_id }),
      ),
    );
  });

  it("shows the receipt orientation before a first-time workspace visit", async () => {
    window.localStorage.removeItem(
      "hushh.gmail.receipts.onboarding.v1:user-123",
    );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    const hero = await screen.findByTestId("receipt-sync-hero");
    expect(
      within(hero).getByRole("heading", { name: "Your receipts" }),
    ).toBeVisible();
    expect(
      within(hero).getByTestId("receipt-sync-description"),
    ).toHaveTextContent(
      "Find receipts in your mail. Automatically organized into smart categories.",
    );
    expect(
      within(hero)
        .getAllByRole("listitem")
        .map((category) => category.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Shopping", "Dining", "Travel"]);
    expect(
      within(hero).getByRole("button", { name: "Start sync" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Explore receipts" }),
    ).toBeNull();

    for (const category of ["shopping", "dining", "travel"]) {
      expect(
        screen
          .getByTestId(`receipt-sync-category-${category}`)
          .querySelectorAll('svg[data-canonical-icon="true"]'),
      ).toHaveLength(2);
    }
  });

  it("shows compact recent receipts directly below the preserved hero", async () => {
    window.localStorage.removeItem(
      "hushh.gmail.receipts.onboarding.v1:user-123",
    );
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [
        { ...makeReceipt(1, "Myntra"), order_id: "MYNTRA-1" },
        { ...makeReceipt(2, "Myntra"), order_id: "MYNTRA-2" },
        {
          ...makeReceipt(3, "Myntra"),
          order_id: "MYNTRA-3",
          amount: null,
        },
      ],
      page: 1,
      per_page: 20,
      total: 3,
      has_more: false,
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    const hero = await screen.findByTestId("receipt-sync-hero");
    const recent = await screen.findByTestId("recent-receipts");
    expect(
      hero.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(recent).getByRole("heading", { name: "Recent receipts" }),
    ).toBeVisible();
    expect(await within(recent).findAllByText("Myntra")).toHaveLength(3);
    expect(within(recent).getByText("—")).toBeVisible();
    expect(recent.querySelectorAll('[data-logo-kind="fallback"]')).toHaveLength(
      3,
    );
    expect(within(recent).queryByText(/MYNTRA-/)).toBeNull();
  });

  it("removes the redundant Gmail eyebrow", () => {
    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect(screen.queryByText(/one \/ mail/i)).toBeNull();
  });

  it("keeps generic summary cards off the landing while preserving its preview pipeline", async () => {
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Myntra")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });
    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/shopping summary/i)).toBeNull();
    expect(screen.queryByText(/receipt sync is moving/i)).toBeNull();
    await waitFor(() => {
      expect(
        vi.mocked(GmailReceiptMemoryService.preview),
      ).toHaveBeenCalledOnce();
    });
    expect(mocks.pkmWriteCoordinator.savePreparedDomain).not.toHaveBeenCalled();
  });

  it("holds sealed receipts behind vault unlock when the vault is locked", async () => {
    primeCachedGmailReceipts({
      userId: "user-123",
      accountKey: "akshat@example.com",
      response: {
        items: [makeReceipt(1, "Myntra")],
        page: 1,
        per_page: 20,
        total: 1,
        has_more: false,
      },
    });
    mocks.useVault.mockReturnValue({
      vaultKey: null,
      vaultOwnerToken: null,
      isVaultUnlocked: false,
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect(
      await screen.findByText(
        "Set up or open your private vault to view synced receipts.",
      ),
    ).toBeTruthy();
    expect(vi.mocked(GmailReceiptsService.listReceipts)).not.toHaveBeenCalled();
    expect(vi.mocked(GmailReceiptMemoryService.preview)).not.toHaveBeenCalled();
    expect(screen.queryByText("Myntra")).toBeNull();
  });

  it("continues after a matched page and keeps older receipts appended", async () => {
    vi.mocked(GmailReceiptsService.listReceipts).mockImplementation(
      async ({ page }) => {
        if (page === 1) {
          return {
            items: [makeReceipt(1, "Myntra")],
            page: 1,
            per_page: 20,
            total: 2,
            has_more: true,
            coverage: makeLiveCoverage(1),
          };
        }

        return {
          items: [makeReceipt(2, "Amazon")],
          page: 2,
          per_page: 20,
          total: 2,
          has_more: false,
        };
      },
    );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);
    expect(
      vi.mocked(GmailReceiptsService.listReceipts),
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idToken: "token-abc",
        vaultOwnerToken: "vault-owner-token-123",
      }),
    );

    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Myntra").length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(
        vi.mocked(GmailReceiptsService.listReceipts),
      ).toHaveBeenCalledTimes(2);
    });
  });

  it("continues a bounded scan when the first candidate page has no receipts", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockResolvedValueOnce({
        items: [],
        page: 1,
        per_page: 6,
        total: 0,
        has_more: true,
        coverage: makeLiveCoverage(1),
      })
      .mockResolvedValueOnce({
        items: [makeReceipt(2, "Amazon")],
        page: 2,
        per_page: 6,
        total: 1,
        has_more: false,
      });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(GmailReceiptsService.scanReceipts).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ page: 2, perPage: 6 }),
      );
    });
    expect(
      screen.queryByRole("button", { name: "Check older Mail" }),
    ).toBeNull();
  });

  it("retries the exact failed page after earlier pages matched nothing", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockResolvedValueOnce({
        items: [],
        page: 1,
        per_page: 6,
        total: 0,
        has_more: true,
        coverage: makeLiveCoverage(1),
      })
      .mockRejectedValueOnce(new Error("older receipt page unavailable"))
      .mockResolvedValueOnce({
        items: [makeReceipt(2, "Amazon")],
        page: 2,
        per_page: 6,
        total: 1,
        has_more: false,
      });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect(
      await screen.findByText("Couldn’t finish scanning your receipts."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    expect(GmailReceiptsService.scanReceipts).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ page: 2 }),
    );
  });

  it("stops an empty scan at the fifty-page receipt bound", async () => {
    vi.mocked(GmailReceiptsService.scanReceipts).mockImplementation(
      async ({ page }) => ({
        items: [],
        page: page ?? 1,
        per_page: 6,
        total: 0,
        has_more: (page ?? 1) < 50,
        coverage: makeLiveCoverage(page ?? 1, {
          max_pages: 50,
          reached_limit: (page ?? 1) === 50,
        }),
      }),
    );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect(
      await screen.findByText(
        /No receipts were found within the 50 Mail pages checked/i,
      ),
    ).toBeVisible();
    expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(50);
    expect(GmailReceiptsService.scanReceipts).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 50 }),
    );
    expect(
      screen.queryByRole("button", { name: "Check older Mail" }),
    ).toBeNull();
  });

  it("keeps visible rows and retries the failed pagination page", async () => {
    vi.mocked(GmailReceiptsService.listReceipts)
      .mockResolvedValueOnce({
        items: [makeReceipt(1, "Myntra")],
        page: 1,
        per_page: 20,
        total: 2,
        has_more: true,
        coverage: makeLiveCoverage(1),
      })
      .mockRejectedValueOnce(new Error("older page unavailable"))
      .mockResolvedValueOnce({
        items: [makeReceipt(2, "Amazon")],
        page: 2,
        per_page: 20,
        total: 2,
        has_more: false,
      });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();
    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);

    expect(
      await screen.findByText("Couldn’t finish scanning your receipts."),
    ).toBeVisible();
    expect(screen.getAllByText("Myntra").length).toBeGreaterThan(0);

    expect(screen.queryByText("older page unavailable")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    expect(
      vi.mocked(GmailReceiptsService.listReceipts),
    ).toHaveBeenNthCalledWith(3, expect.objectContaining({ page: 2 }));
  });

  it("renders synced receipts on tab revisits and remounts without rescanning", async () => {
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Myntra")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    const firstRender = render(
      <ProfileReceiptsPage initialWorkspace="receipts" />,
    );
    await startReceiptSync();
    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);

    for (let visit = 0; visit < 2; visit += 1) {
      fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
      fireEvent.click(screen.getByRole("tab", { name: "Receipts" }));
      expect(screen.getAllByText("Myntra").length).toBeGreaterThan(0);
    }

    firstRender.unmount();
    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect(screen.getAllByText("Myntra").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Loading receipts")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      vi.mocked(GmailReceiptsService.listReceipts),
    ).toHaveBeenCalledTimes(1);
  });

  it("renders a cached list without scanning and keeps its preview pipeline", async () => {
    const cachedResponse = {
      items: [makeReceipt(1, "Myntra")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    };
    primeCachedGmailReceipts({
      userId: "user-123",
      accountKey: "akshat@example.com",
      response: cachedResponse,
    });
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue(
      cachedResponse,
    );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(GmailReceiptMemoryService.preview).toHaveBeenCalledOnce();
    });
    expect(GmailReceiptsService.listReceipts).not.toHaveBeenCalled();
  });

  it("shows a cached empty result without rescanning", async () => {
    primeCachedGmailReceipts({
      userId: "user-123",
      accountKey: "akshat@example.com",
      response: {
        items: [],
        page: 1,
        per_page: 20,
        total: 0,
        has_more: false,
      },
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    await screen.findByText(/No receipts are available for this account/i);
    expect(GmailReceiptsService.listReceipts).not.toHaveBeenCalled();
  });

  it("never renders retired device or legacy rows from the cache", async () => {
    primeCachedGmailReceipts({
      userId: "user-123",
      accountKey: "akshat@example.com",
      fetchedAt: 1,
      response: {
        items: [
          {
            ...makeReceipt(1, "Myntra"),
            source_kind: "gmail_device",
          },
          {
            ...makeReceipt(2, "Amazon"),
            source_kind: "legacy_read_only",
          },
        ],
        page: 1,
        per_page: 20,
        total: 2,
        has_more: false,
      },
    });
    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    await screen.findByText(/No receipts are available for this account/i);
    expect(screen.queryByText("Myntra")).toBeNull();
    expect(screen.queryByText("Amazon")).toBeNull();
    expect(GmailReceiptsService.listReceipts).not.toHaveBeenCalled();
  });

  it("does not publish an in-flight receipt response after the vault locks", async () => {
    let resolveReceipts:
      | ((value: {
          items: ReturnType<typeof makeReceipt>[];
          page: number;
          per_page: number;
          total: number;
          has_more: boolean;
        }) => void)
      | null = null;
    vi.mocked(GmailReceiptsService.listReceipts).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReceipts = resolve;
      }),
    );

    const rendered = render(
      <ProfileReceiptsPage initialWorkspace="receipts" />,
    );
    await startReceiptSync();
    await waitFor(() =>
      expect(GmailReceiptsService.listReceipts).toHaveBeenCalledTimes(1),
    );

    mocks.useVault.mockReturnValue({
      vaultKey: null,
      vaultOwnerToken: null,
      isVaultUnlocked: false,
    });
    rendered.rerender(<ProfileReceiptsPage initialWorkspace="receipts" />);
    resolveReceipts?.({
      items: [makeReceipt(1, "Myntra")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    await screen.findByText(
      /Set up or open your private vault to view synced receipts/i,
    );
    await waitFor(() => expect(screen.queryByText("Myntra")).toBeNull());
  });

  it("retires the scan lease when vault authority rotates without locking", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof GmailReceiptsService.scanReceipts>>) => void;
    let finishCurrent!: (value: Awaited<ReturnType<typeof GmailReceiptsService.scanReceipts>>) => void;
    const pendingOld = new Promise<Awaited<ReturnType<typeof GmailReceiptsService.scanReceipts>>>((resolve) => { finishOld = resolve; });
    const pendingCurrent = new Promise<Awaited<ReturnType<typeof GmailReceiptsService.scanReceipts>>>((resolve) => { finishCurrent = resolve; });
    vi.mocked(GmailReceiptsService.scanReceipts)
      .mockImplementationOnce(() => pendingOld)
      .mockImplementationOnce(() => pendingCurrent);
    const rendered = render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();
    await waitFor(() => expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(GmailReceiptsService.scanReceipts).mock.calls[0][0].signal;
    mocks.useVault.mockReturnValue({ vaultKey: "test-key", vaultOwnerToken: "rotated-owner-token", isVaultUnlocked: true });
    rendered.rerender(<ProfileReceiptsPage initialWorkspace="receipts" />);
    expect(oldSignal?.aborted).toBe(true);
    await startReceiptSync();
    await waitFor(() => expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(2));
    expect(GmailReceiptsService.scanReceipts).toHaveBeenLastCalledWith(expect.objectContaining({ vaultOwnerToken: "rotated-owner-token" }));
    await act(async () => {
      finishOld({ items: [makeReceipt(1, "Retired Shop")], page: 1, per_page: 6,
        total: 1, has_more: false, coverage: makeLiveCoverage(1) });
      await pendingOld;
    });
    expect(screen.queryByText("Retired Shop")).toBeNull();
    expect(getCachedGmailReceipts("user-123", "akshat@example.com")).toBeNull();
    expect(screen.queryByText("Receipts updated.")).toBeNull();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Scanning", exact: true })).toBeDisabled();
    await act(async () => {
      finishCurrent({ items: [makeReceipt(2, "Current Shop")], page: 1, per_page: 6,
        total: 1, has_more: false, coverage: makeLiveCoverage(1) });
      await pendingCurrent;
    });
    expect((await screen.findAllByText("Current Shop")).length).toBeGreaterThan(0);
    expect(getCachedGmailReceipts("user-123", "akshat@example.com")?.items[0].merchant_name).toBe("Current Shop");
  });

  it("does not publish an in-flight response under a replacement Mail account", async () => {
    let resolveOldAccount:
      | ((value: {
          items: ReturnType<typeof makeReceipt>[];
          page: number;
          per_page: number;
          total: number;
          has_more: boolean;
        }) => void)
      | null = null;
    vi.mocked(GmailReceiptsService.listReceipts)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldAccount = resolve;
        }),
      )
      .mockResolvedValueOnce({
        items: [makeReceipt(2, "Amazon")],
        page: 1,
        per_page: 20,
        total: 1,
        has_more: false,
      });

    const rendered = render(
      <ProfileReceiptsPage initialWorkspace="receipts" />,
    );
    await startReceiptSync();
    await waitFor(() =>
      expect(GmailReceiptsService.listReceipts).toHaveBeenCalledTimes(1),
    );

    gmailView = makeGmailView({
      status: {
        ...buildGmailView().status,
        google_email: "replacement@example.com",
      },
    });
    mocks.useGmailConnectorStatus.mockReturnValue(gmailView);
    rendered.rerender(<ProfileReceiptsPage initialWorkspace="receipts" />);

    resolveOldAccount?.({
      items: [makeReceipt(1, "Myntra")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start sync" })).toBeEnabled(),
    );
    expect(screen.queryByText("Myntra")).toBeNull();
    // The replacement account is read only when its owner starts a sync.
    expect(GmailReceiptsService.listReceipts).toHaveBeenCalledTimes(1);
    await startReceiptSync();

    expect((await screen.findAllByText("Amazon")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Myntra")).toBeNull();
  });

  it("keeps a failed request distinct from a confirmed empty list", async () => {
    vi.mocked(GmailReceiptsService.listReceipts).mockRejectedValue(
      new Error("Receipt service unavailable"),
    );

    const { container } = render(
      <ProfileReceiptsPage initialWorkspace="receipts" />,
    );
    await startReceiptSync();

    expect(
      await screen.findByText("Couldn’t finish scanning your receipts."),
    ).toBeVisible();
    expect(
      screen.queryByText(/No receipts are available for this account/i),
    ).toBeNull();
    expect(
      container.querySelector('[data-native-data-state="error"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-native-error-code="gmail_receipts_load_failed"]',
      ),
    ).not.toBeNull();
  });

  it.each(["overview", "receipts"] as const)(
    "keeps background sync informational in %s",
    async (workspace) => {
      mocks.useGmailConnectorStatus.mockReturnValue(
        makeGmailView({
          syncRun: {
            run_id: "background-scan",
            user_id: "user-123",
            trigger_source: "manual",
            status: "running",
            listed_count: 10,
            filtered_count: 5,
            synced_count: 3,
            extracted_count: 1,
            duplicates_dropped: 0,
            extraction_success_rate: 1,
          },
          presentation: {
            ...buildGmailView().presentation,
            state: "syncing",
            badgeLabel: "Syncing",
            description: "Fetching recent purchases.",
          },
        }),
      );
      render(<ProfileReceiptsPage initialWorkspace={workspace} />);
      if (workspace === "overview") {
        expect(
          await screen.findByRole("status", { name: "Fetching receipts" }),
        ).toBeVisible();
        expect(
          within(
            screen.getByRole("tabpanel", { name: "Overview" }),
          ).queryByRole("progressbar", { hidden: true }),
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("mail-receipt-sync")).toHaveTextContent(
          "Receipt sync",
        );
      } else {
        expect(
          screen.queryByRole("progressbar", { name: "Receipt sync progress" }),
        ).not.toBeInTheDocument();
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Start sync" }),
          ).toBeEnabled(),
        );
        expect(screen.getByTestId("receipt-sync-hero")).toBeVisible();
      }
      expect(mocks.gmailReceiptsService.syncNow).not.toHaveBeenCalled();
    },
  );

  it("keeps one steady fetching state while older purchases arrive as a chain of runs", async () => {
    const run = (id: string, status: "running" | "completed") => ({
      run_id: id, user_id: "user-123", trigger_source: "backfill", sync_mode: "backfill" as const,
      status, listed_count: 10, filtered_count: 5, synced_count: 3, extracted_count: 1,
      duplicates_dropped: 0, extraction_success_rate: 1,
    });
    const backfillView = (syncRun: ReturnType<typeof run>) => makeGmailView({
      syncRun,
      presentation: {
        ...buildGmailView().presentation,
        state: syncRun.status === "running" ? "connected_backfill_running" : "connected",
      } as never,
    });
    mocks.useGmailConnectorStatus.mockReturnValue(backfillView(run("chunk-1", "running")));
    const { rerender } = render(<ProfileReceiptsPage initialWorkspace="overview" />);
    const receiptStatus = await screen.findByTestId("mail-receipt-sync");
    expect(receiptStatus).toHaveTextContent("Fetching older purchases…");

    // Chunk 1 ends before chunk 2 is visible: the seam must not read as "ready".
    mocks.useGmailConnectorStatus.mockReturnValue(backfillView(run("chunk-1", "completed")));
    rerender(<ProfileReceiptsPage initialWorkspace="overview" />);
    expect(receiptStatus).toHaveTextContent("Fetching older purchases…");
    expect(receiptStatus).not.toHaveTextContent("Your latest receipts are ready.");
    expect(screen.getByRole("status", { name: "Fetching receipts" })).toBeVisible();

    mocks.useGmailConnectorStatus.mockReturnValue(backfillView(run("chunk-2", "running")));
    rerender(<ProfileReceiptsPage initialWorkspace="overview" />);
    expect(receiptStatus).toHaveTextContent("Fetching older purchases…");
    expect(receiptStatus).not.toHaveTextContent("Your latest receipts are ready.");
  });

  it("shows a connected sync failure only in the lower receipt status card", async () => {
    const connected = buildGmailView();
    mocks.useGmailConnectorStatus.mockReturnValue(makeGmailView({
      status: { ...connected.status, last_sync_status: "failed" },
      presentation: { ...connected.presentation, state: "sync_failed" },
    }));
    render(<ProfileReceiptsPage />);

    const receiptStatus = await screen.findByTestId("mail-receipt-sync");
    expect(receiptStatus).toHaveTextContent("Sync failed.");
    expect(receiptStatus).toHaveClass("border-destructive/20");
    expect(screen.queryByText("Status", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Draft with One." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "Fetching receipts" })).not.toBeInTheDocument();
    expect(mocks.gmailReceiptsService.syncNow).not.toHaveBeenCalled();
  });

  it("does not treat retired device-run metrics as live scan progress", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        syncRun: {
          run_id: "device-mail-active",
          user_id: "user-123",
          trigger_source: "device_mail",
          status: "running",
          listed_count: 10,
          filtered_count: 5,
          synced_count: 3,
          extracted_count: 1,
          duplicates_dropped: 0,
          extraction_success_rate: 1,
        },
        presentation: {
          state: "connected_backfill_running",
          badgeLabel: "Syncing",
          description: "We’re fetching your recent purchases.",
          latestSyncText: "Sync in progress.",
          latestSyncBadge: null,
          isConnected: true,
        },
        status: {
          ...buildGmailView().status,
          last_sync_status: "running",
        },
      }),
    );
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Myntra")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect((await screen.findAllByText("Myntra")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/10 mail messages checked/i)).toBeNull();
    expect(screen.getByTestId("receipt-sync-hero")).toBeVisible();
    expect(screen.getByTestId("recent-receipts")).toBeVisible();

    await waitFor(() => {
      expect(
        vi.mocked(GmailReceiptsService.listReceipts),
      ).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(GmailReceiptMemoryService.preview)).not.toHaveBeenCalled();
  });

  it("shows the loading summary while Gmail status is still loading", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue({
      ...buildGmailView(),
      status: null,
      loadingStatus: true,
      presentation: {
        state: "loading",
        badgeLabel: "Checking",
        description: "Checking your Gmail connection…",
        latestSyncText: "Loading the latest connection details.",
        latestSyncBadge: null,
        isConnected: false,
      },
    } as ReturnType<typeof buildGmailView>);

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect(
      screen.getByRole("heading", { name: /checking your gmail status/i }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tabpanel", { name: "Receipts" })).getByText(
        /your inbox and receipts will appear here as they are ready/i,
      ),
    ).toBeTruthy();
  });

  it("does not scan or retain live account rows after Gmail disconnects", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: "gmail.readonly",
          last_sync_status: "completed",
          auto_sync_enabled: false,
          revoked: true,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Connect Gmail to sync receipt emails into Kai.",
          latestSyncText: "No sync has run yet.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Stored Shop")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect(screen.queryByText("Stored Shop")).toBeNull();
    expect(
      screen.getByRole("heading", { name: /reconnect mail/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect mail/i })).toBeTruthy();
    expect(screen.queryByText(/mail is currently disconnected/i)).toBeNull();
    expect(screen.queryByText(/shopping summary/i)).toBeNull();
    expect(GmailReceiptsService.scanReceipts).not.toHaveBeenCalled();
    expect(vi.mocked(GmailReceiptMemoryService.preview)).not.toHaveBeenCalled();
  });

  it("shows one clear Gmail connect action when Gmail is not connected", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: null,
          last_sync_status: null,
          auto_sync_enabled: false,
          revoked: false,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Gmail not connected.",
          latestSyncText: "Connect once to sync receipts.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    expect(
      screen.getByRole("heading", { name: /mail not connected/i }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tabpanel", { name: "Receipts" })).getByText(
        /syncs receipts into a private shopping summary/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0 receipts")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /connect mail/i }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));
    await waitFor(() => {
      expect(mocks.gmailOAuthPopup.open).toHaveBeenCalledWith(
        mocks.gmailOAuthPopup.attempt,
      );
      expect(GmailReceiptsService.startConnect).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
        loginHint: "akshat@example.com",
        includeGrantedScopes: true,
        purpose: "read",
      });
    });
    expect(mocks.gmailOAuthPopup.navigate).toHaveBeenCalledWith(
      mocks.gmailOAuthPopup.popup,
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(assignWindowLocation).not.toHaveBeenCalled();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("records a terminal outcome when the web OAuth popup is dismissed", async () => {
    const disconnectedView = makeGmailView({
      status: {
        configured: true,
        connected: false,
        status: "disconnected",
        scope_csv: null,
        last_sync_status: null,
        auto_sync_enabled: false,
        revoked: false,
        latest_run: null,
        google_email: null,
      },
      presentation: {
        state: "disconnected",
        badgeLabel: "Not connected",
        description: "Gmail not connected.",
        latestSyncText: "Connect once to sync receipts.",
        latestSyncBadge: null,
        isConnected: false,
      },
    });
    disconnectedView.refreshStatus.mockResolvedValue(disconnectedView.status);
    mocks.useGmailConnectorStatus.mockReturnValue(disconnectedView);

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));
    await waitFor(() => {
      expect(mocks.gmailOAuthPopup.navigate).toHaveBeenCalled();
    });

    mocks.gmailOAuthPopup.popup.closed = true;

    await waitFor(
      () => {
        expect(
          GmailReceiptsService.recordConsentFailure,
        ).toHaveBeenCalledWith({ code: "USER_CANCELLED" }, "user-123");
      },
      { timeout: 1_500 },
    );
  });

  it("honors a failed popup settlement even when an older Mail connection remains", async () => {
    const disconnectedView = makeGmailView({
      status: {
        configured: true,
        connected: false,
        status: "disconnected",
        scope_csv: null,
        last_sync_status: null,
        auto_sync_enabled: false,
        revoked: false,
        latest_run: null,
        google_email: null,
      },
      presentation: {
        state: "disconnected",
        badgeLabel: "Not connected",
        description: "Gmail not connected.",
        latestSyncText: "Connect once to sync receipts.",
        latestSyncBadge: null,
        isConnected: false,
      },
    });
    disconnectedView.refreshStatus.mockResolvedValue({
      ...disconnectedView.status,
      connected: true,
      status: "connected",
    });
    mocks.useGmailConnectorStatus.mockReturnValue(disconnectedView);
    mocks.gmailOAuthPopup.consumeStoredSettlement.mockReturnValue({
      schemaVersion: 1,
      type: "gmail_oauth_settlement",
      attemptId: "gmail-popup-test",
      outcome: "failed",
      message: "Mail permission was not granted.",
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));
    await waitFor(() => expect(mocks.gmailOAuthPopup.navigate).toHaveBeenCalled());
    mocks.gmailOAuthPopup.popup.closed = true;

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Mail permission was not granted.",
      ),
    );
    expect(mocks.toast.success).not.toHaveBeenCalledWith(
      "Mail connected. You can finish setup when ready.",
    );
  });

  it("records a web OAuth popup timeout as a terminal failure", async () => {
    const disconnectedView = makeGmailView({
      status: {
        configured: true,
        connected: false,
        status: "disconnected",
        scope_csv: null,
        last_sync_status: null,
        auto_sync_enabled: false,
        revoked: false,
        latest_run: null,
        google_email: null,
      },
      presentation: {
        state: "disconnected",
        badgeLabel: "Not connected",
        description: "Gmail not connected.",
        latestSyncText: "Connect once to sync receipts.",
        latestSyncBadge: null,
        isConnected: false,
      },
    });
    disconnectedView.refreshStatus.mockResolvedValue(disconnectedView.status);
    mocks.useGmailConnectorStatus.mockReturnValue(disconnectedView);

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));
    await waitFor(() => {
      expect(mocks.gmailOAuthPopup.navigate).toHaveBeenCalled();
    });

    await waitFor(
      () => {
        expect(GmailReceiptsService.recordConsentFailure).toHaveBeenCalledWith(
          { code: "POPUP_TIMEOUT" },
          "user-123",
        );
      },
      { timeout: 1_500 },
    );
    expect(mocks.gmailOAuthPopup.popup.close).toHaveBeenCalled();
  });

  it("retries a transient Gmail status failure without starting OAuth", async () => {
    const gmailViewWithStatusError = makeGmailView({
      status: null,
      statusError:
        "We couldn't check your Gmail connection right now. Please try again in a moment.",
      presentation: {
        state: "error",
        badgeLabel: "Unavailable",
        description: "We couldn't check Gmail right now.",
        latestSyncText: "Connection status is temporarily unavailable.",
        latestSyncBadge: null,
        isConnected: false,
      },
    });
    mocks.useGmailConnectorStatus.mockReturnValue(gmailViewWithStatusError);

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Mail status" }),
    );

    await waitFor(() => {
      expect(gmailViewWithStatusError.refreshStatus).toHaveBeenCalledWith({
        force: true,
        reconcile: false,
      });
    });
    expect(GmailReceiptsService.startConnect).not.toHaveBeenCalled();
  });

  it("keeps a connect recovery action visible in every disconnected Gmail workspace", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: null,
          last_sync_status: null,
          auto_sync_enabled: false,
          revoked: false,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Gmail not connected.",
          latestSyncText: "Connect once to sync receipts.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );

    render(<ProfileReceiptsPage />);

    fireEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    expect(
      await screen.findByRole("button", { name: /connect mail/i }),
    ).toBeVisible();

    // The KYC tab's own connect entry, which starts the same connection.
    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    expect(
      screen.getByRole("button", { name: /connect gmail to manage identity/i }),
    ).toBeVisible();
  });

  const disconnectedKycView = () =>
    makeGmailView({
      status: {
        configured: true,
        connected: false,
        status: "disconnected",
        scope_csv: null,
        last_sync_status: null,
        auto_sync_enabled: false,
        revoked: false,
        latest_run: null,
        google_email: null,
      },
      presentation: {
        state: "disconnected",
        badgeLabel: "Not connected",
        description: "Gmail not connected.",
        latestSyncText: "Connect once to sync receipts.",
        latestSyncBadge: null,
        isConnected: false,
      },
    });

  it("lands a KYC deep link on the KYC tab when Gmail is connected", async () => {
    render(<ProfileReceiptsPage forceWorkspace="kyc" />);
    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("KYC requests")).toBeVisible();
    expect(screen.queryByTestId("mail-kyc-connect")).toBeNull();
  });

  it("lands a KYC deep link on the KYC connect entry when Gmail is not connected", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(disconnectedKycView());
    render(<ProfileReceiptsPage forceWorkspace="kyc" />);

    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute("aria-selected", "true");
    const entry = screen.getByTestId("mail-kyc-connect-row");
    expect(entry).toHaveTextContent("Connect Gmail to manage identity");
    expect(screen.getByTestId("mail-kyc-connect-note")).toHaveTextContent(/KYC requests arrive by email/);
    // Not the general Mail status card, and exactly one way to connect.
    expect(screen.queryByRole("heading", { name: /mail not connected/i })).toBeNull();
    expect(screen.queryByText("KYC requests")).toBeNull();
    expect(screen.getAllByRole("button", { name: /connect (g)?mail/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /connect gmail to manage identity/i }));
    await waitFor(() =>
      expect(GmailReceiptsService.startConnect).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-123", purpose: "read" }),
      ),
    );
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("offers the same KYC connect entry when Gmail's permission was revoked", () => {
    const view = disconnectedKycView();
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({ ...view, status: { ...view.status, revoked: true } }),
    );
    render(<ProfileReceiptsPage forceWorkspace="kyc" />);
    expect(screen.getByTestId("mail-kyc-connect-row")).toHaveTextContent(
      "Connect Gmail to manage identity",
    );
  });

  it("keeps the status card and its retry on the KYC tab when Gmail status fails", () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({ ...disconnectedKycView(), statusError: "Mail status is unavailable." }),
    );
    render(<ProfileReceiptsPage forceWorkspace="kyc" />);
    expect(screen.queryByTestId("mail-kyc-connect")).toBeNull();
    expect(screen.getByRole("button", { name: /retry mail status/i })).toBeVisible();
  });

  it("hides Disconnect for a disconnected remembered account and restores it after reconnect", async () => {
    const connected = makeGmailView();
    mocks.useGmailConnectorStatus.mockReturnValue(makeGmailView({
      status: { ...connected.status, connected: false, status: "disconnected", revoked: true, google_email: "akshat@example.com" },
      presentation: { ...connected.presentation, state: "disconnected", isConnected: false },
    }));
    const { rerender } = render(<ProfileReceiptsPage />);
    expect(
      await screen.findByRole("button", { name: /connect mail/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /disconnect/i }),
    ).not.toBeInTheDocument();

    mocks.useGmailConnectorStatus.mockReturnValue(connected);
    rerender(<ProfileReceiptsPage />);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^manage$/i }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: /^disconnect$/i })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /^reconnect$/i })).toBeVisible();
  });

  it("retains the KYC panel while switching between Mail tabs", async () => {
    render(<ProfileReceiptsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    const panel = await screen.findByText("KYC requests");
    const workspacePanel = screen.getByRole("tabpanel", { name: "KYC" });
    expect(workspacePanel).toContainElement(panel);
    expect(panel).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(workspacePanel).toHaveAttribute("aria-hidden", "true");
    expect(workspacePanel).toHaveAttribute("inert");
    expect(screen.queryByRole("tabpanel", { name: "KYC" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    expect(workspacePanel).toHaveAttribute("aria-hidden", "true");
    expect(workspacePanel).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    expect(screen.getByText("KYC requests")).toBe(panel);
    expect(screen.getByRole("tabpanel", { name: "KYC" })).toBe(workspacePanel);
    expect(workspacePanel).toHaveAttribute("aria-hidden", "false");
    expect(workspacePanel).not.toHaveAttribute("inert");
    expect(panel).toBeVisible();
  });

  it("restores the KYC workspace after a secure-session remount", async () => {
    const firstMount = render(<ProfileReceiptsPage />);

    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // OnboardingJourneyGuard temporarily unmounts protected routes while a
    // slow foreground session validation settles.
    firstMount.unmount();
    render(<ProfileReceiptsPage />);

    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("KYC requests")).toBeVisible();
  });

  it("opens a Feed-requested workspace over the saved session tab", async () => {
    const firstMount = render(<ProfileReceiptsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "KYC" }));
    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    firstMount.unmount();

    const feedMount = render(<ProfileReceiptsPage forceWorkspace="receipts" />);
    expect(screen.getByRole("tab", { name: "Receipts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    feedMount.unmount();

    render(<ProfileReceiptsPage />);
    expect(screen.getByRole("tab", { name: "KYC" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("falls back to same-window OAuth when the retained popup is unavailable", async () => {
    const retainedPopup = mocks.gmailOAuthPopup.popup;
    (mocks.gmailOAuthPopup as { popup: typeof retainedPopup | null }).popup =
      null;
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: null,
          last_sync_status: null,
          auto_sync_enabled: false,
          revoked: false,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Gmail not connected.",
          latestSyncText: "Connect once to sync receipts.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );

    try {
      render(<ProfileReceiptsPage initialWorkspace="receipts" />);

      fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));

      await waitFor(() => {
        expect(GmailReceiptsService.startConnect).toHaveBeenCalledWith({
          idToken: "token-abc",
          userId: "user-123",
          loginHint: "akshat@example.com",
          includeGrantedScopes: true,
          purpose: "read",
        });
        expect(assignWindowLocation).toHaveBeenCalledWith(
          "https://accounts.google.com/o/oauth2/v2/auth",
        );
      });
      expect(mocks.gmailOAuthPopup.navigate).not.toHaveBeenCalled();
      expect(mocks.gmailOAuthPopup.persist).toHaveBeenCalledWith(
        window,
        mocks.gmailOAuthPopup.attempt,
      );
      expect(mocks.toast.error).not.toHaveBeenCalled();
    } finally {
      (mocks.gmailOAuthPopup as { popup: typeof retainedPopup | null }).popup =
        retainedPopup;
    }
  });

  it("uses native Gmail OAuth without launching browser OAuth inside the native iOS shell", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: null,
          last_sync_status: null,
          auto_sync_enabled: false,
          revoked: false,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Gmail not connected.",
          latestSyncText: "Connect once to sync receipts.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );

    render(<ProfileReceiptsPage journeyVariant="onboarding" />);

    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));

    await waitFor(() => {
      expect(GmailReceiptsService.startNativeConnect).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
        purpose: "read",
      });
      expect(mocks.hushhAuth.connectGmail).toHaveBeenCalledWith({
        serverClientId: "native-client-id",
        purpose: "read",
        preserveModify: false,
      });
      expect(GmailReceiptsService.completeNativeConnect).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
        serverAuthCode: "native-auth-code",
        purpose: "read",
      });
    });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Mail connected. Your receipt scan will continue in the background.",
    );
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.gmailOAuthPopup.open).not.toHaveBeenCalled();
    expect(GmailReceiptsService.startConnect).not.toHaveBeenCalled();
    expect(assignWindowLocation).not.toHaveBeenCalled();
    expect(mocks.gmailOAuthPopup.navigate).not.toHaveBeenCalled();
    expect(
      mocks.preVaultUserStateService.syncOnboardingJourney,
    ).not.toHaveBeenCalled();
  });

  it("records a dismissed native Gmail consent sheet as a terminal outcome", async () => {
    mocks.capacitor.isNativePlatform.mockReturnValue(true);
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: null,
          last_sync_status: null,
          auto_sync_enabled: false,
          revoked: false,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Gmail not connected.",
          latestSyncText: "Connect once to sync receipts.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );
    const cancellation = { code: "USER_CANCELLED" };
    mocks.hushhAuth.connectGmail.mockRejectedValueOnce(cancellation);

    render(<ProfileReceiptsPage journeyVariant="onboarding" />);
    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));

    await waitFor(() => {
      expect(
        GmailReceiptsService.recordConsentFailure,
      ).toHaveBeenCalledWith(cancellation, "user-123");
    });
    expect(GmailReceiptsService.completeNativeConnect).not.toHaveBeenCalled();
  });

  it("continues onboarding Gmail OAuth when iOS blocks popup session storage", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        status: {
          configured: true,
          connected: false,
          status: "disconnected",
          scope_csv: null,
          last_sync_status: null,
          auto_sync_enabled: false,
          revoked: false,
          latest_run: null,
          google_email: null,
        },
        presentation: {
          state: "disconnected",
          badgeLabel: "Not connected",
          description: "Gmail not connected.",
          latestSyncText: "Connect once to sync receipts.",
          latestSyncBadge: null,
          isConnected: false,
        },
      }),
    );
    mocks.preVaultUserStateService.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingPhase: "capability_setup",
      onboardingActiveCapability: "gmail",
      onboardingJourneyUpdatedAt: 456,
    });
    mocks.gmailOAuthPopup.popup.sessionStorage.setItem.mockImplementation(
      () => {
        throw new Error("iOS blocked popup sessionStorage");
      },
    );

    render(<ProfileReceiptsPage journeyVariant="onboarding" />);

    fireEvent.click(screen.getByRole("button", { name: /connect mail/i }));

    await waitFor(() => {
      expect(
        mocks.preVaultUserStateService.syncOnboardingJourney,
      ).toHaveBeenCalledWith({
        userId: "user-123",
        phase: "external_connector",
        activeCapability: "gmail",
        callbackState: "pending",
        callbackAttemptId: expect.any(String),
        expectedJourneyUpdatedAt: 456,
      });
      expect(mocks.gmailOAuthPopup.navigate).toHaveBeenCalledWith(
        mocks.gmailOAuthPopup.popup,
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
    });
    expect(mocks.gmailOAuthPopup.popup.close).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("allows Gmail setup to finish as soon as the connector is verified", () => {
    const finishSetup = vi.fn();
    const skipSetup = vi.fn();
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        syncRun: {
          run_id: "background-backfill",
          user_id: "user-123",
          trigger_source: "connect",
          sync_mode: "backfill",
          status: "running",
          listed_count: 0,
          filtered_count: 0,
          synced_count: 0,
          extracted_count: 0,
          duplicates_dropped: 0,
          extraction_success_rate: 0,
        },
        presentation: {
          state: "connected_backfill_running",
          badgeLabel: "Connected",
          description: "Gmail is connected and scanning in the background.",
          latestSyncText: "Scanning recent receipts.",
          latestSyncBadge: null,
          isConnected: true,
        },
      }),
    );

    render(
      <ProfileReceiptsPage
        journeyVariant="onboarding"
        onFinishSetup={finishSetup}
        onSkipSetup={skipSetup}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /finish mail setup/i }),
    );

    expect(finishSetup).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /skip mail setup/i }),
    ).toBeNull();
    expect(screen.getByTestId("recent-receipts")).toBeVisible();
  });

  it("opens One chat from the overview CTA", () => {
    render(<ProfileReceiptsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Chat with One" }));
    expect(mocks.navigateToAgentChat).toHaveBeenCalledOnce();
  });

  it("reconnects through the existing read-consent flow", async () => {
    render(<ProfileReceiptsPage />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^manage$/i }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /^reconnect$/i }));
    await waitFor(() => expect(GmailReceiptsService.startConnect).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "read", userId: "user-123" }),
    ));
    expect(mocks.gmailOAuthPopup.open).toHaveBeenCalledOnce();
  });

  it("keeps Mail connected when disconnect confirmation is canceled", async () => {
    render(<ProfileReceiptsPage />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^manage$/i }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /^disconnect$/i }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep connected" }));
    expect(gmailView.disconnectGmail).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows a zero receipt count only after the receipt list has loaded", async () => {
    render(<ProfileReceiptsPage />);
    expect(within(screen.getByTestId("mail-receipt-sync")).queryByText(/0 receipts/)).toBeNull();
    expect(GmailReceiptsService.listReceipts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    await screen.findByText("Start sync to find receipts in your Mail.");
    expect(GmailReceiptsService.listReceipts).not.toHaveBeenCalled();
    await startReceiptSync();
    await screen.findByText(/no receipts are available for this account/i);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(within(screen.getByTestId("mail-receipt-sync")).getByText(/0 receipts/)).toBeTruthy();
  });

  it("deletes the Gmail receipt cache when disconnecting", async () => {
    let finishOlder!: (value: Awaited<ReturnType<typeof GmailReceiptsService.scanReceipts>>) => void;
    const pendingOlder = new Promise<Awaited<ReturnType<typeof GmailReceiptsService.scanReceipts>>>((resolve) => { finishOlder = resolve; });
    vi.mocked(GmailReceiptsService.scanReceipts).mockImplementationOnce(async () => ({
      items: [makeReceipt(1, "Stored Shop")], page: 1, per_page: 6, total: 2, has_more: true,
      next_cursor: "page-two", coverage: makeLiveCoverage(1),
    })).mockImplementationOnce(() => pendingOlder);
    gmailView.disconnectGmail.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "gmail.readonly",
      last_sync_status: "completed",
      auto_sync_enabled: false,
      revoked: true,
      latest_run: null,
      google_email: "akshat@example.com",
    });

    render(<ProfileReceiptsPage initialWorkspace="receipts" />);
    await startReceiptSync();

    expect((await screen.findAllByText("Stored Shop")).length).toBeGreaterThan(
      0,
    );
    await waitFor(() => expect(GmailReceiptsService.scanReceipts).toHaveBeenCalledTimes(2));
    expect(getCachedGmailReceipts("user-123", "akshat@example.com")?.items).toHaveLength(1);
    // Disconnect is available through Manage on the Mail overview.
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /^manage$/i }), { key: "ArrowDown" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /^disconnect$/i }),
    );
    expect(screen.getByText("Disconnect Mail?")).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: /^disconnect$/i,
      }),
    );

    await waitFor(() => {
      expect(gmailView.disconnectGmail).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toast.promise).toHaveBeenCalledWith(
      expect.any(Promise),
      expect.objectContaining({
        loading: "Disconnecting Mail...",
        success: "Mail disconnected and Mail receipt data was deleted.",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Stored Shop")).toBeNull();
    });
    await act(async () => { finishOlder({ items: [makeReceipt(2, "Late Shop")], page: 2, per_page: 6, total: 2, has_more: false, coverage: makeLiveCoverage(2) }); await pendingOlder; });
    expect(getCachedGmailReceipts("user-123", "akshat@example.com")).toBeNull();
    expect(screen.queryByText("Late Shop")).toBeNull();
  });
});
