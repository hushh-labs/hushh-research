import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "@/components/ui/spinner";

describe("Spinner", () => {
  it("renders with status role and loading label", () => {
    render(<Spinner />);
    const el = screen.getByRole("status");
    expect(el).toBeTruthy();
    expect(el.getAttribute("aria-label")).toBe("Loading");
  });

  it("applies custom className", () => {
    render(<Spinner className="test-custom-class" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("class")).toContain("test-custom-class");
    expect(el.getAttribute("class")).toContain("animate-spin");
  });

  it("forwards additional props to SVG element", () => {
    render(<Spinner data-testid="custom-spinner" id="spinner-element" />);
    const el = screen.getByTestId("custom-spinner");
    expect(el).toBeTruthy();
    expect(el.getAttribute("id")).toBe("spinner-element");
  });
});
