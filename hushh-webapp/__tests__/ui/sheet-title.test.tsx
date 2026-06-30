import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";

describe("SheetTitle", () => {
  it("renders as a heading element", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>
            Sheet title
          </SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(
      screen.getByText("Sheet title").tagName,
    ).toBe("H2");
  });
});