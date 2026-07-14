import { render, screen, waitFor } from "@testing-library/react";
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
  PhoneVerificationFlow: () => null,
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
vi.mock("@/lib/services/phone-mandate-service", () => ({
  shouldBypassPhoneMandateForLocalhost: () => true,
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/onboarding/onboarding-journey-phase", () => ({
  resolvePostPhoneOnboardingPhase: () => "setup_hub",
}));

describe("PhoneMandatePageContent localhost continuation", () => {
  beforeEach(() => {
    replace.mockReset();
    resolveAfterLoginMock.mockReset();
    bootstrapStateMock.mockReset();
    syncOnboardingJourneyMock.mockReset();
    resolveAfterLoginMock.mockResolvedValue("/one/setup");
    bootstrapStateMock.mockResolvedValue({ setupCompleted: false });
    syncOnboardingJourneyMock.mockResolvedValue(undefined);
  });

  it("enters the setup hub once without waiting for post-auth reconciliation", async () => {
    const view = render(<PhoneMandatePageContent />);

    view.rerender(<PhoneMandatePageContent />);
    view.rerender(<PhoneMandatePageContent />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one/setup");
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(resolveAfterLoginMock).not.toHaveBeenCalled();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    expect(syncOnboardingJourneyMock).not.toHaveBeenCalled();
    // The mocked router does not unmount the page. This confirms the
    // transition remains pending in the mock without restarting work.
    expect(screen.getByText("Continuing local session...")).toBeVisible();
  });
});
