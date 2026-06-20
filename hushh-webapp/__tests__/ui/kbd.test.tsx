import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Kbd, KbdGroup } from "@/components/ui/kbd";

describe("Kbd", () => {
  it("renders with data-slot='kbd'", () => {
    const { container } = render(<Kbd>⌘</Kbd>);

    expect(container.querySelector('[data-slot="kbd"]')).toBeTruthy();
  });

  it("renders group with data-slot='kbd-group'", () => {
    const { container } = render(
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );

    expect(container.querySelector('[data-slot="kbd-group"]')).toBeTruthy();
  });
});