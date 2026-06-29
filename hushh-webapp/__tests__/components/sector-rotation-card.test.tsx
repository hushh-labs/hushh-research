import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SectorRotationCard } from "@/components/kai/home/sector-rotation-card";

describe("SectorRotationCard", () => {
  it("covers empty sector rotation fallback", () => {
    render(<SectorRotationCard rows={[]} />);

    expect(
      screen.getByText("Sector movement data is unavailable right now."),
    ).toBeTruthy();
  });
});
