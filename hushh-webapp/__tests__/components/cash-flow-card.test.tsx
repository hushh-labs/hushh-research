import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CashFlowCard } from "@/components/kai/cards/cash-flow-card";

describe("CashFlowCard", () => {
  it("renders empty fallback when cash flow has no balances or activity", () => {
    const { container } = render(<CashFlowCard cashFlow={{}} />);

    expect(container.firstChild).toBeNull();
  });
});
