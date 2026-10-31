import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocationOnboardingSetupClient } from "@/app/one/setup/location/location-onboarding-setup-client";

const coordinatorMocks = vi.hoisted(() => ({
  isAlreadyComplete: false,
  returnToSetup: vi.fn(),
  finish: vi.fn(),
  skip: vi.fn(),
}));

import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";

const legacyMocks = vi.hoisted(() => ({ userId: "user_a", runId: null as string | null, get: vi.fn() }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ userId: legacyMocks.userId }) }));
vi.mock("@/components/one-location/onboarding/location-onboarding-interaction-surface", () => ({
  useOptionalOneLocationInteractionSurface: () => legacyMocks.runId ? { currentRun: { runId: legacyMocks.runId } } : null,
}));
vi.mock("@/lib/services/one-location-onboarding-run-client", () => ({ OneLocationOnboardingRunClient: { get: legacyMocks.get } }));

const readinessMocks = vi.hoisted(() => ({ live: false }));

vi.mock("@/app/one/location/page", () => ({
  OneLocationAgentPage: () => (
    <div data-testid="location-onboarding-journey">Location onboarding</div>
  ),
}));

vi.mock("@/components/location/setup/location-setup-flow", () => ({
  LocationSetupFlow: () => (
    <div data-testid="alternate-location-setup">Alternate setup</div>
  ),
}));

vi.mock("@/lib/one-voice/readiness", () => ({
  useOneVoiceLiveEnabled: () => readinessMocks.live,
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: ({ label }: { label: string }) => <div>{label}</div>,
  useSetupCapabilityCoordinator: () => ({
    isReady: true,
    isAlreadyComplete: coordinatorMocks.isAlreadyComplete,
    returnToSetup: coordinatorMocks.returnToSetup,
    operationallyReady: false,
    isSettling: false,
    finish: coordinatorMocks.finish,
    skip: coordinatorMocks.skip,
  }),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {},
}));

vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

describe("completed Location onboarding re-entry", () => {
  beforeEach(() => {
    coordinatorMocks.isAlreadyComplete = false;
    coordinatorMocks.returnToSetup.mockReset();
    coordinatorMocks.finish.mockReset();
    legacyMocks.userId = "user_a";
    legacyMocks.runId = null;
    legacyMocks.get.mockReset();
    readinessMocks.live = false;
  });

  afterEach(() => {
    cleanup();
  });

  it.each([false, true])(
    "keeps the canonical onboarding journey when One Voice Live is %s",
    (live) => {
      readinessMocks.live = live;
      render(<LocationOnboardingSetupClient />);

      expect(screen.getByTestId("location-onboarding-journey")).toBeTruthy();
      expect(screen.queryByTestId("alternate-location-setup")).toBeNull();
      expect(screen.queryByTestId("location-cinematic-intro")).toBeNull();
      expect(
        screen.queryByTestId("location-permission-primer-gate"),
      ).toBeNull();
      expect(screen.queryByTestId("location-onboarding-completed")).toBeNull();
    },
  );

  it("returns to setup immediately without rendering a completion flash", async () => {
    coordinatorMocks.isAlreadyComplete = true;

    render(<LocationOnboardingSetupClient />);

    expect(screen.queryByTestId("location-onboarding-completed")).toBeNull();
    expect(screen.queryByTestId("location-onboarding-journey")).toBeNull();
    expect(
      screen.getByText("Returning to setup..."),
    ).toBeTruthy();

    await waitFor(() => {
      expect(coordinatorMocks.returnToSetup).toHaveBeenCalledTimes(1);
    });
  });
  it("acknowledges legacy finish only from fresh verified server evidence", async () => {
    legacyMocks.runId = "run_aaaaaaaaaaaaaaaa";
    legacyMocks.get.mockResolvedValue({ run: { runId: legacyMocks.runId, status: "verified_succeeded", completionClaimAllowed: true } });
    render(<LocationOnboardingSetupClient />);
    const handler = resolveLocalOnboardingHandler("setup.finish_location")!;
    let result;
    await act(async () => { result = await handler({}); });
    expect(result).toMatchObject({ status: "succeeded" });
    expect(legacyMocks.get).toHaveBeenCalledWith(legacyMocks.runId, { expectedUserId: "user_a" });
    expect(coordinatorMocks.returnToSetup).toHaveBeenCalledOnce();
    expect(coordinatorMocks.finish).not.toHaveBeenCalled();
  });

  it("keeps the legacy finish blocked without verified server completion", async () => {
    legacyMocks.runId = "run_aaaaaaaaaaaaaaaa";
    legacyMocks.get.mockResolvedValue({ run: { runId: legacyMocks.runId, status: "interaction_required", completionClaimAllowed: false } });
    render(<LocationOnboardingSetupClient />);
    const result = await resolveLocalOnboardingHandler("setup.finish_location")!({});
    expect(result.status).toBe("blocked");
    expect(coordinatorMocks.returnToSetup).not.toHaveBeenCalled();
    expect(coordinatorMocks.finish).not.toHaveBeenCalled();
  });

  it("discards a legacy verification response after the owner changes and returns", async () => {
    legacyMocks.runId = "run_aaaaaaaaaaaaaaaa";
    let release!: (result: unknown) => void;
    legacyMocks.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { rerender } = render(<LocationOnboardingSetupClient />);
    const pending = resolveLocalOnboardingHandler("setup.finish_location")!({});
    legacyMocks.userId = "user_b";
    rerender(<LocationOnboardingSetupClient />);
    legacyMocks.userId = "user_a";
    rerender(<LocationOnboardingSetupClient />);
    let result;
    await act(async () => {
      release({ run: { runId: legacyMocks.runId, status: "verified_succeeded", completionClaimAllowed: true } });
      result = await pending;
    });
    expect(result).toMatchObject({ status: "blocked" });
    expect(coordinatorMocks.returnToSetup).not.toHaveBeenCalled();
    expect(coordinatorMocks.finish).not.toHaveBeenCalled();
  });

});
