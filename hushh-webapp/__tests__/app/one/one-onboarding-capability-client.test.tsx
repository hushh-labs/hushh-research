import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for the UAT redirect loop: tapping a setup-hub tile, then pressing
 * Continue on `/one/setup/<capability>`, forwarded into a hard-gated `/one/*`
 * surface (e.g. `/one/location`) while the MASTER setup gate was still
 * unresolved — so `OneOnboardingGuard` bounced the user straight back to
 * `/one/setup`. The fix resolves the master gate before forwarding into a
 * hard-gated surface, while leaving setup-surface forwards (finance wizard) and
 * off-`/one` forwards (consent) untouched.
 */

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  user: { uid: "user_1" } as { uid: string } | null,
  vault: {
    vaultKey: null as string | null,
    vaultOwnerToken: null as string | null,
    isVaultUnlocked: false,
  },
  syncKaiSetupState: vi.fn(),
  setOnboardingCompleted: vi.fn(),
  markSeen: vi.fn(),
  syncSetupCapabilities: vi.fn(),
  markExplored: vi.fn(),
  loadExploredIds: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mocks.vault,
}));

vi.mock("@/lib/services/one-setup-gate-service", () => ({
  OneSetupGateService: { markSeen: mocks.markSeen },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    syncKaiSetupState: mocks.syncKaiSetupState,
    syncSetupCapabilities: mocks.syncSetupCapabilities,
  },
}));

vi.mock("@/lib/services/kai-profile-service", () => ({
  KaiProfileService: { setOnboardingCompleted: mocks.setOnboardingCompleted },
}));

vi.mock("@/lib/services/capability-tour-service", () => ({
  CapabilityTourService: {
    markExplored: mocks.markExplored,
    loadExploredIds: mocks.loadExploredIds,
  },
}));

// The presentational step renders a primary CTA; we only need the button.
vi.mock("@/components/onboarding/setup/onboarding-capability-step", () => ({
  OnboardingCapabilityStep: ({ onPrimary }: { onPrimary: () => void }) => (
    <button data-testid="one-setup-capability-primary" onClick={onPrimary}>
      Continue
    </button>
  ),
}));

import { OneOnboardingCapabilityClient } from "@/app/one/setup/[capability]/one-onboarding-capability-client";

describe("OneOnboardingCapabilityClient — Continue forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { uid: "user_1" };
    mocks.vault = {
      vaultKey: null,
      vaultOwnerToken: null,
      isVaultUnlocked: false,
    };
    mocks.syncKaiSetupState.mockResolvedValue(undefined);
    mocks.setOnboardingCompleted.mockResolvedValue(undefined);
    mocks.loadExploredIds.mockResolvedValue([]);
    mocks.markExplored.mockResolvedValue(undefined);
    mocks.syncSetupCapabilities.mockResolvedValue(undefined);
  });

  it("resolves the master setup gate before forwarding into a hard-gated surface (location)", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="location" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.syncKaiSetupState).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          completed: true,
          skipped: false,
        }),
      );
    });
    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/one/location");
    });
  });

  it("also flips the vault profile when the vault is unlocked", async () => {
    mocks.vault = {
      vaultKey: "key",
      vaultOwnerToken: "tok",
      isVaultUnlocked: true,
    };

    render(<OneOnboardingCapabilityClient capabilityId="connected-systems" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.setOnboardingCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          vaultKey: "key",
          vaultOwnerToken: "tok",
          skippedPreferences: false,
        }),
      );
    });
    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/one/connected-systems");
    });
  });

  it("does NOT resolve the master gate when forwarding to the finance wizard (setup surface)", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="finance" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(
        expect.stringContaining("/one/setup/kai"),
      );
    });
    expect(mocks.syncKaiSetupState).not.toHaveBeenCalled();
  });

  it("does NOT resolve the master gate when forwarding off /one/* (consent)", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="consent" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/consents?tab=pending");
    });
    expect(mocks.syncKaiSetupState).not.toHaveBeenCalled();
  });
});
