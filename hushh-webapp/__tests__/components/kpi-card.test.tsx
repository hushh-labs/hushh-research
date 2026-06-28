import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KPICard } from "@/components/kai/cards/kpi-card";

describe("KPICard", () => {
  it("covers trend label rendering", () => {
    render(
      <KPICard
        title="Revenue"
        value="$12.4K"
        change={3.25}
        changeLabel="vs last month"
      />,
    );

    expect(screen.getByText("+3.25%")).toBeTruthy();
    expect(screen.getByText("(vs last month)")).toBeTruthy();
  });
});
