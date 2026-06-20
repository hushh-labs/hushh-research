import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("renders with data-slot='input'", () => {
    const { container } = render(<Input />);

    expect(
      container.querySelector('[data-slot="input"]'),
    ).toBeTruthy();
  });

  it("forwards className to the input element", () => {
    const { container } = render(<Input className="test-class" />);
    const el = container.querySelector('[data-slot="input"]');

    expect(el?.classList.contains("test-class")).toBeTruthy();
  });
});