import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
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
describe("SheetHeader", () => {
  it("renders with data-slot='sheet-header'", () => {
    const { container } = render(<SheetHeader>Header content</SheetHeader>);

    expect(
      container.querySelector('[data-slot="sheet-header"]'),
    ).toBeTruthy();
  });
});

describe("SheetFooter", () => {
  it("renders with data-slot='sheet-footer'", () => {
    const { container } = render(<SheetFooter>Footer content</SheetFooter>);

    expect(
      container.querySelector('[data-slot="sheet-footer"]'),
    ).toBeTruthy();
  });
});