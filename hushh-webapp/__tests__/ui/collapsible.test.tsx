import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

describe("Collapsible", () => {
  it("renders root with data-slot='collapsible'", () => {
    const { container } = render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
      </Collapsible>,
    );

    expect(container.querySelector('[data-slot="collapsible"]')).toBeTruthy();
  });

  it("renders trigger with data-slot='collapsible-trigger'", () => {
    const { container } = render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
      </Collapsible>,
    );

    expect(
      container.querySelector('[data-slot="collapsible-trigger"]'),
    ).toBeTruthy();
  });

  it("renders content with data-slot='collapsible-content' when open", () => {
    const { container } = render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Body</CollapsibleContent>
      </Collapsible>,
    );

    expect(
      container.querySelector('[data-slot="collapsible-content"]'),
    ).toBeTruthy();
  });

  it("passes className through to content", () => {
    const { container } = render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent className="custom-content-class">
          Body
        </CollapsibleContent>
      </Collapsible>,
    );

    expect(
      container
        .querySelector('[data-slot="collapsible-content"]')
        ?.classList.contains("custom-content-class"),
    ).toBe(true);
  });
});
