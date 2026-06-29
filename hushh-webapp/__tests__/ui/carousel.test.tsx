import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  // @ts-expect-error test-only polyfill
  globalThis.ResizeObserver = ResizeObserverStub;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }

    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
  }

  // @ts-expect-error test-only polyfill
  globalThis.IntersectionObserver = IntersectionObserverStub;
}

describe("Carousel", () => {
  it("renders root with carousel accessibility contract", () => {
    const { container } = render(
      <Carousel>
        <CarouselContent>
          <CarouselItem>Slide</CarouselItem>
        </CarouselContent>
      </Carousel>,
    );

    const root = container.querySelector('[data-slot="carousel"]');

    expect(root).toBeTruthy();
    expect(root?.getAttribute("role")).toBe("region");
    expect(root?.getAttribute("aria-roledescription")).toBe("carousel");
  });

  it("renders content with data-slot='carousel-content'", () => {
    const { container } = render(
      <Carousel>
        <CarouselContent>
          <CarouselItem>Slide</CarouselItem>
        </CarouselContent>
      </Carousel>,
    );

    expect(
      container.querySelector('[data-slot="carousel-content"]'),
    ).toBeTruthy();
  });

  it("renders item with slide contract", () => {
    const { container } = render(
      <Carousel>
        <CarouselContent>
          <CarouselItem>Slide</CarouselItem>
        </CarouselContent>
      </Carousel>,
    );

    const item = container.querySelector('[data-slot="carousel-item"]');

    expect(item).toBeTruthy();
    expect(item?.getAttribute("role")).toBe("group");
    expect(item?.getAttribute("aria-roledescription")).toBe("slide");
  });
});