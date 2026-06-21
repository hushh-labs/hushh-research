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

  it("forwards className to the textarea element", () => {
    const { container } = render(<Textarea className="test-class" />);
    const el = container.querySelector('[data-slot="textarea"]');

    expect(el?.classList.contains("test-class")).toBeTruthy();
  });
});