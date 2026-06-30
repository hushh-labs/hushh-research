import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AlertDialog,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

describe("AlertDialogTitle", () => {
  it("renders as a heading element", () => {
    render(
      <AlertDialog open>
        <AlertDialogTitle>
          Alert title
        </AlertDialogTitle>
      </AlertDialog>,
    );

    expect(
      screen.getByText("Alert title").tagName,
    ).toBe("H2");
  });
});