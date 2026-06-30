import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreviewCarouselStep } from "@/components/onboarding/PreviewCarouselStep";

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

vi.mock("@/lib/morphy-ux/gsap", async () => {
  const actual = await vi.importActual<typeof import("@/lib/morphy-ux/gsap")>(
    "@/lib/morphy-ux/gsap",
  );

  return {
    ...actual,
    prefersReducedMotion: () => true,
  };
});

vi.mock("@/components/onboarding/previews/KycPreviewCompact", () => ({
  KycPreviewCompact: () => <div>KYC preview</div>,
}));

vi.mock("@/components/onboarding/previews/PortfolioPreviewCompact", () => ({
  PortfolioPreviewCompact: () => <div>Portfolio preview</div>,
}));

vi.mock("@/components/onboarding/previews/DecisionPreviewCompact", () => ({
  DecisionPreviewCompact: () => <div>Decision preview</div>,
}));

describe("PreviewCarouselStep", () => {
  it("covers slide indicator current state", () => {
    render(<PreviewCarouselStep onContinue={vi.fn()} />);

    const slides = screen.getAllByRole("group");

    expect(slides).toHaveLength(3);
    expect(slides[0]?.getAttribute("aria-current")).toBe("step");
    expect(slides[1]?.getAttribute("aria-current")).toBeNull();
    expect(slides[2]?.getAttribute("aria-current")).toBeNull();
  });
});
