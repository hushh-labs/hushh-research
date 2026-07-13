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
  syncOnboardingJourney: vi.fn(),
  bootstrapState: vi.fn(),
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

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    syncOnboardingJourney: mocks.syncOnboardingJourney,
    bootstrapState: mocks.bootstrapState,
    isSetupResolved: (state: { setupCompleted?: boolean } | null) =>
      state?.setupCompleted === true,
  },
}));

vi.mock("@/lib/profile/gmail-connector-store", () => ({
  primeConnectorStatus: vi.fn(),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
    mocks.syncOnboardingJourney.mockResolvedValue(undefined);
    mocks.bootstrapState.mockResolvedValue(null);
    window.sessionStorage.clear();
  });

  it("redirects back to Gmail receipts when the callback is replayed after a successful connection", async () => {
    mocks.gmailReceiptsService.completeConnect.mockRejectedValue(
      new Error("OAuth state expired"),
    );
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "code-123";
      if (key === "state") return "state-123";
      return null;
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(mocks.gmailReceiptsService.getStatus).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
      });
    });

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });

    expect(screen.queryByText("Gmail connection needs attention")).toBeNull();
  });

  it("uses live search params when the initial server props are empty", async () => {
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "live-code-123";
      if (key === "state") return "live-state-123";
      return null;
    });

    render(<ProfileGmailOAuthReturnPage />);

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

  it("settles a setup-originated Gmail callback at its terminal acknowledgement", async () => {
    window.sessionStorage.setItem(
      "one_onboarding_connector_intent_v1",
      JSON.stringify({
        version: 1,
        capability: "gmail",
        returnTo: "/one/setup",
        correlationId: "connector-test",
        startedAt: Date.now(),
      }),
    );
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "code-setup";
      if (key === "state") return "state-setup";
      return null;
    });
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingPhase: "external_connector",
      onboardingActiveCapability: "gmail",
      onboardingCallbackState: "pending",
      onboardingCallbackAttemptId: "connector-test",
      onboardingJourneyUpdatedAt: 123,
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith({
        userId: "user-123",
        phase: "capability_setup",
        activeCapability: "gmail",
        callbackState: "succeeded",
        expectedJourneyUpdatedAt: 123,
        expectedCallbackAttemptId: "connector-test",
      });
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/setup/gmail");
    });
    expect(
      window.sessionStorage.getItem("one_onboarding_connector_intent_v1"),
    ).toBeNull();
  });

  it("does not settle a durable setup journey when the browser correlation is missing", async () => {
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingActiveCapability: "gmail",
    });
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "error") return "access_denied";
      return null;
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => expect(screen.getByText("Gmail connection needs attention")).toBeTruthy());
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
    expect(screen.getByText("Gmail connection needs attention")).toBeTruthy();
  });

  it("does not mark a callback without the matching browser correlation", async () => {
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingActiveCapability: "gmail",
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => expect(screen.getByText("Gmail connection needs attention")).toBeTruthy());
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
  });

  it("keeps connector success authoritative when the journey echo fails", async () => {
    window.sessionStorage.setItem(
      "one_onboarding_connector_intent_v1",
      JSON.stringify({
        version: 1,
        capability: "gmail",
        returnTo: "/one/setup",
        correlationId: "connector-test",
        startedAt: Date.now(),
      }),
    );
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "code-setup";
      if (key === "state") return "state-setup";
      return null;
    });
    mocks.syncOnboardingJourney.mockRejectedValue(
      new Error("journey unavailable"),
    );
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingPhase: "external_connector",
      onboardingActiveCapability: "gmail",
      onboardingCallbackState: "pending",
      onboardingCallbackAttemptId: "connector-test",
      onboardingJourneyUpdatedAt: 123,
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });
    expect(screen.queryByText("Gmail connection needs attention")).toBeNull();
    expect(
      window.sessionStorage.getItem("one_onboarding_connector_intent_v1"),
    ).toBeNull();
  });
});
