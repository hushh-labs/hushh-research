import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

vi.mock("@/components/vault/vault-flow", () => ({
  VaultFlow: ({
    onRecoveryKeyDisclosureChange,
  }: {
    onRecoveryKeyDisclosureChange?: (active: boolean) => void;
  }) => (
    <div data-testid="vault-flow">
      <button
        type="button"
        onClick={() => onRecoveryKeyDisclosureChange?.(true)}
      >
        Show recovery key
      </button>
      <button
        type="button"
        onClick={() => onRecoveryKeyDisclosureChange?.(false)}
      >
        Recovery key saved
      </button>
    </div>
  ),
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

  it("keeps standard credential surfaces dismissible", () => {
    const onOpenChange = vi.fn();

    render(
      <VaultUnlockDialog
        user={user}
        open
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Unlock required" }), {
      key: "Escape",
      code: "Escape",
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks dismissal only while the one-time recovery key is disclosed", () => {
    const onOpenChange = vi.fn();

    render(
      <VaultUnlockDialog
        user={user}
        open
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />,
    );

    const content = screen.getByRole("dialog", { name: "Unlock required" });
    fireEvent.click(
      screen.getByRole("button", { name: "Show recovery key" }),
    );

    expect(content).toHaveAttribute("data-vault-dismissible", "false");
    fireEvent.keyDown(content, { key: "Escape", code: "Escape" });
    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Recovery key saved" }),
    );
    expect(content).toHaveAttribute("data-vault-dismissible", "true");
    fireEvent.keyDown(content, { key: "Escape", code: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
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

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
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

  it("uses a flat top-centered vault layout instead of a keyboard-shifting sheet", () => {
    render(
      <VaultUnlockDialog
        user={user}
        open
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />,
    );

    const content = document.querySelector('[data-vault-unlock-surface="standard"]');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(overlay?.className).toContain("!backdrop-blur-none");
    expect(overlay?.className).not.toContain("!animate-none");
    expect(overlay?.getAttribute("style")).toContain(
      "background-color: var(--background)",
    );
    expect(overlay?.getAttribute("style")).toContain("opacity: 1");
    expect(content).toHaveAttribute("data-vault-layout", "top-centered-flat");
    expect(content).toHaveStyle({ transform: "translateX(-50%)" });
    expect(content).toHaveStyle({ background: "transparent", boxShadow: "none" });
    expect(content?.className).not.toContain("bottom-[var(--kb-height,0px)]");
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
