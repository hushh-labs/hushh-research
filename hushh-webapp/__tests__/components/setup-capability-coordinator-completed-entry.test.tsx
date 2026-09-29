import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSetupCapabilityCoordinator } from "@/components/onboarding/setup/setup-capability-coordinator";
import { FinanceImportOnboardingSetupClient } from "@/app/one/setup/finance/import/finance-import-onboarding-setup-client";

const mocks = vi.hoisted(() => ({
  cachedJourney: null as Record<string, unknown> | null,
  bootstrapState: vi.fn(),
  syncOnboardingJourney: vi.fn(),
  replace: vi.fn(),
  requestNavigation: vi.fn(() => false),
  localActionHandler: vi.fn(),
  syncSetupCapabilities: vi.fn(),
  syncDeclinedCapabilities: vi.fn(),
  sourceSettler: null as null | ((source: "plaid" | "statement" | "later", attempt?: string) => Promise<boolean>),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
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
    syncSetupCapabilities: (...args: unknown[]) => mocks.syncSetupCapabilities(...args),
    syncDeclinedCapabilities: (...args: unknown[]) => mocks.syncDeclinedCapabilities(...args),
    settleOnboardingCapability: vi.fn(),
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "synthetic-owner-token" }),
}));
vi.mock("@/components/kai/kai-flow", () => ({
  KaiFlow: ({ onSetupSourceSettled }: { onSetupSourceSettled: typeof mocks.sourceSettler }) => {
    mocks.sourceSettler = onSetupSourceSettled;
    return null;
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
    setupCapabilityDeclinedIds: [],
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
    mocks.syncSetupCapabilities.mockReset().mockResolvedValue(undefined);
    mocks.syncDeclinedCapabilities.mockReset().mockResolvedValue(undefined);
    mocks.sourceSettler = null;
    window.history.replaceState(null, "", "/");
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

  it.each(["finish", "skip"] as const)("retains the Finance invitation until durable %s succeeds", async (kind) => {
    const invite = "/circle/join?code=23456789ABCD";
    mocks.cachedJourney = setupJourney({ setupCompleted: true, onboardingActiveCapability: null });
    mocks.bootstrapState.mockResolvedValue(mocks.cachedJourney);
    let complete!: () => void;
    const persist = kind === "finish" ? mocks.syncSetupCapabilities : mocks.syncDeclinedCapabilities;
    persist.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const { result } = renderHook(() => useSetupCapabilityCoordinator({
      capabilityId: "finance", isOperationallyReady: true,
      finishActionId: "setup.finish_finance", skipActionId: "setup.skip_finance", returnTo: invite,
    }));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    let settling!: ReturnType<typeof result.current.finish>;
    act(() => { settling = result.current[kind](); });
    await waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(mocks.requestNavigation).not.toHaveBeenCalled();
    await act(async () => { complete(); await settling; });
    expect(mocks.requestNavigation).toHaveBeenCalledWith(expect.objectContaining({ href: invite }));
    expect((await settling).routeAfter).toBe(invite);
  });

  it.each(["statement", "plaid", "later"] as const)("keeps a deferred %s source on its explicit Finance terminal without reviving the old journey", async (source) => {
    const invite = "/circle/join?invite=opaque_token";
    window.history.replaceState(null, "", "/one/setup/finance/import?return_to=" + encodeURIComponent(invite));
    mocks.cachedJourney = setupJourney({ setupCompleted: true, onboardingActiveCapability: null });
    mocks.bootstrapState.mockResolvedValue(mocks.cachedJourney);
    render(<FinanceImportOnboardingSetupClient />);
    await waitFor(() => expect(mocks.sourceSettler).not.toBeNull());
    await act(async () => { expect(await mocks.sourceSettler?.(source)).toBe(true); });
    expect(mocks.syncOnboardingJourney).not.toHaveBeenCalled();
    expect(mocks.requestNavigation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish Finance setup" }));
    await waitFor(() => expect(mocks.requestNavigation).toHaveBeenCalledWith(expect.objectContaining({ href: invite })));
    expect(mocks.syncSetupCapabilities).toHaveBeenCalledWith("user-1", ["finance"]);
  });

  it("does not leave Finance for the invitation when durable completion fails", async () => {
    mocks.cachedJourney = setupJourney({ setupCompleted: true, onboardingActiveCapability: null });
    mocks.bootstrapState.mockResolvedValue(mocks.cachedJourney);
    mocks.syncSetupCapabilities.mockRejectedValue(new Error("synthetic save failure"));
    const { result } = renderHook(() => useSetupCapabilityCoordinator({
      capabilityId: "finance", isOperationallyReady: true,
      finishActionId: "setup.finish_finance", skipActionId: "setup.skip_finance",
      returnTo: "/circle/join?invite=opaque_token",
    }));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await act(async () => { expect((await result.current.finish()).status).toBe("failed"); });
    expect(mocks.requestNavigation).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
