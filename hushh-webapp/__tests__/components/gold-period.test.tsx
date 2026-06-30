import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GoldPeriod, OneLockup } from "@/components/app-ui/gold-period";

describe("GoldPeriod", () => {
  it("renders default period character", () => {
    render(<GoldPeriod />);
    expect(screen.getByText(".")).toBeDefined();
  });

  it("renders custom children", () => {
    render(<GoldPeriod>!</GoldPeriod>);
    expect(screen.getByText("!")).toBeDefined();
  });
});

describe("OneLockup", () => {
  it("renders One text with gold period", () => {
    const { container } = render(<OneLockup />);
    expect(container.textContent).toBe("One.");
  });
});
