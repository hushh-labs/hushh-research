import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

describe("AlertDialog", () => {
  it("applies z-[801] to alert dialog content and z-[800] to overlay to pop up above sheets and drawers", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive">
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const alertContent = document.querySelector(
      '[data-slot="alert-dialog-content"]',
    );
    const alertOverlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"]',
    );

    expect(alertContent).toHaveClass("z-[801]");
    expect(alertOverlay).toHaveClass("z-[800]");
    expect((alertContent as HTMLElement).style.zIndex).toBe("801");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeTruthy();
  });

  it("layers above Sheet (z-[712]) when opened from inside a sheet presentation", () => {
    render(
      <div>
        <div data-testid="mock-sheet" className="fixed z-[712]" />
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete account?</AlertDialogTitle>
              <AlertDialogDescription>
                Confirmation dialog on top of sheet.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>,
    );

    const sheet = screen.getByTestId("mock-sheet");
    const alertContent = document.querySelector(
      '[data-slot="alert-dialog-content"]',
    );
    const alertOverlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"]',
    );

    expect(sheet).toHaveClass("z-[712]");
    expect(alertOverlay).toHaveClass("z-[800]");
    expect(alertContent).toHaveClass("z-[801]");
  });
});
