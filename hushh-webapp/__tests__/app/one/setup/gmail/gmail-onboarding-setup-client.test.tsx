import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: () => <div>Gmail setup mounted</div>,
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: ({ label }: { label: string }) => (
    <div role="status" aria-label={label} />
  ),
  useSetupCapabilityCoordinator: () => ({
    finish: vi.fn(),
    isReady: true,
    isSettling: false,
    skip: vi.fn(),
  }),
}));

import { GmailOnboardingSetupClient } from "@/app/one/setup/gmail/gmail-onboarding-setup-client";

describe("GmailOnboardingSetupClient", () => {
  it("mounts Gmail setup when the shared registry enables the capability", () => {
    render(<GmailOnboardingSetupClient />);

    expect(screen.getByText("Gmail setup mounted")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
