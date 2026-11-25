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

it("compact review shows value, change and allocation lines and keeps the sector list collapsed", () => {
  const projection = { schema: "finance-share-v2", source: "statement", sourcePeriod: null,
    allocation: [
      { name: "Equities", percent: 45.6, amount: { value: 755837.61, currency: "USD" } },
      { name: "Cash", percent: 54.4, amount: { value: 900226.92, currency: "USD" } },
    ],
    sectors: [{ name: "Healthcare", percent: 14 }, { name: "Consumer Discretionary", percent: 11.2 }],
    performance: { total: { value: 1656064.53, currency: "USD" }, balanceChangePct: null, unit: "USD", history: [] },
    cashBalance: null } as unknown as FinanceProjection;
  const { container } = render(<FinanceSharingPreview projection={projection} compact />);
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.getByText(/45\.6% · .*837\.61/)).toBeTruthy();
  const sectors = container.querySelector("details");
  expect(sectors?.hasAttribute("open")).toBe(false);
  expect(screen.getByText("Show 2 equity sectors")).toBeTruthy();
  expect(screen.queryByText("Change unavailable")).toBeNull();
});
