import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Kbd } from "@/components/ui/kbd";

describe("Kbd", () => {
  it("exposes the kbd data-slot contract", () => {
    const { container } = render(<Kbd>⌘K</Kbd>);

    expect(container.querySelector('[data-slot="kbd"]')).not.toBeNull();
  });

  it("renders as a kbd element", () => {
    const { container } = render(<Kbd>⌘K</Kbd>);

    const el = container.querySelector('[data-slot="kbd"]');

    expect(el?.tagName).toBe("KBD");
  });

  it("merges a custom className onto the kbd element", () => {
    const { container } = render(
      <Kbd className="test-class">⌘K</Kbd>,
    );

    const element = container.querySelector('[data-slot="kbd"]');
    expect(
      element?.classList.contains(
        "test-class",
      ),
    ).toBe(true);
  });

});