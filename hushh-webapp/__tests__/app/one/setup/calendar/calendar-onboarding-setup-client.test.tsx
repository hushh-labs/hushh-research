import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  skip: vi.fn(),
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: ({ label }: { label: string }) => <div>{label}</div>,
  useSetupCapabilityCoordinator: () => ({
    isReady: true,
    isSettling: false,
    finish: mocks.finish,
    skip: mocks.skip,
  }),
}));

vi.mock("@/components/calendar/calendar-agent-page", () => ({
  CalendarAgentPage: () => <div>Calendar connection screen</div>,
}));

import { CalendarOnboardingSetupClient } from "@/app/one/setup/calendar/calendar-onboarding-setup-client";
import { capabilityCinematicIntroSessionKey } from "@/components/onboarding/setup/capability-cinematic-intro";

describe("CalendarOnboardingSetupClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("shows the first-visit Calendar introduction before the connection screen", () => {
    render(<CalendarOnboardingSetupClient />);

    expect(
      screen.getByRole("heading", { name: "Stay ahead of your schedule." }),
    ).toBeTruthy();
    expect(screen.getByText("See what's ahead, and make time for what matters.")).toBeTruthy();
    expect(screen.getByText("Find time")).toBeTruthy();
    expect(screen.getByText("Schedule with control")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByText("Calendar connection screen")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Calendar connection screen")).toBeTruthy();
    expect(
      window.sessionStorage.getItem(
        capabilityCinematicIntroSessionKey("calendar"),
      ),
    ).toBe("1");
  });
});
