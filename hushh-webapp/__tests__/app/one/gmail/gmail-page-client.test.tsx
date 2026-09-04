import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: () => <div>Gmail workspace</div>,
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

import OneGmailPageClient from "@/app/one/gmail/gmail-page-client";

describe("OneGmailPageClient", () => {
  it("mounts Gmail in One when the shared registry enables the agent", async () => {
    render(<OneGmailPageClient />);

    expect(screen.getByText("Gmail workspace")).toBeTruthy();
    expect(screen.getByTestId("gmail-vault-prerequisite")).toHaveAttribute(
      "data-route",
      "/one/gmail",
    );
    expect(screen.getByTestId("gmail-vault-prerequisite")).toHaveAttribute(
      "data-label",
      "Gmail",
    );
    await waitFor(() => expect(replace).not.toHaveBeenCalled());
  });
});
