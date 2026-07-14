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

  it("uses an opaque, non-animated backdrop for the focused hard gate", () => {
    render(
      <VaultUnlockDialog
        user={user}
        open
        dismissible={false}
        surfaceVariant="hard_gate"
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />
    );

    const overlay = document.querySelector('[data-slot="drawer-overlay"]');
    const content = document.querySelector(
      '[data-vault-unlock-surface="hard_gate"]',
    );

    expect(overlay?.className).toContain("!backdrop-blur-none");
    expect(overlay?.className).toContain("!animate-none");
    expect(overlay?.getAttribute("style")).toContain(
      "background-color: var(--background)",
    );
    expect(overlay?.getAttribute("style")).toContain("opacity: 1");
    expect(overlay?.getAttribute("style")).toContain("animation: none");
    expect(overlay?.getAttribute("style")).toContain("transition: none");
    expect(content).toBeTruthy();
  });

  it("suppresses persistent shell chrome until the last vault surface closes", () => {
    const first = render(
      <VaultUnlockDialog
        user={user}
        open
        surfaceVariant="hard_gate"
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />,
    );
    const second = render(
      <VaultUnlockDialog
        user={user}
        open
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />,
    );

    expect(document.documentElement.hasAttribute("data-vault-unlock-active")).toBe(true);
    expect(document.documentElement.hasAttribute("data-vault-unlock-hard-gate")).toBe(true);
    expect(document.body.hasAttribute("data-vault-unlock-active")).toBe(true);
    expect(document.body.hasAttribute("data-vault-unlock-hard-gate")).toBe(true);

    first.unmount();
    expect(document.documentElement.hasAttribute("data-vault-unlock-active")).toBe(true);
    expect(document.documentElement.hasAttribute("data-vault-unlock-hard-gate")).toBe(false);

    second.unmount();
    expect(document.documentElement.hasAttribute("data-vault-unlock-active")).toBe(false);
    expect(document.body.hasAttribute("data-vault-unlock-active")).toBe(false);
  });
});
