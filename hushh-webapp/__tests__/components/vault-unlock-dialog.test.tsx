import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

vi.mock("@/components/vault/vault-flow", () => ({
  VaultFlow: () => <div data-testid="vault-flow" />,
}));

describe("VaultUnlockDialog", () => {
  const user = { uid: "user_1" } as Parameters<typeof VaultUnlockDialog>[0]["user"];

  it("keeps locked vault unlock dialogs open on Escape when not dismissible", () => {
    const onOpenChange = vi.fn();

    render(
      <VaultUnlockDialog
        user={user}
        open
        dismissible={false}
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Unlock required" }), {
      key: "Escape",
      code: "Escape",
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});