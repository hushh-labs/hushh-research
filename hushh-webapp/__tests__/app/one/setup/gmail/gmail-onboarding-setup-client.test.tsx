import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParamsGet: vi.fn(),
  user: { uid: "user_1" } as { uid: string } | null,
  authLoading: false,
  bootstrapState: vi.fn(),
  isSetupResolved: vi.fn(),
  syncOnboardingJourney: vi.fn(),
  settleOnboardingCapability: vi.fn(),
  syncSetupCapabilities: vi.fn(),
  markExplored: vi.fn(),
  loadExploredIds: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => ({ get: mocks.searchParamsGet }),
  usePathname: () => "/one/setup/gmail",
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: mocks.user, loading: mocks.authLoading }),
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: mocks.bootstrapState,
    isSetupResolved: mocks.isSetupResolved,
    syncOnboardingJourney: mocks.syncOnboardingJourney,
    settleOnboardingCapability: mocks.settleOnboardingCapability,
    syncSetupCapabilities: mocks.syncSetupCapabilities,
  },
}));

vi.mock("@/lib/services/capability-tour-service", () => ({
  CapabilityTourService: {
    markExplored: mocks.markExplored,
    loadExploredIds: mocks.loadExploredIds,
  },
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: ({
    onConnectionStateChange,
    onFinishSetup,
    onSkipSetup,
  }: {
    onConnectionStateChange: (connected: boolean) => void;
    onFinishSetup: () => void;
    onSkipSetup: () => void;
  }) => (
    <div>
      <button onClick={() => onConnectionStateChange(true)}>Connect</button>
      <button onClick={onFinishSetup}>Finish Gmail setup</button>
      <button onClick={onSkipSetup}>Skip Gmail setup</button>
    </div>
  ),
}));

import { GmailOnboardingSetupClient } from "@/app/one/setup/gmail/gmail-onboarding-setup-client";

const activeGmailJourney = {
  onboardingActiveCapability: "gmail",
  setupCapabilityIds: [],
};

describe("GmailOnboardingSetupClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { uid: "user_1" };
    mocks.authLoading = false;
    mocks.searchParamsGet.mockReturnValue(null);
    mocks.isSetupResolved.mockReturnValue(false);
    mocks.bootstrapState.mockResolvedValue({
      onboardingActiveCapability: null,
      setupCapabilityIds: [],
    });
    mocks.syncOnboardingJourney.mockResolvedValue(undefined);
    mocks.settleOnboardingCapability.mockResolvedValue(undefined);
    mocks.syncSetupCapabilities.mockResolvedValue(undefined);
    mocks.markExplored.mockResolvedValue(undefined);
    mocks.loadExploredIds.mockResolvedValue([]);
  });

  it("claims the Gmail setup goal and keeps its workspace inside setup", async () => {
    render(<GmailOnboardingSetupClient />);

    await waitFor(() => {
      expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          phase: "capability_setup",
          activeCapability: "gmail",
          callbackState: "none",
        }),
      );
    });
    expect(mocks.replace).not.toHaveBeenCalledWith("/one/gmail");
  });

  it("finishes only after Gmail reports a verified connection", async () => {
    mocks.bootstrapState.mockResolvedValue(activeGmailJourney);
    render(<GmailOnboardingSetupClient />);

    await screen.findByText("Connect");
    fireEvent.click(screen.getByText("Finish Gmail setup"));
    expect(mocks.syncSetupCapabilities).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Connect"));
    fireEvent.click(screen.getByText("Finish Gmail setup"));

    await waitFor(() => {
      expect(mocks.settleOnboardingCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          capabilityId: "gmail",
          completedCapabilityIds: ["gmail"],
          callbackState: "succeeded",
        }),
      );
      expect(mocks.syncOnboardingJourney).not.toHaveBeenCalledWith({
        userId: "user_1",
        phase: "setup_hub",
        activeCapability: null,
        callbackState: "succeeded",
      });
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    });
  });

  it("skips an unfinished Gmail setup without recording it as complete", async () => {
    mocks.bootstrapState.mockResolvedValue(activeGmailJourney);
    render(<GmailOnboardingSetupClient />);

    await screen.findByText("Skip Gmail setup");
    fireEvent.click(screen.getByText("Skip Gmail setup"));

    await waitFor(() => {
      expect(mocks.syncSetupCapabilities).not.toHaveBeenCalled();
      expect(mocks.settleOnboardingCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          capabilityId: "gmail",
          callbackState: "none",
        }),
      );
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    });
  });

  it("keeps a correlated callback completion-ready until the visible finish action", async () => {
    mocks.searchParamsGet.mockReturnValue("1");
    mocks.bootstrapState.mockResolvedValue(activeGmailJourney);
    render(<GmailOnboardingSetupClient />);

    await screen.findByText("Connect");
    expect(mocks.syncSetupCapabilities).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Connect"));
    expect(mocks.syncSetupCapabilities).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Finish Gmail setup"));
    await waitFor(() => {
      expect(mocks.settleOnboardingCapability).toHaveBeenCalledWith(
        expect.objectContaining({ completedCapabilityIds: ["gmail"] }),
      );
    });
  });
});
