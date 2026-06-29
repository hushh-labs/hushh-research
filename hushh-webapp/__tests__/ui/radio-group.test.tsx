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

  it("marks only one option as aria-checked true", () => {
    const { container } = render(
      <RadioGroup defaultValue="b">
        <RadioGroupItem value="a" />
        <RadioGroupItem value="b" />
        <RadioGroupItem value="c" />
      </RadioGroup>,
    );

    const checkedOptions = Array.from(
      container.querySelectorAll('[role="radio"][aria-checked="true"]'),
    );

    expect(checkedOptions).toHaveLength(1);
    expect(checkedOptions[0].getAttribute("value")).toBe("b");
  });

  it("renders RadioGroupItem with role='radio'", () => {
    const { container } = render(
      <RadioGroup defaultValue="a">
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );

    const item = container.querySelector(
      '[data-slot="radio-group-item"]',
    );

    expect(item?.getAttribute("role")).toBe("radio");
  });

  it("merges custom className with default classes on the root", () => {
    const { container } = render(
      <RadioGroup
        defaultValue="a"
        className="custom-radio-class"
      >
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );

    const root = container.querySelector('[data-slot="radio-group"]');

    expect(root?.classList.contains("custom-radio-class")).toBe(true);
    expect(root?.classList.contains("grid")).toBe(true);
  });

});
