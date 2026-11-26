import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let workspaceQuery = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => workspaceQuery,
}));

vi.mock("@/components/gmail/gmail-receipts-page", () => ({
  default: ({ forceWorkspace }: { forceWorkspace?: string }) => (
    <div>Gmail workspace: {forceWorkspace || "session"}</div>
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

import OneGmailPageClient from "@/app/one/gmail/gmail-page-client";

describe("OneGmailPageClient", () => {
  beforeEach(() => {
    workspaceQuery = new URLSearchParams();
    replace.mockReset();
  });

  it("mounts Gmail in One when the shared registry enables the agent", async () => {
    render(<OneGmailPageClient />);

    expect(screen.getByText("Gmail workspace: session")).toBeTruthy();
    expect(screen.getByTestId("gmail-vault-prerequisite")).toHaveAttribute(
      "data-route",
      "/one/gmail",
    );
    expect(screen.getByTestId("gmail-vault-prerequisite")).toHaveAttribute(
      "data-label",
      "Mail",
    );
    await waitFor(() => expect(replace).not.toHaveBeenCalled());
  });

  it.each(["followups", "receipts"])("opens the %s tab from a link", (workspace) => {
    workspaceQuery = new URLSearchParams(`workspace=${workspace}`);
    render(<OneGmailPageClient />);
    expect(screen.getByText(`Gmail workspace: ${workspace}`)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("forwards an older workspace=kyc link to the KYC screen, replacing the entry, and mounts no Mail tab", async () => {
    workspaceQuery = new URLSearchParams("workspace=kyc");
    render(<OneGmailPageClient />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/one/kyc"));
    expect(replace).toHaveBeenCalledTimes(1);
    // Mail itself is never mounted for it, so no Mail tab can open and no Mail read can start.
    expect(screen.queryByText(/Gmail workspace:/)).toBeNull();
    expect(screen.queryByTestId("gmail-vault-prerequisite")).toBeNull();
  });

  it("ignores an unsupported workspace query", () => {
    workspaceQuery = new URLSearchParams("workspace=private-inbox");
    render(<OneGmailPageClient />);
    expect(screen.getByText("Gmail workspace: session")).toBeTruthy();
  });
});
