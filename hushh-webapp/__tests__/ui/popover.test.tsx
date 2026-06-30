import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

afterEach(cleanup);

describe("Popover backdrop", () => {
  it("uses the shared blurred scrim for a modal popover by default", () => {
    render(<Popover open modal><PopoverTrigger>Open</PopoverTrigger><PopoverContent>Options</PopoverContent></Popover>);

    expect(screen.getByText("Options")).toBeTruthy();
    expect(document.querySelector('[data-slot="popover-scrim"]')).toHaveClass(
      "[backdrop-filter:var(--app-scrim-filter)]",
      "[-webkit-backdrop-filter:var(--app-scrim-filter)]",
    );
  });

  it("keeps lightweight non-modal menus free of a page scrim", () => {
    render(<Popover open><PopoverTrigger>Open</PopoverTrigger><PopoverContent>Options</PopoverContent></Popover>);

    expect(screen.getByText("Options")).toBeTruthy();
    expect(document.querySelector('[data-slot="popover-scrim"]')).toBeNull();
  });

  it("renders PopoverAnchor with data-slot='popover-anchor'", () => {
    const { container } = render(
      <Popover>
        <PopoverAnchor />
      </Popover>,
    );

    expect(
      container.querySelector('[data-slot="popover-anchor"]'),
    ).toBeTruthy();
  });

  it("renders PopoverTitle as an h2 element", () => {
    const { container } = render(<PopoverTitle>Section</PopoverTitle>);

    const el = container.querySelector('[data-slot="popover-title"]');

    expect(el?.tagName).toBe("H2");
  });

  it("renders PopoverDescription as a p element", () => {
    const { container } = render(
      <PopoverDescription>Details</PopoverDescription>,
    );

    const description = container.querySelector(
      '[data-slot="popover-description"]',
    );

    expect(description?.tagName).toBe("P");
  });

});
