import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Portfolio workspace hierarchy", () => {
  it("uses one compact KPI index without an optimize action", () => {
    const dashboard = read("components/kai/views/dashboard-master-view.tsx");

    expect(dashboard).toContain('testId="portfolio-overview-options"');
    expect(dashboard).toContain('title="Holdings"');
    expect(dashboard).toContain('title="Allocation"');
    expect(dashboard).toContain('title="Performance"');
    expect(dashboard).toContain('title="Portfolio source"');
    expect(dashboard).toContain('testId="portfolio-holdings-mobile-list"');
    expect(dashboard).toContain("isHoldingsEditing");
    expect(dashboard).toContain('className="hidden min-w-0 md:block"');
    expect(dashboard).not.toContain("handleOptimizePortfolio");
    expect(dashboard).not.toContain("Optimize Portfolio");
  });

  it("owns finite detail routes through one shared detail component", () => {
    const sections = ["holdings", "allocation", "performance", "sources"];

    for (const section of sections) {
      const page = read(`app/one/kai/portfolio/${section}/page.tsx`);
      expect(page).toContain("KaiPortfolioDetailPage");
      expect(page).toContain(`section="${section}"`);
    }

    const detail = read("components/kai/kai-portfolio-detail-page.tsx");
    expect(detail).toContain('width="reading"');
    expect(detail).toContain("dashboardSection={section}");

    const breadcrumbs = read("lib/navigation/top-shell-breadcrumbs.ts");
    for (const section of sections) {
      expect(breadcrumbs).toContain(
        `ROUTES.KAI_PORTFOLIO_${section.toUpperCase()}`,
      );
    }
    expect(breadcrumbs).toContain("backHref: ROUTES.KAI_PORTFOLIO");
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
