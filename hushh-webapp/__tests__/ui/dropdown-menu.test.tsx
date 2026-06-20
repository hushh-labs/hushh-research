import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

describe("DropdownMenu", () => {
  it("renders trigger with data-slot='dropdown-menu-trigger'", () => {
    const { container } = render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      </DropdownMenu>,
    );

    expect(
      container.querySelector('[data-slot="dropdown-menu-trigger"]'),
    ).toBeTruthy();
  });

  it("renders shortcut with data-slot='dropdown-menu-shortcut'", () => {
    const { container } = render(
      <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>,
    );

    expect(
      container.querySelector('[data-slot="dropdown-menu-shortcut"]'),
    ).toBeTruthy();
  });
});