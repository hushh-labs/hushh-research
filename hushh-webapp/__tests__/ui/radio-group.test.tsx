import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

describe("RadioGroup", () => {
  it("renders root with data-slot='radio-group'", () => {
    const { container } = render(
      <RadioGroup defaultValue="a">
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );

    expect(container.querySelector('[data-slot="radio-group"]')).toBeTruthy();
  });

  it("renders item with data-slot='radio-group-item'", () => {
    const { container } = render(
      <RadioGroup defaultValue="a">
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );

    expect(
      container.querySelector('[data-slot="radio-group-item"]'),
    ).toBeTruthy();
  });

  it("renders indicator with data-slot='radio-group-indicator' when item is checked", () => {
    const { container } = render(
      <RadioGroup defaultValue="a">
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );

    expect(
      container.querySelector('[data-slot="radio-group-indicator"]'),
    ).toBeTruthy();
  });
});