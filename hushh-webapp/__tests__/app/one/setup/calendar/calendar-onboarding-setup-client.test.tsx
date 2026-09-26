import { render, screen } from "@testing-library/react";
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

describe("CalendarOnboardingSetupClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("opens the connection screen on first entry without a redundant introduction", () => {
    render(<CalendarOnboardingSetupClient />);
    expect(screen.getByText("Calendar connection screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByText("Stay ahead of your schedule.")).toBeNull();
  });
});
