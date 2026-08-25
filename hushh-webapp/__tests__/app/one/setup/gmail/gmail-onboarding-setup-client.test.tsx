import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: () => <div>Gmail setup workspace</div>,
}));

vi.mock("@/components/onboarding/setup/capability-cinematic-intro", () => ({
  CapabilityCinematicIntroGate: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/vault/capability-vault-prerequisite", () => ({
  CapabilityVaultPrerequisite: ({
    capabilityLabel,
    routeKey,
    children,
  }: {
    capabilityLabel: string;
    routeKey: string;
    children: ReactNode;
  }) => (
    <div data-testid="gmail-vault-prerequisite" data-label={capabilityLabel} data-route={routeKey}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: () => <div>Loading Gmail setup</div>,
  useSetupCapabilityCoordinator: () => ({
    isReady: true,
    isSettling: false,
    finish: vi.fn(),
    skip: vi.fn(),
  }),
}));

import { GmailOnboardingSetupClient } from "@/app/one/setup/gmail/gmail-onboarding-setup-client";

describe("GmailOnboardingSetupClient", () => {
  it("mounts the Gmail setup workspace when the agent is enabled", async () => {
    render(<GmailOnboardingSetupClient />);

    expect(screen.getByText("Gmail setup workspace")).toBeTruthy();
    expect(screen.getByTestId("gmail-vault-prerequisite")).toHaveAttribute(
      "data-route",
      "/one/setup/gmail",
    );
    expect(screen.getByTestId("gmail-vault-prerequisite")).toHaveAttribute(
      "data-label",
      "Gmail",
    );
    await waitFor(() => expect(replace).not.toHaveBeenCalled());
  });
});
