import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("renders root with data-slot='switch'", () => {
    const { container } = render(<Switch />);

    expect(container.querySelector('[data-slot="switch"]')).toBeTruthy();
  });

  it("renders thumb with data-slot='switch-thumb'", () => {
    const { container } = render(<Switch />);

    expect(container.querySelector('[data-slot="switch-thumb"]')).toBeTruthy();
  });

  it("defaults to data-size='default'", () => {
    const { container } = render(<Switch />);

    const root = container.querySelector('[data-slot="switch"]');

    expect(root?.getAttribute("data-size")).toBe("default");
  });

  it("propagates size='sm' as data-size='sm'", () => {
    const { container } = render(<Switch size="sm" />);

    const root = container.querySelector('[data-slot="switch"]');

    expect(root?.getAttribute("data-size")).toBe("sm");
  });
});