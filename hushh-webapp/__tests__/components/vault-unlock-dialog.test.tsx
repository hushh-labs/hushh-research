import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

vi.mock("@/components/vault/vault-flow", () => ({
  VaultFlow: ({
    onRecoveryKeyDisclosureChange,
    onCreateBusyChange,
    setupPresentation,
  }: {
    onRecoveryKeyDisclosureChange?: (active: boolean) => void;
    onCreateBusyChange?: (busy: boolean) => void;
    setupPresentation?: boolean;
  }) => (
    <div data-testid="vault-flow" data-setup-presentation={setupPresentation ? "true" : undefined}>
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
      <button type="button" onClick={() => onCreateBusyChange?.(true)}>Start creating vault</button>
      <button type="button" onClick={() => onCreateBusyChange?.(false)}>Finish creating vault</button>
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

  it("keeps the one-time key reachable while vault creation is pending", () => {
    const onOpenChange = vi.fn();
    render(
      <VaultUnlockDialog
        user={user}
        open
        dismissible={false}
        setupPresentation
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
        title="Set a lock"
        description="Only you can open what you save."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start creating vault" }));
    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Account actions" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show recovery key" }));
    expect(document.querySelector('[data-setup-v10-stage="recovery"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish creating vault" }));
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Recovery key saved" }));
    expect(document.querySelector('[data-setup-v10-stage="lock"]')).toBeTruthy();
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

  it("uses the setup layout for the real lock and recovery flow", () => {
    const onOpenChange = vi.fn();
    render(
      <VaultUnlockDialog
        user={user}
        open
        dismissible={false}
        setupPresentation
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
        title="Set a lock"
        description="Only you can open what you save."
      />,
    );

    const content = screen.getByRole("dialog", { name: "Set a lock" });
    expect(content).toHaveAttribute("data-setup-v10-vault", "true");
    expect(content).toHaveStyle({ inset: "0", transform: "none" });
    expect(screen.getByTestId("vault-flow")).toHaveAttribute("data-setup-presentation", "true");
    expect(document.querySelector('[data-setup-v10-stage="lock"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show recovery key" }));
    expect(document.querySelector('[data-setup-v10-stage="recovery"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(content).toHaveAttribute("data-vault-dismissible", "false");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("suppresses persistent shell chrome until the last vault surface closes", () => {
    const onStandardOpenChange = vi.fn();
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
        onOpenChange={onStandardOpenChange}
        onSuccess={vi.fn()}
        title="Unlock required"
        description="Unlock your vault before continuing."
      />,
    );

    expect(document.documentElement.hasAttribute("data-vault-unlock-active")).toBe(true);
    expect(document.documentElement.hasAttribute("data-vault-unlock-hard-gate")).toBe(true);
    expect(document.body.hasAttribute("data-vault-unlock-active")).toBe(true);
    expect(document.body.hasAttribute("data-vault-unlock-hard-gate")).toBe(true);
    expect(document.querySelectorAll('[data-vault-unlock-surface]').length).toBe(1);
    expect(onStandardOpenChange).toHaveBeenCalledWith(false);

    first.unmount();
    expect(document.documentElement.hasAttribute("data-vault-unlock-active")).toBe(true);
    expect(document.documentElement.hasAttribute("data-vault-unlock-hard-gate")).toBe(false);

    second.unmount();
    expect(document.documentElement.hasAttribute("data-vault-unlock-active")).toBe(false);
    expect(document.body.hasAttribute("data-vault-unlock-active")).toBe(false);
  });
});
