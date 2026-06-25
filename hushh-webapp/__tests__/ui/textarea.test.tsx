import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Textarea } from "@/components/ui/textarea";

describe("Textarea", () => {
  it("renders with data-slot='textarea'", () => {
    const { container } = render(<Textarea />);

    expect(
      container.querySelector('[data-slot="textarea"]'),
    ).toBeTruthy();
  });

  it("preserves data-slot when textarea props are provided", () => {
    const { container } = render(
      <Textarea placeholder="Write a note" rows={4} />,
    );
    const el = container.querySelector('[data-slot="textarea"]');

    expect(el).toBeTruthy();
    expect(el?.getAttribute("placeholder")).toBe("Write a note");
    expect(el?.getAttribute("rows")).toBe("4");
  });

  it("forwards className to the textarea element", () => {
    const { container } = render(<Textarea className="test-class" />);
    const el = container.querySelector('[data-slot="textarea"]');

    expect(el?.classList.contains("test-class")).toBeTruthy();
  });
});
