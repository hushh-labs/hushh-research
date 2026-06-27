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

  it("preserves data-slot='input' when type is set", () => {
    const { container } = render(<Input type="search" />);

    expect(
      container.querySelector('input[type="search"][data-slot="input"]'),
    ).toBeTruthy();
  });

  it("forwards className to the input element", () => {
    const { container } = render(<Input className="test-class" />);
    const el = container.querySelector('[data-slot="input"]');

    expect(el?.classList.contains("test-class")).toBeTruthy();
  });

  it("does not force autoCapitalize='none' for type='text'", () => {
    const { container } = render(<Input type="text" />);

    const el = container.querySelector('[data-slot="input"]');

    expect(el?.getAttribute("autocapitalize")).not.toBe("none");
  });

  it("renders as an input element", () => {
    const { container } = render(<Input />);

    const el = container.querySelector('[data-slot="input"]');

    expect(el?.tagName).toBe("INPUT");
  });

});
