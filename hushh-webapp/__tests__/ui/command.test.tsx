import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CommandDialog } from "@/components/ui/command";

describe("CommandDialog", () => {
  it("renders the close button by default", () => {
    render(
      <CommandDialog open>
        <div>Command content</div>
      </CommandDialog>,
    );

    expect(
      screen.getByRole("button", { name: /close/i }),
    ).toBeTruthy();
  });

  it("hides the close button when showCloseButton is false", () => {
    render(
      <CommandDialog open showCloseButton={false}>
        <div>Command content</div>
      </CommandDialog>,
    );

    expect(
      screen.queryByRole("button", { name: /close/i }),
    ).toBeNull();
  });
});