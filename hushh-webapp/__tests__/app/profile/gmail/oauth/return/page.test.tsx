import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  searchParamsGet: vi.fn(),
  useAuth: vi.fn(),
  gmailReceiptsService: {
    completeConnect: vi.fn(),
    getStatus: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
  useSearchParams: () => ({
    get: mocks.searchParamsGet,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: mocks.gmailReceiptsService,
}));

vi.mock("@/lib/profile/gmail-connector-store", () => ({
  primeConnectorStatus: vi.fn(),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import ProfileGmailOAuthReturnPage from "@/app/profile/gmail/oauth/return/page";

describe("ProfileGmailOAuthReturnPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParamsGet.mockReturnValue(null);
    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-123",
        getIdToken: vi.fn().mockResolvedValue("token-abc"),
      },
      loading: false,
    });
    mocks.gmailReceiptsService.completeConnect.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "gmail.readonly",
      last_sync_status: "idle",
      auto_sync_enabled: true,
      revoked: false,
    });
    mocks.gmailReceiptsService.getStatus.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "gmail.readonly",
      last_sync_status: "idle",
      auto_sync_enabled: true,
      revoked: false,
    });
  });

  it("redirects back to Gmail settings when the callback is replayed after a successful connection", async () => {
    mocks.gmailReceiptsService.completeConnect.mockRejectedValue(
      new Error("OAuth state expired")
    );

    render(
      <ProfileGmailOAuthReturnPage
        searchParams={{ code: "code-123", state: "state-123" }}
      />
    );

    await waitFor(() => {
      expect(mocks.gmailReceiptsService.getStatus).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
      });
    });

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/profile?tab=account&panel=gmail");
    });

    expect(screen.queryByText("Gmail connection needs attention")).toBeNull();
  });

  it("uses live search params when the initial server props are empty", async () => {
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "live-code-123";
      if (key === "state") return "live-state-123";
      return null;
    });

    render(
      <ProfileGmailOAuthReturnPage
        searchParams={{}}
      />
    );

    await waitFor(() => {
      expect(mocks.gmailReceiptsService.completeConnect).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
        code: "live-code-123",
        state: "live-state-123",
        redirectUri: "http://localhost:3000/profile/gmail/oauth/return",
      });
    });
  });
});
