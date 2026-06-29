import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

describe("Select", () => {
  it("renders trigger with data-slot=select-trigger", () => {
    const { container } = render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Option A</SelectItem>
        </SelectContent>
      </Select>
    );
    const trigger = container.querySelector("[data-slot='select-trigger']");
    expect(trigger).toBeDefined();
  });
});
