import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";

function BrokenRoute() {
  throw new Error("Route failed");
}

describe("RouteErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders retry button with type='button'", () => {
    render(
      <RouteErrorBoundary>
        <BrokenRoute />
      </RouteErrorBoundary>,
    );

    expect(
      screen.getByRole("button", { name: "Try again" }).getAttribute("type"),
    ).toBe("button");
  });
});
