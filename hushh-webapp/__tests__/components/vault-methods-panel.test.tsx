import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultMethodsPanel } from "@/components/profile/vault-methods-panel";
import type { VaultWrapper } from "@/lib/services/vault-service";

describe("Vault methods privacy and mutation authority", () => {
  it("keeps credential identifiers private and viewing methods cannot mutate them", () => {
    const make = (id: string): VaultWrapper => ({ method: "generated_default_web_prf", wrapperId: id,
      encryptedVaultKey: "synthetic-ciphertext", salt: "synthetic-salt", iv: "synthetic-iv",
      passkeyCredentialId: `credential-${id}`, passkeyDeviceLabel: "Browser passkey", passkeyRpId: "example.test" });
    const first = make("private-wrapper-first");
    const second = make("private-wrapper-second");
    const select = vi.fn(); const remove = vi.fn();
    const props = { wrappers: [first, second], primaryMethod: first.method, primaryWrapperId: first.wrapperId!,
      mutable: true, busy: false, needsRefresh: false, onSelect: select, onRemove: remove,
      onChangePassphrase: vi.fn(), onRefresh: vi.fn() };
    const view = render(createElement(VaultMethodsPanel, props));
    fireEvent.click(screen.getByRole("button", { name: "Browser passkey 2" }));
    const details = screen.getByRole("dialog");
    expect(document.body.innerHTML).not.toContain("private-wrapper");
    expect(document.body.innerHTML).not.toContain("credential-");
    expect(select).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(details).getByRole("button", { name: "Remove passkey" }));
    expect(remove).toHaveBeenCalledExactlyOnceWith(second);
    view.rerender(createElement(VaultMethodsPanel, { ...props, mutable: false }));
    fireEvent.click(screen.getByRole("button", { name: "Browser passkey 2" }));
    expect(screen.getByRole("button", { name: "Remove passkey" })).toBeDisabled();
    expect(select).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledOnce();
    view.unmount();
  });
});
