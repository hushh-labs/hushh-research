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
});