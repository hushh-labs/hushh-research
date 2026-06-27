import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("respects default checked state", () => {
    render(<Switch defaultChecked />);

    expect(screen.getByRole("switch").getAttribute("data-state")).toBe(
      "checked",
    );
  });

  it("reflects controlled checked state with aria-checked", () => {
    const { rerender } = render(<Switch checked={false} />);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );

    rerender(<Switch checked />);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("renders thumb with data-slot='switch-thumb'", () => {
    const { container } = render(<Switch />);

    expect(
      container
        .querySelector('[data-slot="switch-thumb"]')
        ?.getAttribute("data-slot"),
    ).toBe("switch-thumb");
  });

  it("propagates className to the underlying element", () => {
    const { container } = render(<Switch className="test-class" />);

    const el = container.querySelector('[data-slot="switch"]');
    
    expect(el?.classList.contains("test-class")).toBe(true);
  });
});
