import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocationOnboardingSetupClient } from "@/app/one/setup/location/location-onboarding-setup-client";

const coordinatorMocks = vi.hoisted(() => ({
  isAlreadyComplete: false,
  returnToSetup: vi.fn(),
  finish: vi.fn(),
  skip: vi.fn(),
}));

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

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

describe("completed Location onboarding re-entry", () => {
  beforeEach(() => {
    coordinatorMocks.isAlreadyComplete = false;
    coordinatorMocks.returnToSetup.mockReset();
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
});
