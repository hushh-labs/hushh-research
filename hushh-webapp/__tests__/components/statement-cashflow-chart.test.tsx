import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatementCashflowChart } from "@/components/kai/charts/statement-cashflow-chart";

describe("StatementCashflowChart", () => {
  it("covers empty cashflow fallback", () => {
    render(<StatementCashflowChart data={[]} />);

    expect(screen.getByText("Statement Cashflow Signals")).toBeTruthy();
    expect(
      screen.getByText(
        "Cashflow signals will appear after at least two valid statement entries are available.",
      ),
    ).toBeTruthy();
  });
});
