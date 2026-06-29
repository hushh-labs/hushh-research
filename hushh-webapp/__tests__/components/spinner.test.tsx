import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "@/components/ui/spinner";

describe("Spinner", () => {
  it("renders with status role and loading label", () => {
    render(<Spinner />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-label")).toBe("Loading");
  });
});
