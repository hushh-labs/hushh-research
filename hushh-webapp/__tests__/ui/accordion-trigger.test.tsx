import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

describe("AccordionTrigger", () => {
  it("renders as a button element", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>
            Trigger
          </AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );

    const trigger = container.querySelector(
      '[data-slot="accordion-trigger"]',
    );

    expect(trigger?.tagName).toBe("BUTTON");
  });
});