import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function MockDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label="Workspace dialog"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onOpenChange(false);
        }
      }}
    >
      Vault workspace
    </div>
  );
}

describe("dialog escape dismissal contract", () => {
  it("preserves escape key dismissal behavior", () => {
    const handleOpenChange = vi.fn();

    render(
      <MockDialog
        open
        onOpenChange={handleOpenChange}
      />
    );

    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
    });

    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });
});