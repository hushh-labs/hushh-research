import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCATION_COMPLETION_RETURN_DELAY_MS,
  LocationOnboardingSetupClient,
} from "@/app/one/setup/location/location-onboarding-setup-client";

const coordinatorMocks = vi.hoisted(() => ({
  isAlreadyComplete: false,
  returnToSetup: vi.fn(),
  finish: vi.fn(),
  skip: vi.fn(),
}));

vi.mock("@/app/one/location/page", () => ({
  default: () => (
    <div data-testid="location-onboarding-journey">Location onboarding</div>
  ),
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: () => <div>Preparing location setup…</div>,
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
    vi.useFakeTimers();
    coordinatorMocks.isAlreadyComplete = false;
    coordinatorMocks.returnToSetup.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the full onboarding journey for an incomplete Location setup", () => {
    render(<LocationOnboardingSetupClient />);

    expect(screen.getByTestId("location-onboarding-journey")).toBeTruthy();
    expect(screen.queryByTestId("location-cinematic-intro")).toBeNull();
    expect(screen.queryByTestId("location-permission-primer-gate")).toBeNull();
    expect(screen.queryByTestId("location-onboarding-completed")).toBeNull();
  });

  it("shows only the completion screen and returns to setup after the delay", () => {
    coordinatorMocks.isAlreadyComplete = true;

    render(<LocationOnboardingSetupClient />);

    expect(
      screen.getByRole("heading", {
        name: "Your Location onboarding is complete",
      }),
    ).toBeTruthy();
    const completedScreen = screen.getByTestId("location-onboarding-completed");
    expect(
      completedScreen.getAttribute("data-fullscreen-flow-shell-width"),
    ).toBe("reading");
    const returnButton = screen.getByRole("button", {
      name: "Back to setup",
    });
    expect(returnButton.className).toContain("min-h-14");
    expect(returnButton.parentElement?.className).toContain("max-w-[30rem]");
    expect(screen.queryByTestId("location-cinematic-intro")).toBeNull();
    expect(screen.queryByTestId("location-onboarding-journey")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LOCATION_COMPLETION_RETURN_DELAY_MS - 1);
    });
    expect(coordinatorMocks.returnToSetup).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(coordinatorMocks.returnToSetup).toHaveBeenCalledTimes(1);
  });

  it("clears the automatic return when the screen unmounts", () => {
    coordinatorMocks.isAlreadyComplete = true;
    const { unmount } = render(<LocationOnboardingSetupClient />);

    unmount();
    act(() => {
      vi.advanceTimersByTime(LOCATION_COMPLETION_RETURN_DELAY_MS);
    });

    expect(coordinatorMocks.returnToSetup).not.toHaveBeenCalled();
  });

  it("lets the user return immediately without a second timer navigation", () => {
    coordinatorMocks.isAlreadyComplete = true;
    render(<LocationOnboardingSetupClient />);

    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));
    expect(coordinatorMocks.returnToSetup).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(LOCATION_COMPLETION_RETURN_DELAY_MS);
    });
    expect(coordinatorMocks.returnToSetup).toHaveBeenCalledTimes(1);
  });
});
