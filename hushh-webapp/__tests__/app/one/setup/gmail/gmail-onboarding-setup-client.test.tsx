import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: ({
    finishingSetup,
    onConnectionStateChange,
    onFinishSetup,
  }: {
    finishingSetup?: boolean;
    onConnectionStateChange?: (connected: boolean) => void;
    onFinishSetup?: () => void;
  }) => (
    <div>
      <div>Gmail setup mounted</div>
      <button
        type="button"
        onClick={() => onConnectionStateChange?.(true)}
      >
        Mark Gmail connected
      </button>
      <button
        type="button"
        aria-busy={finishingSetup ? "true" : "false"}
        onClick={onFinishSetup}
      >
        Finish Gmail setup
      </button>
    </div>
  ),
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: ({ label }: { label: string }) => (
    <div role="status" aria-label={label} />
  ),
  useSetupCapabilityCoordinator: () => ({
    finish: mocks.finish,
    isReady: true,
    isSettling: false,
    skip: vi.fn(),
  }),
}));

import { GmailOnboardingSetupClient } from "@/app/one/setup/gmail/gmail-onboarding-setup-client";

describe("GmailOnboardingSetupClient", () => {
  beforeEach(() => {
    mocks.finish.mockReset();
    mocks.finish.mockResolvedValue({
      status: "succeeded",
      summary: "Setup is complete. Returning to setup.",
      routeAfter: "/one/setup",
    });
    mocks.replace.mockReset();
  });

  it("mounts Gmail setup when the shared registry enables the capability", () => {
    render(<GmailOnboardingSetupClient />);

    expect(screen.getByText("Gmail setup mounted")).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("routes away immediately when finishing connected Gmail setup", () => {
    render(<GmailOnboardingSetupClient />);

    fireEvent.click(screen.getByRole("button", { name: "Mark Gmail connected" }));
    const finishButton = screen.getByRole("button", {
      name: "Finish Gmail setup",
    });
    fireEvent.click(finishButton);

    expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    expect(finishButton).toHaveAttribute("aria-busy", "false");
  });
});
