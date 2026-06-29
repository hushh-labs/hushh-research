import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Command, CommandInput } from "@/components/ui/command";

describe("CommandInput", () => {
  it("exposes an accessible search role and placeholder", () => {
    render(
      <Command>
        <CommandInput aria-label="Search commands" placeholder="Search commands" />
      </Command>,
    );

    const searchInput = screen.getByRole("combobox");

    expect(searchInput.getAttribute("aria-label")).toBe("Search commands");
    expect(searchInput.getAttribute("placeholder")).toBe("Search commands");
  });
});
