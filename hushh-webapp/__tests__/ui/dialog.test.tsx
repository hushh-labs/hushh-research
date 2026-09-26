import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

describe("DialogContent", () => {
  it("is modal by default so its canonical scrim is present", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Blocking dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "[backdrop-filter:var(--app-scrim-filter)]",
    );
  });

  it("renders the close button by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /close/i })).toHaveClass("size-11");
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

  it("takes the dialog tier from the layer ladder so it sits above sheets", () => {
    render(
      <Dialog open modal>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    const dialogOverlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(dialogContent).toHaveClass("z-(--z-dialog)");
    expect(dialogOverlay).toHaveClass("z-(--z-dialog-overlay)");
  });

  it("renders CountryPicker dialog surface above DialogOverlay", () => {
    render(
      <Dialog open modal>
        <DialogContent className="surface translate-x-0 translate-y-0">
          <DialogTitle>Select country</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    const dialogOverlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(dialogContent).toHaveClass("z-(--z-dialog)");
    expect(dialogOverlay).toHaveClass("z-(--z-dialog-overlay)");
  });
});
