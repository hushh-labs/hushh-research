import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";

describe("InputGroup", () => {
  it("renders root with data-slot='input-group' and role='group'", () => {
    const { container } = render(<InputGroup>content</InputGroup>);

    const group = container.querySelector('[data-slot="input-group"]');

    expect(group).toBeTruthy();
    expect(group?.getAttribute("role")).toBe("group");
  });

  it("renders addon with data-slot='input-group-addon' and role='group'", () => {
    const { container } = render(
      <InputGroup>
        <InputGroupAddon>icon</InputGroupAddon>
      </InputGroup>,
    );

    const addon = container.querySelector('[data-slot="input-group-addon"]');

    expect(addon).toBeTruthy();
    expect(addon?.getAttribute("role")).toBe("group");
  });

  it("preserves addon data-slot when align is set", () => {
    const { container } = render(
      <InputGroup>
        <InputGroupAddon align="inline-end">icon</InputGroupAddon>
      </InputGroup>,
    );

    expect(
      container.querySelector(
        '[data-slot="input-group-addon"][data-align="inline-end"]',
      ),
    ).toBeTruthy();
  });

  it("defaults addon to data-align='inline-start'", () => {
    const { container } = render(
      <InputGroup>
        <InputGroupAddon>icon</InputGroupAddon>
      </InputGroup>,
    );

    const addon = container.querySelector('[data-slot="input-group-addon"]');

    expect(addon?.getAttribute("data-align")).toBe("inline-start");
  });
});
