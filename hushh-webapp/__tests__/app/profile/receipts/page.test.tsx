import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    routerPush: vi.fn(),
    useAuth: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
    },
    gmailReceiptsService: {
      getStatus: vi.fn(),
      listReceipts: vi.fn(),
      syncNow: vi.fn(),
      getSyncRun: vi.fn(),
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: mocks.useAuth,
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
  PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
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
  Mail: () => <span />,
  RefreshCw: () => <span />,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { PROFILE: "/profile" },
}));

import ProfileReceiptsPage from "@/app/profile/receipts/page";
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

describe("ProfileReceiptsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-123",
        getIdToken: vi.fn().mockResolvedValue("token-abc"),
      },
      loading: false,
    });

    vi.mocked(GmailReceiptsService.getStatus).mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "gmail.readonly",
      last_sync_status: "completed",
      auto_sync_enabled: false,
      revoked: false,
      latest_run: null,
    });

    vi.mocked(GmailReceiptsService.listReceipts).mockResolvedValue({
      items: [],
      page: 1,
      per_page: 20,
      total: 0,
      has_more: false,
    });

    vi.mocked(GmailReceiptsService.syncNow).mockResolvedValue({
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
    });

    vi.mocked(GmailReceiptsService.getSyncRun).mockResolvedValue({
      run: {
        run_id: "run-1",
        user_id: "user-123",
        trigger_source: "manual",
        status: "failed",
        listed_count: 12,
        filtered_count: 3,
        synced_count: 1,
        extracted_count: 1,
        duplicates_dropped: 0,
        extraction_success_rate: 1,
        error_message: "Sync failed because mailbox is locked.",
      },
    });
  });

  it("shows an error toast when the latest sync run fails", async () => {
    render(<ProfileReceiptsPage />);

    await waitFor(() => {
      expect(vi.mocked(GmailReceiptsService.getStatus)).toHaveBeenCalled();
    });

    const button = screen.getByRole("button", { name: /sync now/i });
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.toast.error).toHaveBeenCalledWith("Sync failed because mailbox is locked.");
    });

    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("shows a success toast when the latest sync run completes", async () => {
    vi.mocked(GmailReceiptsService.getSyncRun).mockResolvedValue({
      run: {
        run_id: "run-1",
        user_id: "user-123",
        trigger_source: "manual",
        status: "completed",
        listed_count: 12,
        filtered_count: 3,
        synced_count: 3,
        extracted_count: 2,
        duplicates_dropped: 1,
        extraction_success_rate: 1,
      },
    });

    render(<ProfileReceiptsPage />);

    await waitFor(() => {
      expect(vi.mocked(GmailReceiptsService.getStatus)).toHaveBeenCalled();
    });

    const button = screen.getByRole("button", { name: /sync now/i });
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.toast.success).toHaveBeenCalledWith("Receipt sync completed.");
    });

    expect(mocks.toast.error).not.toHaveBeenCalled();
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
});
