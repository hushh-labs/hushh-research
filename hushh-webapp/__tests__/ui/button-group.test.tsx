import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ButtonGroup } from "@/components/ui/button-group";

describe("ButtonGroup", () => {
  it("renders root with data-slot='button-group'", () => {
    const { container } = render(<ButtonGroup>content</ButtonGroup>);

    expect(
      container.querySelector('[data-slot="button-group"]'),
    ).toBeTruthy();
  });

  it("renders root with role='group'", () => {
    const { container } = render(<ButtonGroup>content</ButtonGroup>);

    const group = container.querySelector('[data-slot="button-group"]');

    expect(group?.getAttribute("role")).toBe("group");
  });

  it("reflects an explicit orientation prop as data-orientation", () => {
    const { container } = render(
      <ButtonGroup orientation="vertical">content</ButtonGroup>,
    );

    const group = container.querySelector('[data-slot="button-group"]');

    expect(group?.getAttribute("data-orientation")).toBe("vertical");
  });

  it("renders with data-orientation='horizontal' when orientation is set to horizontal", () => {
    const { container } = render(
      <ButtonGroup orientation="horizontal">content</ButtonGroup>,
    );

    const group = container.querySelector('[data-slot="button-group"]');

    expect(group?.getAttribute("data-orientation")).toBe("horizontal");
  });

});