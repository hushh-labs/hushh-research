import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { toHoldingViewModel } from "@/components/kai/holdings/holding-view-model";
import { projectSavedPortfolio } from "@/components/kai/views/portfolio-save-projection";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Portfolio workspace hierarchy", () => {
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
    expect(overview).not.toContain("<SettingsGroup");
    for (const title of ["Holdings", "Allocation", "Performance"]) {
      expect(overview).toContain(`>${title}</SectionLabel>`);
    }
    expect(overview).not.toContain('title: "Portfolio source"');
    expect(overview).toContain('onOpenSection("sources")}>Manage portfolio');
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
