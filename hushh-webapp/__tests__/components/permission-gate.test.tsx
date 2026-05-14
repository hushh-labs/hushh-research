import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PermissionGate } from "@/components/privacy/permission-gate/permission-gate";

const mockUseVault = vi.fn();

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

describe("PermissionGate", () => {
  it("keeps authorized users on the protected action", () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: true,
      vaultOwnerToken: "HCT:test-token",
    });

    render(
      <PermissionGate permission="portfolio_valuation">
        <button type="button">Connect Portfolio</button>
      </PermissionGate>
    );

    expect(screen.getByRole("button", { name: "Connect Portfolio" })).toBeTruthy();
    expect(screen.queryByTestId("permission-locked-state")).toBeNull();
  });

  it("routes missing vault permission to the current consent surface", () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultOwnerToken: null,
    });

    render(
      <PermissionGate permission="portfolio_valuation">
        <button type="button">Connect Portfolio</button>
      </PermissionGate>
    );

    expect(screen.queryByRole("button", { name: "Connect Portfolio" })).toBeNull();
    expect(screen.getByTestId("permission-locked-state")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review permissions" }).getAttribute("href")).toBe(
      "/consents"
    );
  });
});
