import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SecretItemsPanel, type SecretPanelItem } from "@/components/secrets/secret-items-panel";

/**
 * The secure Secrets card shows a value only for an unlocked vault, and puts it
 * on the clipboard only after a second, confirming tap.
 */

const VALUE = ["s", "k-proj-", "fakefake0000fakefake9f2a"].join("");
const ITEM: SecretPanelItem = {
  id: "sec_00000000000000a1",
  label: "openai API key ending 9f2a",
  kindLabel: "Key, token or password",
  offer: null,
  filedLabel: null,
};

function panel(overrides: Partial<Parameters<typeof SecretItemsPanel>[0]> = {}) {
  const props = {
    testId: "secret-capture-card",
    title: "Kept in Secrets",
    description: "One knows these only by name.",
    items: [ITEM],
    revealed: {},
    locked: false,
    onReveal: vi.fn(),
    onHide: vi.fn(),
    onUnlock: vi.fn(),
    ...overrides,
  };
  render(<SecretItemsPanel {...props} />);
  return props;
}

describe("SecretItemsPanel", () => {
  it("never shows a value while the vault is locked, and asks to unlock instead (negative control)", () => {
    const props = panel({ locked: true, revealed: { [ITEM.id]: VALUE } });
    expect(screen.queryByText(VALUE)).toBeNull();
    expect(screen.queryByTestId("secret-reveal")).toBeNull();
    fireEvent.click(screen.getByTestId("secret-unlock"));
    expect(props.onUnlock).toHaveBeenCalledTimes(1);
    expect(props.onReveal).not.toHaveBeenCalled();
  });

  it("shows the value an unlocked host decrypted, and copies it only on the second tap", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    panel({ revealed: { [ITEM.id]: VALUE } });
    expect(screen.getByTestId("secret-revealed-value").textContent).toBe(VALUE);

    const copy = screen.getByTestId("secret-copy");
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
    expect(copy.getAttribute("data-copy-state")).toBe("confirm");
    fireEvent.click(copy);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(VALUE));
  });
});
