import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";

describe("FullscreenFlowShell", () => {
  it("renders close button with type='button'", () => {
    render(
      <FullscreenFlowShell onClose={vi.fn()}>
        Content
      </FullscreenFlowShell>,
    );

    expect(
      screen.getByRole("button", { name: "Close" }).getAttribute("type"),
    ).toBe("button");
  });
});
