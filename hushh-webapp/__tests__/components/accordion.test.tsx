import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";

describe("Accordion", () => {
  it("renders with data-slot=accordion", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Title</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("accordion");
  });

  it("renders accordion item with data-slot=accordion-item", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Title</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    const item = container.querySelector("[data-slot='accordion-item']");
    expect(item).toBeDefined();
  });
});
