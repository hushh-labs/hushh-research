import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CashManagementCard } from "@/components/kai/cards/cash-management-card";

describe("CashManagementCard", () => {
  it("covers the empty balance fallback", () => {
    const { container } = render(
      <CashManagementCard
        cashManagement={{
          checking_activity: [],
          debit_card_activity: [],
          deposits_and_withdrawals: [],
        }}
      />,
    );

    expect(screen.queryByText("Cash Management")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
