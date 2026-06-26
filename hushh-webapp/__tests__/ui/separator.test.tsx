import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Separator } from "@/components/ui/separator";

describe("Separator", () => {
  it("renders with data-slot='separator'", () => {
    const { container } = render(<Separator />);

    expect(
      container.querySelector('[data-slot="separator"]'),
    ).toBeTruthy();
  });

  it("renders as decorative by default", () => {
    const { container } = render(<Separator />);
    const el = container.querySelector('[data-slot="separator"]');

    expect(el?.getAttribute("role")).toBe("none");
  });

  it("defaults to horizontal orientation", () => {
    const { container } = render(<Separator />);
    const el = container.querySelector('[data-slot="separator"]');

    expect(el?.getAttribute("data-orientation")).toBe("horizontal");
  });

  it("renders with vertical orientation when specified", () => {
    const { container } = render(<Separator orientation="vertical" />);
    const el = container.querySelector('[data-slot="separator"]');

    expect(el?.getAttribute("data-orientation")).toBe("vertical");
  });

  it("renders with role='separator' when decorative={false}", () => {
    const { container } = render(<Separator decorative={false} />);
    const el = container.querySelector('[data-slot="separator"]');

    expect(el?.getAttribute("role")).toBe("separator");
  });

  it("renders as a div element", () => {
    const { container } = render(<Separator />);

    const el = container.querySelector('[data-slot="separator"]');

    expect(el?.tagName).toBe("DIV");
  });

});
