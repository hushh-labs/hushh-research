import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSetupCapabilityCoordinator } from "@/components/onboarding/setup/setup-capability-coordinator";

const mocks = vi.hoisted(() => ({
  cachedJourney: null as Record<string, unknown> | null,
  bootstrapState: vi.fn(),
  syncOnboardingJourney: vi.fn(),
  replace: vi.fn(),
  requestNavigation: vi.fn(() => false),
  localActionHandler: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "user-1" }, loading: false }),
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => mocks.cachedJourney,
    bootstrapState: (...args: unknown[]) => mocks.bootstrapState(...args),
    isSetupResolved: (journey: { setupCompleted?: boolean } | null) =>
      journey?.setupCompleted === true,
    syncOnboardingJourney: (...args: unknown[]) =>
      mocks.syncOnboardingJourney(...args),
    syncSetupCapabilities: vi.fn(),
    settleOnboardingCapability: vi.fn(),
  },
}));

vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: (...args: unknown[]) =>
    mocks.localActionHandler(...args),
}));

vi.mock("@/lib/services/capability-tour-service", () => ({
  CapabilityTourService: { markExplored: vi.fn() },
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: (...args: unknown[]) =>
    mocks.requestNavigation(...args),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

function setupJourney(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    setupCompleted: false,
    setupCapabilityIds: [],
    onboardingPhase: "capability_setup",
    onboardingActiveCapability: "location",
    onboardingCallbackState: "none",
    onboardingJourneyUpdatedAt: "journey-v1",
    ...overrides,
  };
}

function renderLocationCoordinator() {
  return renderHook(() =>
    useSetupCapabilityCoordinator({
      capabilityId: "location",
      isOperationallyReady: false,
      finishActionId: "setup.finish_location",
      skipActionId: "setup.skip_location",
      terminalPresentation: "automatic",
    }),
  );
}

function expectTerminalActionsDisabled() {
  const locationCalls = mocks.localActionHandler.mock.calls.filter(
    ([actionId]) =>
      actionId === "setup.finish_location" ||
      actionId === "setup.skip_location",
  );
  expect(locationCalls.length).toBeGreaterThan(0);
  expect(
    locationCalls.every(([, , options]) => options.enabled === false),
  ).toBe(true);
}

describe("setup coordinator completed Location entry", () => {
  beforeEach(() => {
    mocks.cachedJourney = null;
    mocks.bootstrapState.mockReset();
    mocks.syncOnboardingJourney.mockReset();
    mocks.syncOnboardingJourney.mockResolvedValue(undefined);
    mocks.replace.mockReset();
    mocks.requestNavigation.mockReset();
    mocks.requestNavigation.mockReturnValue(false);
    mocks.localActionHandler.mockReset();
  });

  afterEach(cleanup);

  it("acknowledges cached completion without reclaiming the onboarding journey", async () => {
    mocks.cachedJourney = setupJourney({
      setupCapabilityIds: ["location"],
    });

    const { result } = renderLocationCoordinator();

    expect(result.current.isReady).toBe(true);
    expect(result.current.isAlreadyComplete).toBe(true);
    await waitFor(() => expectTerminalActionsDisabled());
    expect(mocks.bootstrapState).not.toHaveBeenCalled();
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("acknowledges cold-bootstrap completion without exposing terminal actions", async () => {
    mocks.bootstrapState.mockResolvedValue(
      setupJourney({ setupCapabilityIds: ["location"] }),
    );

    const { result } = renderLocationCoordinator();

    expect(result.current.isReady).toBe(false);
    await waitFor(() => expect(result.current.isAlreadyComplete).toBe(true));
    expect(result.current.isReady).toBe(true);
    expect(mocks.bootstrapState).toHaveBeenCalledWith("user-1");
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
    expectTerminalActionsDisabled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("keeps the resolved-root handoff to the Location workspace", async () => {
    mocks.bootstrapState.mockResolvedValue(
      setupJourney({
        setupCompleted: true,
        setupCapabilityIds: ["location"],
      }),
    );

    const { result } = renderLocationCoordinator();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/location"));
    expect(result.current.isAlreadyComplete).toBe(false);
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
    expectTerminalActionsDisabled();
  });

  it("continues the authored journey when Location is incomplete", async () => {
    mocks.bootstrapState.mockResolvedValue(
      setupJourney({
        onboardingPhase: "hub",
        onboardingActiveCapability: null,
      }),
    );

    const { result } = renderLocationCoordinator();

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.isAlreadyComplete).toBe(false);
    expect(mocks.syncOnboardingJourney).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        phase: "capability_setup",
        activeCapability: "location",
      }),
    );
  });
});
