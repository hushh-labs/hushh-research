import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

describe("AlertDialogAction", () => {
  it("renders as a button element", () => {
    const { container } = render(
      <AlertDialog open>
        <AlertDialogAction>
          Continue
        </AlertDialogAction>
      </AlertDialog>,
    );

    const el = container.querySelector(
      '[data-slot="alert-dialog-action"]',
    );

    expect(el?.tagName).toBe("BUTTON");
  });
});