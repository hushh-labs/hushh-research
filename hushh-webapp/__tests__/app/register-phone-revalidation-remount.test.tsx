import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { PhoneMandatePageContent } from "@/app/register-phone/page";

/**
 * The bug this file exists for.
 *
 * A person entered their number, pressed Send code, and saw "Verification code
 * sent". The OTP screen never appeared -- they were put back on the phone form,
 * forever, and could not finish phone verification at all.
 *
 * Nothing was wrong with the verification flow. The page returned a fullscreen
 * loader whenever `useAuth().loading` was true, which UNMOUNTS
 * PhoneVerificationFlow. Its `step` lives in useState, so the OTP screen was
 * destroyed. And `loading` is not "still booting": the web auth observer sets
 * it true on every re-validation, and starting Firebase phone verification
 * triggers one.
 *
 * So the contract is about identity, not about a revalidation flag: once a user
 * is present, this page must never tear its own subtree down.
 */

const { replace, authState } = vi.hoisted(() => ({
  replace: vi.fn(),
  authState: {
    current: {
      user: { uid: "u1", phoneNumber: null } as Record<string, unknown> | null,
      loading: false,
    },
  },
}));

let mountCount = 0;

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
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

// Stands in for the real flow. It counts mounts and keeps a piece of local
// state, which is exactly what a remount destroys.
vi.mock("@/components/auth/phone-verification-flow", () => ({
  PhoneVerificationFlow: () => {
    const [step, setStep] = useState("phone");
    useEffect(() => {
      mountCount += 1;
    }, []);
    return (
      <div>
        <p>step: {step}</p>
        <button type="button" onClick={() => setStep("code")}>
          Send code
        </button>
      </div>
    );
  },
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: authState.current.user,
    loading: authState.current.loading,
    phoneNumber: null,
    startPhoneVerification: vi.fn(),
    confirmPhoneVerification: vi.fn(),
    refreshUser: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    syncCurrentUser: vi.fn().mockResolvedValue({ phone_verified: false }),
    hasVerifiedPhone: () => false,
  },
}));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingFlowActiveCookie: vi.fn(),
  setOnboardingRequiredCookie: vi.fn(),
}));
vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: vi.fn() },
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: vi.fn(),
    isSetupResolved: () => false,
    syncOnboardingJourney: vi.fn(),
  },
}));
vi.mock("@/lib/services/phone-mandate-service", () => ({
  shouldBypassPhoneMandateForLocalhost: () => false,
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/onboarding/onboarding-journey-phase", () => ({
  resolvePostPhoneOnboardingPhase: () => "setup_hub",
}));

describe("the phone mandate page survives an auth re-validation", () => {
  it("does not unmount the verification flow when loading flips true for a signed-in person", async () => {
    mountCount = 0;
    authState.current = {
      user: { uid: "u1", phoneNumber: null },
      loading: false,
    };

    const view = render(<PhoneMandatePageContent />);
    await screen.findByText("step: phone");
    expect(mountCount).toBe(1);

    // Starting Firebase phone verification republishes auth state, and the web
    // observer sets loading=true while it re-validates the session.
    authState.current = { ...authState.current, loading: true };
    view.rerender(<PhoneMandatePageContent />);

    // The flow must still be on screen. If the page swapped in a loader, the
    // step state is already gone.
    await waitFor(() => {
      expect(screen.queryByText("step: phone")).not.toBeNull();
    });
    expect(screen.queryByText("Loading phone verification...")).toBeNull();

    authState.current = { ...authState.current, loading: false };
    view.rerender(<PhoneMandatePageContent />);
    await screen.findByText("step: phone");

    // One mount for the whole cycle. Two means the OTP screen would have been
    // destroyed mid-verification.
    expect(mountCount).toBe(1);
  });

  it("still shows the loader while no user is present", async () => {
    mountCount = 0;
    authState.current = { user: null, loading: true };

    render(<PhoneMandatePageContent />);
    await screen.findByText("Loading phone verification...");
    expect(mountCount).toBe(0);
  });
  it("clears the pending code when the authenticated owner changes", async () => {
    authState.current = { user: { uid: "owner-a" }, loading: false };
    const view = render(<PhoneMandatePageContent />);
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByText("step: code");
    authState.current = { user: { uid: "owner-b" }, loading: false };
    view.rerender(<PhoneMandatePageContent />);
    await screen.findByText("step: phone");
    expect(screen.queryByText("step: code")).toBeNull();
  });
});
