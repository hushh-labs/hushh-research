import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Spinner } from "@/components/ui/spinner";

describe("Spinner", () => {
  it("renders with role='status'", () => {
    render(<Spinner />);

    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders with aria-label='Loading'", () => {
    render(<Spinner />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Loading",
    );
  });

  it("preserves status semantics with a custom accessible label", () => {
    render(<Spinner aria-label="Saving" />);

    expect(screen.getByRole("status", { name: "Saving" })).toBeTruthy();
  });

  it("renders Spinner as an svg element", () => {
    render(<Spinner />);

    expect(screen.getByRole("status").tagName).toBe("svg");
  });

  it("merges a custom className onto the svg element", () => {
    render(<Spinner className="test-class" />,);

    expect(
      screen.getByRole("status").classList.contains("test-class"),
    ).toBe(true);
  });

});
