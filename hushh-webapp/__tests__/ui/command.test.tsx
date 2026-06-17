import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Command, CommandDialog, CommandInput } from "@/components/ui/command";

describe("CommandDialog", () => {
  it("renders the close button by default", () => {
    render(
      <CommandDialog open>
        <div>Command content</div>
      </CommandDialog>,
    );

    expect(
      screen.getByRole("button", { name: /close/i }),
    ).toBeTruthy();
  });

  it("hides the close button when showCloseButton is false", () => {
    render(
      <CommandDialog open showCloseButton={false}>
        <div>Command content</div>
      </CommandDialog>,
    );

    expect(
      screen.queryByRole("button", { name: /close/i }),
    ).toBeNull();
  });
});

describe("CommandInput", () => {
  it("preserves accessible search behavior", () => {
    render(
      <Command>
        <CommandInput aria-label="Search commands" placeholder="Search commands" />
      </Command>,
    );

    const search = screen.getByRole("combobox");

    expect(search.getAttribute("aria-autocomplete")).toBe("list");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(search.getAttribute("placeholder")).toBe("Search commands");
    expect(search.getAttribute("spellcheck")).toBe("false");
    expect(search.getAttribute("autocorrect")).toBe("off");
    expect(search.getAttribute("autocapitalize")).toBe("off");
  });
});
