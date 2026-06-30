import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "@/components/ui/checkbox";

describe("Checkbox", () => {
  it("renders with data-slot=checkbox", () => {
    const { container } = render(<Checkbox />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("checkbox");
  });
});
