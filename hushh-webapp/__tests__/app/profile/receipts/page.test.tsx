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
import { clearCachedGmailReceipts } from "@/lib/profile/gmail-receipts-cache";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

function makeReceipt(id: number, merchant: string) {
  return {
    id,
    gmail_message_id: `gmail-${id}`,
    merchant_name: merchant,
    subject: `${merchant} order`,
    amount: 19.99,
    currency: "USD",
    classification_source: "deterministic" as const,
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

    const button = screen.getByRole("button", { name: /sync now/i });
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => {
      expect(gmailView.syncNow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.toast.message).toHaveBeenCalledWith("Gmail sync started in the background.");
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

  it("does not show the reconnect CTA while Gmail status is still loading", async () => {
    mocks.useGmailConnectorStatus.mockReturnValue(
      makeGmailView({
        loadingStatus: true,
        presentation: {
          state: "loading",
          badgeLabel: "Checking",
          description: "Checking Gmail connector status...",
          latestSyncText: "Loading the latest connection details.",
          latestSyncBadge: null,
          isConnected: false,
        },
      })
    );

    render(<ProfileReceiptsPage />);

    expect(screen.queryByRole("button", { name: /open gmail connector/i })).toBeNull();
    expect(screen.getByText(/loading gmail connector status/i)).toBeTruthy();
  });

  it("keeps previously synced receipts visible after Gmail disconnects", async () => {
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
    expect(
      screen.getByText(/your previously synced receipts stay available below/i)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open gmail connector/i })).toBeNull();
  });
});
