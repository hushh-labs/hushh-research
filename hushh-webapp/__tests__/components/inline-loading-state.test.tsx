import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InlineLoadingState } from "@/components/app-ui/inline-loading-state";

describe("InlineLoadingState", () => {
  it("renders loading status with accessible label semantics", () => {
    render(<InlineLoadingState label="Loading holdings" />);

    const status = screen.getByRole("status", { name: "Loading holdings" });

    expect(status).toBeTruthy();
    expect(screen.getByText("Loading holdings")).toBeTruthy();
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
