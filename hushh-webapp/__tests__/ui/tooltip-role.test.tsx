import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe("TooltipContent", () => {
  it("exposes role tooltip", () => {
    render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>
            Hover me
          </TooltipTrigger>

          <TooltipContent>
            Tooltip text
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(
      document.querySelector('[role="tooltip"]'),
    ).not.toBeNull();
  });
});