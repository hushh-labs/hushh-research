import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Sheet,
  SheetContent,
  SheetDescription,
} from "@/components/ui/sheet";

describe("SheetDescription", () => {
  it("renders as a paragraph element", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetDescription>
            Sheet description
          </SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    expect(
      screen.getByText("Sheet description").tagName,
    ).toBe("P");
  });
});