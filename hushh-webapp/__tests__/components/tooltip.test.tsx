import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

describe("TooltipProvider", () => {
  it("renders with data-slot=tooltip-provider", () => {
    const { container } = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("tooltip-provider");
  });
});
