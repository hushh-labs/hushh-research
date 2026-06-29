import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

describe("PopoverTrigger", () => {
  it("renders with type=button to prevent accidental form submission", () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content</PopoverContent>
      </Popover>
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    expect(trigger.getAttribute("type")).toBe("button");
  });

  it("renders with data-slot=popover-trigger", () => {
    const { container } = render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content</PopoverContent>
      </Popover>
    );
    const el = container.querySelector("[data-slot='popover-trigger']");
    expect(el).toBeDefined();
  });
});
