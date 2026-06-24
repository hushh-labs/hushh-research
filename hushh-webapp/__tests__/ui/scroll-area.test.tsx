import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScrollArea } from "@/components/ui/scroll-area";

describe("ScrollArea", () => {
  it("intentionally prevents keyboard focus on the scroll container to avoid tab-stop bloat", () => {
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
    expect(document.activeElement).not.toBe(viewport);
  });
});
