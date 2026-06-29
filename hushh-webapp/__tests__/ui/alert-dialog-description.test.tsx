import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AlertDialog,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";

describe("AlertDialogDescription", () => {
  it("renders as a paragraph element", () => {
    render(
      <AlertDialog open>
        <AlertDialogDescription>
          Alert description
        </AlertDialogDescription>
      </AlertDialog>,
    );

    expect(
      screen.getByText("Alert description").tagName,
    ).toBe("P");
  });
});