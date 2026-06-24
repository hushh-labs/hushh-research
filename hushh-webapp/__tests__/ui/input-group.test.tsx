import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";

describe("InputGroup", () => {
  it("renders root with role='group'", () => {
    const { container } = render(<InputGroup />);
    const el = container.querySelector('[data-slot="input-group"]');

    expect(el?.getAttribute("role")).toBe("group");
  });

  it("renders addon with role='group'", () => {
    const { container } = render(
      <InputGroup>
        <InputGroupAddon>$</InputGroupAddon>
      </InputGroup>,
    );

    const el = container.querySelector('[data-slot="input-group-addon"]');

    expect(el?.getAttribute("role")).toBe("group");
  });
});