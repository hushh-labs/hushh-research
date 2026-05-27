import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function MockDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div role="dialog" aria-label="Vault dialog">
      <button type="button" onClick={onClose}>
        Close dialog
      </button>
    </div>
  );
}

describe("focus return after dialog close", () => {
  it("preserves trigger focus restoration after dialog close", () => {
    const handleClose = vi.fn();

    render(
      <div>
        <button type="button">Open vault</button>

        <MockDialog
          open
          onClose={handleClose}
        />
      </div>
    );

    const trigger = screen.getByRole("button", {
      name: "Open vault",
    });

    trigger.focus();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close dialog",
      })
    );

    expect(handleClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});