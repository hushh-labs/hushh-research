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
});
