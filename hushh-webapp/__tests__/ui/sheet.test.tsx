import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";

describe("SheetContent", () => {
  it("renders the close button by default", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Test sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(
      screen.getByRole("button", { name: /close/i }),
    ).toBeTruthy();
  });

  it("hides the close button when showCloseButton is false", () => {
    render(
      <Sheet open>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Test sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByText("Test sheet")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /close/i }),
    ).toBeNull();
  });
});