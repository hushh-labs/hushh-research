import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    routerPush: vi.fn(),
    useAuth: vi.fn(),
    useGmailConnectorStatus: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
    },
    gmailReceiptsService: {
      listReceipts: vi.fn(),
      syncNow: vi.fn(),
    },
  };
});

let gmailView: ReturnType<typeof buildGmailView>;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
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

vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: mocks.gmailReceiptsService,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title, description, actions }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SurfaceStack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value?: number }) => <div data-value={value} />,
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
  RefreshCw: () => <span />,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { PROFILE: "/profile", PROFILE_RECEIPTS: "/profile/receipts" },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: null,
    vaultOwnerToken: null,
    isVaultUnlocked: false,
  }),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    refreshDomain: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    writePreparedDomain: vi.fn(),
  },
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
  PersonalKnowledgeModelService: {
    getPreparedDomain: vi.fn(),
  },
}));

vi.mock("@/lib/profile/gmail-receipt-memory-pkm", () => ({
  buildShoppingReceiptMemoryPreparedDomain: vi.fn(),
  hasMatchingReceiptMemoryProvenance: vi.fn().mockReturnValue(false),
}));

import ProfileReceiptsPage from "@/app/profile/receipts/page";
import {
  clearCachedGmailReceipts,
  primeCachedGmailReceipts,
} from "@/lib/profile/gmail-receipts-cache";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { GmailReceiptMemoryService } from "@/lib/services/gmail-receipt-memory-service";

function makeReceipt(id: number, merchant: string) {
  const timestamp = `2026-04-0${id}T00:00:00Z`;
  return {
    id,
    gmail_message_id: `gmail-${id}`,
    merchant_name: merchant,
    subject: `${merchant} order`,
    amount: 19.99,
    currency: "USD",
    classification_source: "deterministic" as const,
    receipt_date: timestamp,
    gmail_internal_date: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
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

describe("ProfileReceiptsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedGmailReceipts("user-123");
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
    }
    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-123",
        getIdToken: vi.fn().mockResolvedValue("token-abc"),
      },
      loading: false,
    });
    gmailView = buildGmailView();
    mocks.useGmailConnectorStatus.mockReturnValue(gmailView);

    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [],
      page: 1,
      per_page: 20,
      total: 0,
      has_more: false,
    });
  });

  it("starts Gmail sync in the background", async () => {
    render(<ProfileReceiptsPage />);

    const button = screen.getByRole("button", { name: /sync receipts/i });
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => {
      expect(gmailView.syncNow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.toast.message).toHaveBeenCalledWith("Syncing your receipts now.");
  });

  it("keeps older receipts appended after loading the next page", async () => {
    vi.mocked(GmailReceiptsService.listReceipts).mockImplementation(async ({ page }) => {
      if (page === 1) {
        return {
          items: [makeReceipt(1, "Page One Shop")],
          page: 1,
          per_page: 20,
          total: 2,
          has_more: true,
        };
      }

      return {
        items: [makeReceipt(2, "Page Two Shop")],
        page: 2,
        per_page: 20,
        total: 2,
        has_more: false,
      };
    });

    render(<ProfileReceiptsPage />);

    expect(await screen.findByText("Page One Shop")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /load older receipts/i }));

    expect(await screen.findByText("Page Two Shop")).toBeTruthy();
    expect(screen.getByText("Page One Shop")).toBeTruthy();

    await waitFor(() => {
      expect(vi.mocked(GmailReceiptsService.listReceipts)).toHaveBeenCalledTimes(2);
    });
  });

  it("reuses cached receipts on remount instead of refetching immediately", async () => {
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Cached Shop")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    const firstRender = render(<ProfileReceiptsPage />);
    expect(await screen.findByText("Cached Shop")).toBeTruthy();

    firstRender.unmount();
    render(<ProfileReceiptsPage />);

    expect(await screen.findByText("Cached Shop")).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(GmailReceiptsService.listReceipts)).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the receipt-memory preview cached when the existing watermark is still current", async () => {
    const cachedResponse = {
      items: [makeReceipt(1, "Current Watermark Shop")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    };
    primeCachedGmailReceipts({
      userId: "user-123",
      response: cachedResponse,
    });
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue(cachedResponse);

    const renderResult = render(<ProfileReceiptsPage />);

    expect(await screen.findByText("Current Watermark Shop")).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(GmailReceiptMemoryService.preview)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(GmailReceiptMemoryService.preview)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        forceRefresh: false,
      })
    );

    gmailView = makeGmailView({
      syncRun: {
        run_id: "run-2",
        user_id: "user-123",
        trigger_source: "manual",
        status: "completed",
        completed_at: "2026-04-02T00:00:00Z",
        listed_count: 1,
        filtered_count: 1,
        synced_count: 1,
        extracted_count: 1,
        duplicates_dropped: 0,
        extraction_success_rate: 1,
      },
      status: {
        ...buildGmailView().status,
        last_sync_at: "2026-04-02T00:00:00Z",
        last_sync_status: "completed",
        latest_run: {
          run_id: "run-2",
          user_id: "user-123",
          trigger_source: "manual",
          status: "completed",
          completed_at: "2026-04-02T00:00:00Z",
          listed_count: 1,
          filtered_count: 1,
          synced_count: 1,
          extracted_count: 1,
          duplicates_dropped: 0,
          extraction_success_rate: 1,
        },
      },
    });
    mocks.useGmailConnectorStatus.mockReturnValue(gmailView);

    renderResult.rerender(<ProfileReceiptsPage />);

    await waitFor(() => {
      expect(vi.mocked(GmailReceiptMemoryService.preview)).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(GmailReceiptMemoryService.preview)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        forceRefresh: false,
      })
    );
  });

  it("waits until Gmail sync settles before building the receipt-memory preview", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
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
      })
    );
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Backfill Shop")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    render(<ProfileReceiptsPage />);

    expect(await screen.findByText("Backfill Shop")).toBeTruthy();
    expect(
      screen.getByText(/we'll prepare your shopping summary after gmail finishes syncing/i)
    ).toBeTruthy();

    await waitFor(() => {
      expect(vi.mocked(GmailReceiptsService.listReceipts)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(GmailReceiptMemoryService.preview)).not.toHaveBeenCalled();
  });

  it("shows the loading summary while Gmail status is still loading", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      {
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
      } as ReturnType<typeof buildGmailView>
    );

    render(<ProfileReceiptsPage />);

    expect(screen.getByRole("heading", { name: /checking your gmail connection/i })).toBeTruthy();
    expect(screen.getByText(/this should only take a moment/i)).toBeTruthy();
  });

  it("keeps previously synced receipts visible with reconnect guidance after Gmail disconnects", async () => {
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
      })
    );
    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [makeReceipt(1, "Stored Shop")],
      page: 1,
      per_page: 20,
      total: 1,
      has_more: false,
    });

    render(<ProfileReceiptsPage />);

    expect(await screen.findByText("Stored Shop")).toBeTruthy();
    expect(screen.getByText(/saved receipts are still available here/i)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /reconnect gmail to keep syncing receipts/i })
    ).toBeTruthy();
  });
});
