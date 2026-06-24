import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChartContainer } from "@/components/ui/chart";

vi.mock("recharts", () => ({
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Tooltip: () => null,
}));

describe("ChartContainer", () => {
  it("renders chart container data-slot contract", () => {
    const { container } = render(
      <ChartContainer config={{}}>
        <div />
      </ChartContainer>,
    );

    expect(container.querySelector('[data-slot="chart"]')).toBeTruthy();
  });
});
