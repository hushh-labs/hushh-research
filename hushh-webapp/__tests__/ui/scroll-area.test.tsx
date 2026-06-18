import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { ScrollArea } from "@/components/ui/scroll-area";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe("ScrollArea", () => {
  it("allows keyboard focus on the scroll container", () => {
    const { container } = render(
      <ScrollArea className="h-20 w-40">
        <div className="h-40">Scrollable content</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );

    expect(viewport).toBeTruthy();
    viewport?.focus();
    expect(document.activeElement).toBe(viewport);
  });

  it("renders root with data-slot='scroll-area'", () => {
    const { container } = render(
      <ScrollArea>
        <div>content</div>
      </ScrollArea>,
    );

    expect(
      container.querySelector('[data-slot="scroll-area"]'),
    ).toBeTruthy();
  });

  it("renders viewport with data-slot='scroll-area-viewport'", () => {
    const { container } = render(
      <ScrollArea>
        <div>content</div>
      </ScrollArea>,
    );

    expect(
      container.querySelector('[data-slot="scroll-area-viewport"]'),
    ).toBeTruthy();
  });

  it("renders scrollbar with data-slot='scroll-area-scrollbar'", () => {
    const { container } = render(
      <ScrollArea type="always">
        <div>content</div>
      </ScrollArea>,
    );

    expect(
      container.querySelector('[data-slot="scroll-area-scrollbar"]'),
    ).toBeTruthy();
  });
});

