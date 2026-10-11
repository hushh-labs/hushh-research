import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  skip: vi.fn(),
  isInitialSetup: true,
  isReady: true,
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: ({ label }: { label: string }) => <div>{label}</div>,
  useSetupCapabilityCoordinator: () => ({
    isReady: mocks.isReady,
    isInitialSetup: mocks.isInitialSetup,
    isSettling: false,
    finish: mocks.finish,
    skip: mocks.skip,
  }),
}));

vi.mock("@/components/calendar/calendar-agent-page", () => ({
  CalendarAgentPage: ({ onFinishSetup, onSkipSetup }: {
    onFinishSetup: () => void;
    onSkipSetup: () => void;
  }) => (
    <div>
      Calendar connection screen
      <button onClick={onFinishSetup}>Finish Calendar setup</button>
      <button onClick={onSkipSetup}>Skip Calendar setup</button>
    </div>
  ),
}));

import { CalendarOnboardingSetupClient } from "@/app/one/setup/calendar/calendar-onboarding-setup-client";

describe("CalendarOnboardingSetupClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isInitialSetup = true;
    mocks.isReady = true;
  });

  it.each([true, false])("opens Calendar and retains settlement regardless of prior completion (initial=%s)", (isInitialSetup) => {
    mocks.isInitialSetup = isInitialSetup;
    render(<CalendarOnboardingSetupClient />);
    expect(screen.getByText("Calendar connection screen")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Stay ahead of your schedule." })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish Calendar setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip Calendar setup" }));
    expect(mocks.finish).toHaveBeenCalledOnce();
    expect(mocks.skip).toHaveBeenCalledOnce();
  });

  it("waits for setup readiness before opening Calendar", () => {
    mocks.isReady = false;
    render(<CalendarOnboardingSetupClient />);
    expect(screen.getByText("Preparing Calendar setup…")).toBeTruthy();
    expect(screen.queryByText("Calendar connection screen")).toBeNull();
  });
});
