import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

vi.mock("@/components/vault/vault-flow", () => ({
  VaultFlow: () => <div data-testid="vault-flow" />,
}));

describe("VaultUnlockDialog", () => {
  const user = { uid: "user_1" } as Parameters<typeof VaultUnlockDialog>[0]["user"];

  it("keeps the unlock dialog accessible with hidden title and description", () => {
    render(
      <VaultUnlockDialog
        user={user}
        open
        onSuccess={vi.fn()}
        title="Unlock your vault"
        description="Enter your passphrase to continue."
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Unlock your vault" });
expect(dialog).toBeTruthy();

const description = screen.getByText("Enter your passphrase to continue.");
expect(description.className).toContain("sr-only");

expect(screen.getByTestId("vault-flow")).toBeTruthy();
  });
});