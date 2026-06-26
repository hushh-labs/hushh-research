import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
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

  it("renders the close control with the dialog-close data-slot contract", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("button", { name: /close/i }).getAttribute("data-slot")).toBe(
      "dialog-close",
    );
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

describe("DialogTitle", () => {
  it("renders with data-slot='dialog-title'", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title text</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(
      document.querySelector('[data-slot="dialog-title"]'),
    ).toBeTruthy();
  });
});
