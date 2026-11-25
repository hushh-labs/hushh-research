import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { toHoldingViewModel } from "@/components/kai/holdings/holding-view-model";
import { projectSavedPortfolio } from "@/components/kai/views/portfolio-save-projection";
import { formatPlaidBalanceDate, formatStatementBalanceDate, portfolioImportLabel } from "@/components/kai/views/portfolio-display-facts";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Portfolio workspace hierarchy", () => {
  it("labels the active portfolio source without guessing an unknown statement format", () => {
    const snapshots = [
      { id: "statement-a", label: "June", fileName: "statement.PDF" },
      { id: "statement-b", label: "July", fileName: "holdings.csv" },
      { id: "statement-c", label: "August" },
      { id: "statement-d", label: "September", fileName: "holdings.xlsx" },
    ];
    expect(portfolioImportLabel("statement", snapshots, "statement-a")).toBe("PDF");
    expect(portfolioImportLabel("statement", snapshots, "statement-b")).toBe("CSV");
    expect(portfolioImportLabel("statement", snapshots, "statement-c")).toBe("Statement");
    expect(portfolioImportLabel("statement", snapshots, "statement-d")).toBe("Statement");
    expect(portfolioImportLabel("statement", snapshots, "missing")).toBe("Statement");
    expect(portfolioImportLabel("plaid", snapshots, "statement-a")).toBe("Plaid");
  });

  it("distinguishes statement coverage, import time, and Plaid sync", () => {
    expect(formatStatementBalanceDate({ statementPeriodEnd: "2026-11-04", importedAt: "2026-11-05" })).toBe("Statement through Nov 4, 2026");
    expect(formatStatementBalanceDate({ statementPeriodEnd: "2026-02-31", importedAt: "2026-11-05" })).toBe("Imported Nov 5, 2026");
    expect(formatStatementBalanceDate(undefined, "2026-11-04")).toBe("Statement through Nov 4, 2026");
    expect(formatStatementBalanceDate(undefined)).toBe("Statement date unavailable");
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(formatPlaidBalanceDate("2026-11-06T11:48:00Z", now)).toBe("Plaid synced 12 minutes ago");
    expect(formatPlaidBalanceDate("2026-11-04", now)).toBe("Plaid synced Nov 4, 2026");
    expect(formatPlaidBalanceDate("unknown", now)).toBe("Plaid sync date unavailable");
  });

  it("shows actual share count and derived prices without fabricating missing gain", () => {
    const holding = {
      client_id: "holding-1",
      symbol: "TEST",
      name: "Test Holding",
      quantity: 2,
      price: 80,
      market_value: 160,
      cost_basis: 100,
    };
    expect(toHoldingViewModel(holding, 400)).toMatchObject({
      shares: 2,
      averagePrice: 50,
      currentPrice: 80,
      gainLossValue: 60,
      gainLossPct: 60,
      portfolioWeightPct: 40,
    });
    expect(toHoldingViewModel({ ...holding, cost_basis: undefined }, 400)).toMatchObject({
      gainLossValue: null,
      gainLossPct: null,
    });
  });

  it("uses the dedicated portfolio cards without duplicate navigation", () => {
    const dashboard = read("components/kai/views/dashboard-master-view.tsx");

    expect(dashboard).toContain("<PortfolioOverview");
    const overview = read("components/kai/views/portfolio-overview.tsx");
    expect(overview).toContain('testId="portfolio-explore"');
    for (const section of ["holdings", "allocation", "performance"]) {
      expect(overview).toContain(`onOpenSection("${section}")`);
    }
    expect(overview).not.toContain('title: "Portfolio source"');
    expect(overview).toContain('onOpenSection("sources")');
    expect(dashboard).toContain('testId="portfolio-holdings-mobile-list"');
    expect(dashboard).toContain("isHoldingsEditing");
    expect(dashboard).toContain('className="hidden min-w-0 md:block"');
    expect(dashboard).not.toContain("handleOptimizePortfolio");
    expect(dashboard).not.toContain("Optimize Portfolio");
  });

  it("preserves the explicit statement valuation and date rather than repricing the holding", () => {
    expect(toHoldingViewModel({ client_id: "statement", symbol: "TEST", name: "Sample", quantity: 2,
      price: 80, market_value: 179, cost_basis: 100 }, 400,
    { source: "Statement", statementAsOf: "2026-07-31" })).toMatchObject({ marketValue: 179,
      gainLossValue: 79, currentPrice: 80, source: "Statement", statementAsOf: "2026-07-31", quoteAsOf: null });
  });

  it("keeps observed balances and statement periods in the saved dashboard projection", () => {
    const history = [{ date: "2026-07-01", value: 100 }, { date: "2026-07-31", value: 130 }];
    expect(projectSavedPortfolio({ historical_values: history, account_info: { statement_period_start: "2026-07-01", statement_period_end: "2026-07-31" } }, [])).toMatchObject({
      historical_values: history, account_info: { statement_period_start: "2026-07-01", statement_period_end: "2026-07-31" },
    });
  });

  it("owns finite detail routes through one shared detail component", () => {
    const sections = ["holdings", "allocation", "performance", "analysis", "sources"];

    for (const section of sections) {
      const page = read(`app/one/kai/portfolio/${section}/page.tsx`);
      expect(page).toContain("KaiPortfolioDetailPage");
      expect(page).toContain(`section="${section}"`);
    }

    const detail = read("components/kai/kai-portfolio-detail-page.tsx");
    expect(detail).toContain('width="agent"');
    expect(detail).toContain("dashboardSection={section}");

    // Per-route Back resolution (including this one) lives in the
    // declarative graph top-shell-breadcrumbs.ts walks, not in
    // top-shell-breadcrumbs.ts itself.
    const backGraph = read("lib/navigation/back-navigation-graph.ts");
    for (const section of sections) {
      expect(backGraph).toContain(
        `ROUTES.KAI_PORTFOLIO_${section.toUpperCase()}`,
      );
    }
    expect(backGraph).toContain("backHref: ROUTES.KAI_PORTFOLIO");
  });

  it("keeps the retired optimize paths redirect-only", () => {
    expect(read("app/one/kai/optimize/page.tsx")).toContain(
      "redirect(ROUTES.KAI_PORTFOLIO)",
    );
    expect(read("app/kai/optimize/page.tsx")).toContain(
      "to={ROUTES.KAI_PORTFOLIO}",
    );
  });
});
