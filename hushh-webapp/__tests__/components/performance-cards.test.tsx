import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BiggestMoversCard, IncomeFeesCard } from "@/components/kai/performance/performance-cards";
import { PerformanceStrip } from "@/components/kai/performance/performance-strip";
import type { DashboardSummaryMetrics } from "@/components/kai/views/dashboard-data-mapper";
import type { DashboardPosition } from "@/components/kai/views/dashboard-portfolio-model";

vi.mock("@/components/app-ui/kai-control-surface", () => ({
  KaiControlSurface: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <section role="dialog" aria-label={title}>{children}</section> : null,
}));

const position = (id: string, gainLoss: number): DashboardPosition => ({
  id, rawSymbol: id, displaySymbol: id, tickerSymbol: id, identifierType: "ticker", name: `${id} Inc`,
  marketValue: 1000, costBasis: 900, quantity: 1, price: 1000, gainLoss, gainLossPct: gainLoss / 10,
  estimatedAnnualIncome: null, estimatedYield: null, sector: null, assetType: null, assetBucket: "equity",
  isCashEquivalent: false, debateEligible: true, optimizeEligible: true, aliases: [],
});

const positions = [
  position("G1", 500), position("G2", 400), position("G3", 300), position("G4", 200),
  position("L1", -600), position("L2", -500), position("L3", -400), position("L4", -100),
];

describe("BiggestMoversCard", () => {
  it("previews one gain and one loss, and the sheet lists three of each", () => {
    render(<BiggestMoversCard positions={positions} onOpenHolding={vi.fn()} />);
    expect(screen.getByText("G1")).toBeTruthy();
    expect(screen.getByText("L1")).toBeTruthy();
    expect(screen.queryByText("G2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Biggest gain and loss/ }));
    const sheet = within(screen.getByRole("dialog", { name: "Biggest gains and losses" }));
    expect(["G1", "G2", "G3", "L1", "L2", "L3"].every((symbol) => sheet.queryByText(symbol))).toBe(true);
    expect(sheet.queryByText("G4")).toBeNull();
    expect(sheet.queryByText("L4")).toBeNull();
  });

  it("opens the exact holding that was tapped and closes the sheet", () => {
    const open = vi.fn();
    render(<BiggestMoversCard positions={positions} onOpenHolding={open} />);
    fireEvent.click(screen.getByRole("button", { name: /Biggest gain and loss/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("L2"));
    expect(open).toHaveBeenCalledWith("L2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("empty values are left out, never printed as Unavailable", () => {
  it("omits strip stats that have no value", () => {
    render(<PerformanceStrip value={1000} sinceBought={null} invested={null} cash={50} period="Saved snapshot" />);
    const strip = within(screen.getByTestId("performance-strip"));
    expect(strip.getByText("Cash")).toBeTruthy();
    expect(strip.queryByText("Since you bought")).toBeNull();
    expect(strip.queryByText("Invested")).toBeNull();
    expect(strip.queryByText(/Unavailable/)).toBeNull();
  });

  it("shows only the income and fee tiles the statement reports", () => {
    const metrics = { totalIncomePeriod: 120, totalIncomeYtd: null, totalFees: 15, investmentGainLoss: null, netDepositsPeriod: null, netDepositsYtd: null } as DashboardSummaryMetrics;
    render(<IncomeFeesCard metrics={metrics} />);
    expect(screen.getByText("Income")).toBeTruthy();
    expect(screen.getByText("Fees").nextElementSibling?.textContent).toBe("−$15");
    expect(screen.queryByText("Income this year")).toBeNull();
    expect(screen.queryByText("Net deposits")).toBeNull();
  });
});
