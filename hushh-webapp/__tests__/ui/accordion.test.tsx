import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// Radix Accordion uses @radix-ui/react-use-size → ResizeObserver to compute
// content height for CSS variable --radix-accordion-content-height.
// jsdom v25 does not implement ResizeObserver; this stub prevents ReferenceError
// when AccordionContent is rendered in the open state.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe("Accordion", () => {
  it("renders root with data-slot='accordion'", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    expect(container.querySelector('[data-slot="accordion"]')).toBeTruthy();
  });

  it("renders AccordionItem with data-slot='accordion-item'", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    expect(container.querySelector('[data-slot="accordion-item"]')).toBeTruthy();
  });

  it("renders AccordionTrigger with data-slot='accordion-trigger'", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    expect(
      container.querySelector('[data-slot="accordion-trigger"]'),
    ).toBeTruthy();
  });

  it("renders AccordionContent with data-slot='accordion-content' when item is open", () => {
    const { container } = render(
      <Accordion type="single" defaultValue="item-1">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    expect(
      container.querySelector('[data-slot="accordion-content"]'),
    ).toBeTruthy();
  });

  it("renders multiple AccordionItems each with data-slot='accordion-item'", () => {
    const { container } = render(
      <Accordion type="multiple">
        <AccordionItem value="item-1">
          <AccordionTrigger>First</AccordionTrigger>
          <AccordionContent>First content</AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Second</AccordionTrigger>
          <AccordionContent>Second content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    const items = container.querySelectorAll('[data-slot="accordion-item"]');
    const triggers = container.querySelectorAll('[data-slot="accordion-trigger"]');
    expect(items).toHaveLength(2);
    expect(triggers).toHaveLength(2);
  });

  it("renders the decorative trigger icon with aria-hidden='true'", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    const icon = container.querySelector(
      '[data-slot="accordion-trigger"] [aria-hidden="true"]',
    );

    expect(icon).toBeTruthy();
  });

  it("renders AccordionTrigger wrapping element with data-slot='accordion-header'", () => {
    const { container } = render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    expect(
      container.querySelector('[data-slot="accordion-header"]'),
    ).toBeTruthy();
  });

});