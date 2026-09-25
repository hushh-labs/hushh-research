import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  searchParamsGet: vi.fn(),
  useAuth: vi.fn(),
  gmailReceiptsService: {
    completeConnect: vi.fn(),
    getStatus: vi.fn(),
    recordConsentFailure: vi.fn(),
    recordConnectCompletion: vi.fn(),
  },
  beginGmailOAuthCompletion: vi.fn(),
  failGmailOAuthCompletion: vi.fn(),
  primeConnectorStatus: vi.fn(),
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
  beginGmailOAuthCompletion: mocks.beginGmailOAuthCompletion,
  failGmailOAuthCompletion: mocks.failGmailOAuthCompletion,
  primeConnectorStatus: mocks.primeConnectorStatus,
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

import ProfileGmailOAuthReturnPage from "@/app/one/profile/gmail/oauth/return/page";

describe("ProfileGmailOAuthReturnPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: null,
    });
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
        force: true,
      });
    });

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });

    expect(screen.queryByText("Mail connection needs attention")).toBeNull();
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
      }, { recordTelemetry: false });
    });
  });

  it("opens Gmail immediately while a direct OAuth completion continues in memory", async () => {
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "slow-code";
      if (key === "state") return "slow-state";
      return null;
    });
    let resolveCompletion:
      | ((value: {
          configured: boolean;
          connected: boolean;
          status: string;
          scope_csv: string;
          last_sync_status: string;
          auto_sync_enabled: boolean;
          revoked: boolean;
        }) => void)
      | undefined;
    mocks.gmailReceiptsService.completeConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompletion = resolve;
        }),
    );

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(mocks.beginGmailOAuthCompletion).toHaveBeenCalledWith("user-123");
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });

    expect(mocks.primeConnectorStatus).not.toHaveBeenCalled();
    resolveCompletion?.({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "gmail.readonly gmail.send",
      last_sync_status: "queued",
      auto_sync_enabled: true,
      revoked: false,
    });
    await waitFor(() => expect(mocks.primeConnectorStatus).toHaveBeenCalled());
  });

  it("records one success when a timed-out completion is confirmed by reconciliation", async () => {
    vi.useFakeTimers();
    try {
      mocks.searchParamsGet.mockImplementation((key: string) => {
        if (key === "code") return "slow-code";
        if (key === "state") return "slow-state";
        return null;
      });
      mocks.gmailReceiptsService.completeConnect.mockImplementationOnce(
        () => new Promise(() => undefined),
      );

      render(<ProfileGmailOAuthReturnPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(35_000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(mocks.gmailReceiptsService.getStatus).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
        force: true,
      });
      expect(
        mocks.gmailReceiptsService.recordConnectCompletion,
      ).toHaveBeenCalledOnce();
      expect(
        mocks.gmailReceiptsService.recordConnectCompletion,
      ).toHaveBeenCalledWith("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a read-only status as a completed send-permission upgrade", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window, "close").mockImplementation(() => undefined);
      window.sessionStorage.setItem(
        "one_gmail_oauth_popup_attempt_v1",
        JSON.stringify({
          version: 1,
          attemptId: "gmail-send-upgrade",
          startedAt: Date.now(),
          ownerId: "user-123",
          purpose: "send",
        }),
      );
      mocks.searchParamsGet.mockImplementation((key: string) => {
        if (key === "code") return "slow-send-code";
        if (key === "state") return "slow-send-state";
        return null;
      });
      mocks.gmailReceiptsService.completeConnect.mockImplementationOnce(
        () => new Promise(() => undefined),
      );
      mocks.gmailReceiptsService.getStatus.mockResolvedValue({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "gmail.readonly",
        send_permission_granted: false,
        auto_sync_enabled: true,
        revoked: false,
      });

      const view = render(<ProfileGmailOAuthReturnPage />);
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50_000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(
        mocks.gmailReceiptsService.recordConnectCompletion,
      ).toHaveBeenCalledExactlyOnceWith("error");
      expect(
        mocks.gmailReceiptsService.recordConnectCompletion,
      ).not.toHaveBeenCalledWith("success");
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses a late callback outcome after the authenticated owner changes", async () => {
    let resolveCompletion!: (value: {
      configured: boolean;
      connected: boolean;
      status: string;
      scope_csv: string;
      auto_sync_enabled: boolean;
      revoked: boolean;
    }) => void;
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "owner-a-code";
      if (key === "state") return "owner-a-state";
      return null;
    });
    mocks.gmailReceiptsService.completeConnect.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
    );
    const view = render(<ProfileGmailOAuthReturnPage />);
    await waitFor(() =>
      expect(mocks.gmailReceiptsService.completeConnect).toHaveBeenCalled(),
    );

    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-456",
        getIdToken: vi.fn().mockResolvedValue("token-def"),
      },
      loading: false,
    });
    view.rerender(<ProfileGmailOAuthReturnPage />);
    await act(async () => {
      resolveCompletion({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
      });
    });

    expect(
      mocks.gmailReceiptsService.recordConnectCompletion,
    ).not.toHaveBeenCalled();
  });

  it("suppresses a detached callback outcome after unmount", async () => {
    let resolveCompletion!: (value: {
      configured: boolean;
      connected: boolean;
      status: string;
      scope_csv: string;
      auto_sync_enabled: boolean;
      revoked: boolean;
    }) => void;
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "unmounted-code";
      if (key === "state") return "unmounted-state";
      return null;
    });
    mocks.gmailReceiptsService.completeConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompletion = resolve;
        }),
    );
    const view = render(<ProfileGmailOAuthReturnPage />);
    await waitFor(() =>
      expect(mocks.gmailReceiptsService.completeConnect).toHaveBeenCalled(),
    );

    view.unmount();
    await act(async () => {
      resolveCompletion({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
      });
    });

    expect(
      mocks.gmailReceiptsService.recordConnectCompletion,
    ).not.toHaveBeenCalled();
  });

  it("returns a redacted terminal result to the retained Gmail popup opener", async () => {
    const opener = {
      closed: false,
      postMessage: vi.fn(),
    };
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: opener,
    });
    window.sessionStorage.setItem(
      "one_gmail_oauth_popup_attempt_v1",
      JSON.stringify({
        version: 1,
        attemptId: "gmail-popup-test",
        startedAt: Date.now(),
        ownerId: "user-123",
      }),
    );
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "popup-code";
      if (key === "state") return "popup-state";
      return null;
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(opener.postMessage).toHaveBeenCalledWith(
        {
          schemaVersion: 1,
          type: "gmail_oauth_settlement",
          attemptId: "gmail-popup-test",
          outcome: "succeeded",
        },
        window.location.origin,
      );
    });
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    await waitFor(() => expect(close).toHaveBeenCalled());
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
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });
    expect(
      window.sessionStorage.getItem("one_onboarding_connector_intent_v1"),
    ).toBeNull();
  });

  it("opens Gmail before a slow setup acknowledgement finishes", async () => {
    window.sessionStorage.setItem(
      "one_onboarding_connector_intent_v1",
      JSON.stringify({
        version: 1,
        capability: "gmail",
        returnTo: "/one/setup",
        correlationId: "connector-slow-setup",
        startedAt: Date.now(),
      }),
    );
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "code-slow-setup";
      if (key === "state") return "state-slow-setup";
      return null;
    });
    const pendingJourney = {
      setupCompleted: false,
      onboardingPhase: "external_connector",
      onboardingActiveCapability: "gmail",
      onboardingCallbackState: "pending",
      onboardingCallbackAttemptId: "connector-slow-setup",
      onboardingJourneyUpdatedAt: 456,
    };
    let resolveJourney: ((value: typeof pendingJourney) => void) | undefined;
    mocks.bootstrapState
      .mockImplementationOnce(
        () =>
          new Promise<typeof pendingJourney>((resolve) => {
            resolveJourney = resolve;
          }),
      )
      .mockResolvedValue(pendingJourney);

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();

    resolveJourney?.(pendingJourney);
    await waitFor(() => {
      expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith({
        userId: "user-123",
        phase: "capability_setup",
        activeCapability: "gmail",
        callbackState: "succeeded",
        expectedJourneyUpdatedAt: 456,
        expectedCallbackAttemptId: "connector-slow-setup",
      });
    });
  });

  it("recovers setup acknowledgement from the durable journey when the browser correlation is missing", async () => {
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "code-setup-ios";
      if (key === "state") return "state-setup-ios";
      return null;
    });
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingPhase: "external_connector",
      onboardingActiveCapability: "gmail",
      onboardingCallbackState: "pending",
      onboardingCallbackAttemptId: "connector-ios-durable",
      onboardingJourneyUpdatedAt: 789,
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => {
      expect(mocks.gmailReceiptsService.completeConnect).toHaveBeenCalledWith({
        idToken: "token-abc",
        userId: "user-123",
        code: "code-setup-ios",
        state: "state-setup-ios",
      }, { recordTelemetry: false });
      expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith({
        userId: "user-123",
        phase: "capability_setup",
        activeCapability: "gmail",
        callbackState: "succeeded",
        expectedJourneyUpdatedAt: 789,
        expectedCallbackAttemptId: "connector-ios-durable",
      });
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
    });
  });

  it("recovers setup acknowledgement when browser session storage is unavailable", async () => {
    const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "sessionStorage",
    );
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("sessionStorage unavailable");
      },
    });
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "code") return "code-setup-storage-blocked";
      if (key === "state") return "state-setup-storage-blocked";
      return null;
    });
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingPhase: "external_connector",
      onboardingActiveCapability: "gmail",
      onboardingCallbackState: "pending",
      onboardingCallbackAttemptId: "connector-storage-blocked",
      onboardingJourneyUpdatedAt: 987,
    });

    try {
      render(<ProfileGmailOAuthReturnPage />);

      await waitFor(() => {
        expect(mocks.gmailReceiptsService.completeConnect).toHaveBeenCalledWith(
          {
            idToken: "token-abc",
            userId: "user-123",
            code: "code-setup-storage-blocked",
            state: "state-setup-storage-blocked",
          },
          { recordTelemetry: false },
        );
        expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith({
          userId: "user-123",
          phase: "capability_setup",
          activeCapability: "gmail",
          callbackState: "succeeded",
          expectedJourneyUpdatedAt: 987,
          expectedCallbackAttemptId: "connector-storage-blocked",
        });
        expect(mocks.routerReplace).toHaveBeenCalledWith("/one/gmail");
      });
    } finally {
      if (sessionStorageDescriptor) {
        Object.defineProperty(window, "sessionStorage", sessionStorageDescriptor);
      }
    }
  });

  it("does not settle setup when no pending Gmail callback exists", async () => {
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingActiveCapability: "gmail",
    });
    mocks.searchParamsGet.mockImplementation((key: string) => {
      if (key === "error") return "access_denied";
      return null;
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => expect(screen.getByText("Mail connection needs attention")).toBeTruthy());
    expect(mocks.gmailReceiptsService.recordConsentFailure).toHaveBeenCalledWith({
      code: "USER_CANCELLED",
    });
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
    expect(screen.getByText("Mail connection needs attention")).toBeTruthy();
  });

  it("does not mark a callback without the matching browser correlation", async () => {
    mocks.bootstrapState.mockResolvedValue({
      setupCompleted: false,
      onboardingActiveCapability: "gmail",
    });

    render(<ProfileGmailOAuthReturnPage />);

    await waitFor(() => expect(screen.getByText("Mail connection needs attention")).toBeTruthy());
    expect(mocks.gmailReceiptsService.recordConsentFailure).toHaveBeenCalledWith({
      code: "MALFORMED_CALLBACK",
    });
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
    expect(screen.queryByText("Mail connection needs attention")).toBeNull();
    expect(
      window.sessionStorage.getItem("one_onboarding_connector_intent_v1"),
    ).toBeNull();
  });
});
