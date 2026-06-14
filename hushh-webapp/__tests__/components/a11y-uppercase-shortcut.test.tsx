import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function ShortcutButton({ onShortcut }: { onShortcut: () => void }) {
  return (
    <button
      type="button"
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === "k" && event.ctrlKey) {
          onShortcut();
        }
      }}
    >
      Open command menu
    </button>
  );
}

describe("a11y uppercase shortcut stability", () => {
  it("preserves Ctrl+K shortcut behavior for uppercase key events", () => {
    const handleShortcut = vi.fn();

    render(<ShortcutButton onShortcut={handleShortcut} />);

    fireEvent.keyDown(screen.getByRole("button"), {
      key: "K",
      ctrlKey: true,
    });

    expect(handleShortcut).toHaveBeenCalledTimes(1);
  });
});