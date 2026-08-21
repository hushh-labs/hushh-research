/**
 * /register-phone always asks. There is no host that gets waved through.
 *
 * This page used to detect localhost/dev hostnames and immediately redirect to
 * the setup hub — which made the one reachable phone screen a dead end while
 * the server still refused to record a cloud without `phone_verified is True`
 * (observed on dev.one.hushh.ai, 2026-08-19, with a freshly re-created
 * account). The bypass is deleted; these tests hold the door open: an
 * unverified signed-in visitor sees the verification flow, on every host, and
 * a fresh verification lands in One setup.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneMandatePageContent } from "@/app/register-phone/page";

const {
  replace,
  resolveAfterLoginMock,
  bootstrapStateMock,
  syncOnboardingJourneyMock,
} = vi.hoisted(() => ({
  replace: vi.fn(),
  resolveAfterLoginMock: vi.fn(),
  bootstrapStateMock: vi.fn(),
  syncOnboardingJourneyMock: vi.fn(),
}));

const user = {
  uid: "local-user",
  phoneNumber: null,
  getIdToken: vi.fn().mockResolvedValue("token"),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <p>{label}</p>,
}));
vi.mock("@/components/app-ui/native-route-marker", () => ({
  NativeRouteMarker: () => null,
}));
vi.mock("@/components/auth/phone-verification-flow", () => ({
  PhoneVerificationFlow: ({
    onCompleted,
  }: {
    onCompleted: (user: typeof user) => Promise<void> | void;
  }) => (
    <button type="button" onClick={() => void onCompleted({ ...user })}>
      Complete phone verification
    </button>
  ),
}));
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { ...user },
    loading: false,
    phoneNumber: null,
    startPhoneVerification: vi.fn(),
    confirmPhoneVerification: vi.fn(),
    refreshUser: vi.fn().mockResolvedValue(user),
    signOut: vi.fn(),
  }),
}));
vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    syncCurrentUser: vi.fn().mockResolvedValue({ phone_verified: false }),
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null) =>
      identity?.phone_verified === true,
  },
}));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingFlowActiveCookie: vi.fn(),
  setOnboardingRequiredCookie: vi.fn(),
}));
vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: resolveAfterLoginMock },
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: bootstrapStateMock,
    isSetupResolved: (state: { setupCompleted?: boolean }) =>
      state.setupCompleted === true,
    syncOnboardingJourney: syncOnboardingJourneyMock,
  },
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/onboarding/onboarding-journey-phase", () => ({
  resolvePostPhoneOnboardingPhase: () => "setup_hub",
}));

describe("PhoneMandatePageContent always asks", () => {
  beforeEach(() => {
    replace.mockReset();
    resolveAfterLoginMock.mockReset();
    bootstrapStateMock.mockReset();
    syncOnboardingJourneyMock.mockReset();
    resolveAfterLoginMock.mockResolvedValue("/one/setup");
    bootstrapStateMock.mockResolvedValue({ setupCompleted: false });
    syncOnboardingJourneyMock.mockResolvedValue(undefined);
  });

  it("shows the verification flow to an unverified visitor and never redirects away", async () => {
    // jsdom serves this test from localhost — the exact host the deleted
    // bypass used to redirect. The flow must render and stay.
    render(<PhoneMandatePageContent />);

    expect(
      await screen.findByRole("button", { name: "Complete phone verification" }),
    ).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps a freshly verified account in One setup before resolving any generic destination", async () => {
    // This models a stale generic resolver result. The fresh root state—not a
    // destination computed before verification—owns the account gate.
    resolveAfterLoginMock.mockResolvedValue("/one/profile");
    bootstrapStateMock.mockResolvedValue({ setupCompleted: false });

    render(<PhoneMandatePageContent />);
    fireEvent.click(
      screen.getByRole("button", { name: "Complete phone verification" }),
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one/setup");
    });
    expect(bootstrapStateMock).toHaveBeenCalledWith("local-user", {
      force: true,
    });
    expect(resolveAfterLoginMock).not.toHaveBeenCalled();
    expect(syncOnboardingJourneyMock).toHaveBeenCalledWith({
      userId: "local-user",
      phase: "setup_hub",
      activeCapability: null,
      callbackState: "none",
    });
  });
});
