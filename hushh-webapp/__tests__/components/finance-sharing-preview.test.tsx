// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FinanceSharingPreview } from "@/components/kai/sharing/finance-sharing-preview";
import type { FinanceProjection } from "@/lib/finance-sharing/contract";

afterEach(cleanup);

it("shows every advisor position classification in the owner's preview", () => {
  const projection: FinanceProjection = { schema: "finance-share-v2", source: "statement", sourcePeriod: null,
    allocation: [], performance: { balanceChangePct: null, unit: "USD", history: [] }, cashBalance: null,
    holdings: [{ symbol: "", name: "Sweep", sector: "Financials", isCashEquivalent: true,
      amount: { value: 100, currency: "USD" }, weightPct: 100, gainLossPct: null }] };
  render(<FinanceSharingPreview projection={projection} />);
  expect(screen.getByText("Sector: Financials")).toBeTruthy();
  expect(screen.getByText("Cash equivalent")).toBeTruthy();
});
