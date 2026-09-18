import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

describe("DialogContent", () => {
  it("renders the close button by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
  });

  it("hides the close button when showCloseButton is false", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("applies z-[801] to dialog content and z-[800] to dialog overlay to ensure top-layering above sheets", () => {
    render(
      <Dialog open modal>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    const dialogOverlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(dialogContent).toHaveClass("z-[801]");
    expect(dialogOverlay).toHaveClass("z-[800]");
  });
});