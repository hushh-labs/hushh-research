import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const capability = vi.hoisted(() => ({ enabled: true }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/lib/onboarding/one-capabilities", () => ({
  isOneCapabilityEnabled: () => capability.enabled,
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: ({ surface, forceWorkspace }: { surface?: string; forceWorkspace?: string }) => (
    <div>
      Mail page surface: {surface || "mail"} / {forceWorkspace || "no workspace"}
    </div>
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
    <div data-testid="kyc-vault-prerequisite" data-label={capabilityLabel} data-route={routeKey}>
      {children}
    </div>
  ),
}));

import OneKycPageClient from "@/app/one/kyc/kyc-page-client";

describe("OneKycPageClient", () => {
  beforeEach(() => {
    capability.enabled = true;
    replace.mockReset();
  });

  it("opens the KYC screen, not a Mail tab, behind the vault boundary at its own route", async () => {
    render(<OneKycPageClient />);

    // The KYC flow on the one Mail connection: it is not given a Mail workspace to land on.
    expect(screen.getByText("Mail page surface: kyc / no workspace")).toBeTruthy();
    expect(screen.getByTestId("kyc-vault-prerequisite")).toHaveAttribute("data-route", "/one/kyc");
    expect(screen.getByTestId("kyc-vault-prerequisite")).toHaveAttribute("data-label", "KYC");
    await waitFor(() => expect(replace).not.toHaveBeenCalled());
  });

  it("returns to One without mounting anything when the Mail capability is paused", async () => {
    capability.enabled = false;
    render(<OneKycPageClient />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/one"));
    expect(screen.queryByTestId("kyc-vault-prerequisite")).toBeNull();
  });
});
