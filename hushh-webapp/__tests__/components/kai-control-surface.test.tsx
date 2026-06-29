import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

describe("KaiControlSurface", () => {
  it("renders close control with type='button'", () => {
    render(
      <KaiControlSurface open onOpenChange={vi.fn()} title="Kai controls">
        Control body
      </KaiControlSurface>,
    );

    expect(screen.getByRole("button", { name: /close/i }).getAttribute("type")).toBe(
      "button",
    );
  });
});
