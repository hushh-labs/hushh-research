import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConnectedSystemDetailClient } from "@/app/one/connected-systems/[systemId]/connected-system-detail-client";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "user-1",
      displayName: "Person",
      email: "person@example.test",
    },
    phoneNumber: "+14155550100",
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "HCT:test" }),
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));

vi.mock("@/components/profile/connected-systems-panel", () => ({
  ConnectedSystemsPanel: ({
    onSystemResolved,
  }: {
    onSystemResolved?: (system: { displayName: string }) => void;
  }) => {
    useEffect(() => {
      onSystemResolved?.({ displayName: "Customer CRM" });
    }, [onSystemResolved]);
    return <div>CRM body</div>;
  },
}));

describe("ConnectedSystemDetailClient", () => {
  it("lets the breadcrumb own the Connected Systems list-page context", () => {
    const source = readFileSync(
      join(process.cwd(), "app/one/connected-systems/page.tsx"),
      "utf8",
    );

    expect(source).not.toContain("<PageHeader");
    expect(source).not.toContain(
      "Set up and manage profiles with your connected CRM systems.",
    );
  });

  it("uses the CRM name as the only route header", async () => {
    render(<ConnectedSystemDetailClient systemId="customer-crm" />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Customer CRM" }),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByRole("heading", { name: "Connected system" }),
    ).toBeNull();
    expect(screen.getAllByText("Customer CRM")).toHaveLength(1);
  });
});
