import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contract for `/one/setup/<capability>` Continue forwarding.
 *
 * Regression history:
 * - The original UAT redirect loop: pressing Continue forwarded into a
 *   hard-gated `/one/*` surface (e.g. `/one/location`) while the MASTER setup
 *   gate was unresolved, so `OneOnboardingGuard` bounced back to `/one/setup`.
 * - The first fix resolved the master gate here (`syncKaiSetupState`), which
 *   introduced a SECOND bug: entering ONE capability marked ALL setup complete,
 *   so the dashboard falsely reported finance complete and cleared its
 *   "Finish setup" bar before the user set anything up (QA-reported).
 *
 * Current contract (the decoupled fix): entering a capability NEVER resolves the
 * account-wide master gate. Instead, hard-gated forwards carry a `?from=/one/setup`
 * marker so `OneOnboardingGuard` allows the setup-originated entry through. The
 * master gate is resolved only by a genuine finish (hub Skip/Continue).
 */

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParamsGet: vi.fn(),
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
  syncOnboardingJourney: vi.fn(),
  bootstrapState: vi.fn(),
  markExplored: vi.fn(),
  loadExploredIds: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => ({ get: mocks.searchParamsGet }),
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
    syncOnboardingJourney: mocks.syncOnboardingJourney,
    bootstrapState: mocks.bootstrapState,
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
    mocks.syncOnboardingJourney.mockResolvedValue(undefined);
    mocks.bootstrapState.mockResolvedValue({ setupCapabilityIds: [] });
    mocks.searchParamsGet.mockReturnValue(null);
  });

  it("forwards into a hard-gated surface with ?from=/one/setup and does NOT resolve the master gate (location)", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="location" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(
        "/one/location?from=/one/setup",
      );
    });
    // The account-wide master gate must NOT be touched by entering a capability.
    expect(mocks.syncKaiSetupState).not.toHaveBeenCalled();
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
  });

  it("does NOT flip the vault profile even when the vault is unlocked (connected-systems)", async () => {
    mocks.vault = {
      vaultKey: "key",
      vaultOwnerToken: "tok",
      isVaultUnlocked: true,
    };

    render(<OneOnboardingCapabilityClient capabilityId="connected-systems" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(
        "/one/connected-systems?from=/one/setup",
      );
    });
    expect(mocks.setOnboardingCompleted).not.toHaveBeenCalled();
    expect(mocks.syncKaiSetupState).not.toHaveBeenCalled();
  });

  it("forwards to the finance wizard (setup surface) without the master gate", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="finance" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(
        expect.stringContaining("/one/setup/kai"),
      );
    });
    // Finance goes to the wizard with a `from=<encoded setup capability route>`
    // marker, NOT the `from=/one/setup` gated-surface marker.
    expect(mocks.replace).not.toHaveBeenCalledWith(
      expect.stringContaining("from=/one/setup"),
    );
    expect(mocks.syncKaiSetupState).not.toHaveBeenCalled();
  });

  it("forwards RIA setup with the hub origin so completion returns to its terminal", async () => {
    render(<OneOnboardingCapabilityClient capabilityId="ria" />);

    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(
        "/ria/onboarding?from=/one/setup",
      );
    });
    expect(mocks.syncKaiSetupState).not.toHaveBeenCalled();
  });

  it("records completion only from the explicit capability finish screen", async () => {
    mocks.searchParamsGet.mockImplementation((key: string) =>
      key === "finish" ? "1" : null,
    );
    mocks.loadExploredIds.mockResolvedValue(["gmail"]);
    mocks.bootstrapState.mockResolvedValue({
      setupCapabilityIds: [],
      onboardingActiveCapability: "gmail",
    });

    render(<OneOnboardingCapabilityClient capabilityId="gmail" />);
    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.syncSetupCapabilities).toHaveBeenCalledWith("user_1", [
        "gmail",
      ]);
      expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith({
        userId: "user_1",
        phase: "setup_hub",
        activeCapability: null,
      });
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    });
  });

  it("rejects a stale or manually-addressed finish route", async () => {
    mocks.searchParamsGet.mockImplementation((key: string) =>
      key === "finish" ? "1" : null,
    );
    mocks.bootstrapState.mockResolvedValue({
      setupCapabilityIds: [],
      onboardingActiveCapability: "finance",
    });

    render(<OneOnboardingCapabilityClient capabilityId="gmail" />);
    fireEvent.click(screen.getByTestId("one-setup-capability-primary"));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    });
    expect(mocks.markExplored).not.toHaveBeenCalled();
    expect(mocks.syncSetupCapabilities).not.toHaveBeenCalled();
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
  });
});
