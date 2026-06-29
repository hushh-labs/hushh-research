import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HushhLoader } from "@/components/app-ui/hushh-loader";

describe("HushhLoader", () => {
  it("renders progress status with polite busy semantics", () => {
    render(<HushhLoader label="Loading portfolio" />);

    const status = screen.getByRole("status");

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(screen.getByText("Loading portfolio")).toBeTruthy();
  });
});
