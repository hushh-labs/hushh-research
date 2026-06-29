import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
});

describe("Tooltip", () => {
  it("renders TooltipTrigger with data-slot='tooltip-trigger'", () => {
    const { container } = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(
      container.querySelector('[data-slot="tooltip-trigger"]'),
    ).toBeTruthy();
  });

  it("renders TooltipContent with data-slot='tooltip-content' when open", () => {
    render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Tooltip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(
      document.querySelector('[data-slot="tooltip-content"]'),
    ).toBeTruthy();
  });
});