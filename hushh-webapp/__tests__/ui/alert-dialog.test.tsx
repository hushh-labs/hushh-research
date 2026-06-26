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
  it("takes the dialog tier from the layer ladder so it pops above sheets and drawers", () => {
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

    expect(alertContent).toHaveClass("z-(--z-dialog)");
    expect(alertOverlay).toHaveClass("z-(--z-dialog-overlay)");
    // Inline as well, so a caller's className cannot demote it below a sheet.
    expect((alertContent as HTMLElement).style.zIndex).toBe("var(--z-dialog)");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeTruthy();
  });

  it("layers above Sheet when opened from inside a sheet presentation", () => {
    render(
      <div>
        <div data-testid="mock-sheet" className="fixed z-(--z-sheet)" />
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

    expect(sheet).toHaveClass("z-(--z-sheet)");
    expect(alertOverlay).toHaveClass("z-(--z-dialog-overlay)");
    expect(alertContent).toHaveClass("z-(--z-dialog)");
  });

  it("renders action and cancel buttons with their data-slot contracts", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.getByRole("button", { name: /cancel/i }).getAttribute("data-slot")).toBe(
      "alert-dialog-cancel",
    );
    expect(screen.getByRole("button", { name: /continue/i }).getAttribute("data-slot")).toBe(
      "alert-dialog-action",
    );
  });
});
