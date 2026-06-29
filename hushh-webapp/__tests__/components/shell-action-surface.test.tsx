import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";

describe("ShellActionSurface", () => {
  it("exposes icon button accessible label", () => {
    render(
      <ShellActionSurface variant="icon" aria-label="Open account actions">
        <span aria-hidden="true">...</span>
      </ShellActionSurface>,
    );

    expect(
      screen.getByRole("button", { name: "Open account actions" }),
    ).toBeTruthy();
  });
});
