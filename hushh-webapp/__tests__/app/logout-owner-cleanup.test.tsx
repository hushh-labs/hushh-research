import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  publishPendingAuthSessionIdentity,
  publishValidatedAuthSessionOwner,
  publishValidatedAuthSessionPrincipal,
} from "@/lib/auth/session-owner";

const FIREBASE_UID = "firebase-uid-1";
const REPLACEMENT_OWNER = `acct_${"a".repeat(32)}`;

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  onAuthSignedOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({ registerSteps: vi.fn(), completeStep: vi.fn(), reset: vi.fn() }),
}));
vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/app-ui/hushh-loader", () => ({ HushhLoader: () => null }));
vi.mock("@/lib/firebase/config", () => ({ auth: { currentUser: { uid: "firebase-uid-1" } } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { signOut: mocks.signOut } }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { deleteSession: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/lib/utils/session-storage", () => ({
  clearLocalStorage: vi.fn(),
  clearLocalStorageKeys: vi.fn(),
  clearSessionStorage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onAuthSignedOut: mocks.onAuthSignedOut },
}));
vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    clearMarketingSeen: vi.fn().mockResolvedValue(undefined),
    markForceIntroOnce: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingFlowActiveCookie: vi.fn(),
  setOnboardingRequiredCookie: vi.fn(),
}));

import LogoutPage from "@/app/logout/page";

describe("logout device cleanup ownership", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    mocks.signOut.mockReset().mockResolvedValue(undefined);
    mocks.onAuthSignedOut.mockReset();
    Object.defineProperty(window, "location", { configurable: true, value: { replace: vi.fn() } });
  });

  afterEach(() => {
    publishValidatedAuthSessionOwner(null);
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("clears a start-fresh account's device state under its owner, not its Firebase UID", async () => {
    publishValidatedAuthSessionPrincipal({
      firebaseUid: FIREBASE_UID,
      ownerId: REPLACEMENT_OWNER,
      accountGeneration: 1,
    });

    render(<LogoutPage />);

    await waitFor(() => expect(mocks.onAuthSignedOut).toHaveBeenCalled());
    expect(mocks.signOut).toHaveBeenCalledWith(REPLACEMENT_OWNER);
    expect(mocks.onAuthSignedOut).toHaveBeenCalledWith(REPLACEMENT_OWNER);
    expect(mocks.onAuthSignedOut).not.toHaveBeenCalledWith(FIREBASE_UID);
  });

  it("still cleans up under a start-fresh owner that re-verification withdrew", async () => {
    publishValidatedAuthSessionPrincipal({
      firebaseUid: FIREBASE_UID,
      ownerId: REPLACEMENT_OWNER,
      accountGeneration: 1,
    });
    publishPendingAuthSessionIdentity(FIREBASE_UID);

    render(<LogoutPage />);

    await waitFor(() => expect(mocks.onAuthSignedOut).toHaveBeenCalled());
    expect(mocks.signOut).toHaveBeenCalledWith(REPLACEMENT_OWNER);
    expect(mocks.onAuthSignedOut).toHaveBeenCalledWith(REPLACEMENT_OWNER);
  });

  it("keeps an original account keyed by its Firebase UID", async () => {
    publishValidatedAuthSessionOwner(FIREBASE_UID);

    render(<LogoutPage />);

    await waitFor(() => expect(mocks.onAuthSignedOut).toHaveBeenCalledWith(FIREBASE_UID));
    expect(mocks.signOut).toHaveBeenCalledWith(FIREBASE_UID);
  });
});
