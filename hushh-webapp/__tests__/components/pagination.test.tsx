import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pagination } from "@/components/ui/pagination";

describe("Pagination", () => {
  it("renders with navigation role and aria-label", () => {
    render(<Pagination />);
    const el = screen.getByRole("navigation", { name: "pagination" });
    expect(el).toBeDefined();
  });

  it("renders with data-slot=pagination", () => {
    const { container } = render(<Pagination />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("pagination");
  });
});
