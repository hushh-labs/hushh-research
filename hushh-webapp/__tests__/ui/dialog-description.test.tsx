import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogDescription,
} from "@/components/ui/dialog";

describe("DialogDescription", () => {
  it("renders as a paragraph element", () => {
    render(
      <Dialog open>
        <DialogDescription>
          Description text
        </DialogDescription>
      </Dialog>,
    );

    expect(
      screen.getByText("Description text").tagName,
    ).toBe("P");
  });
});