import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
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

  it("renders dialog description content", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
          <DialogDescription>Helpful dialog description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByText("Helpful dialog description")).toBeTruthy();
  });
});