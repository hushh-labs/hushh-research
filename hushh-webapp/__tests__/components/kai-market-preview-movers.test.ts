import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  shouldShowNewsCompanyLogo,
  toMoverGroups,
} from "@/components/kai/views/kai-market-preview-view";
import type { KaiHomeInsightsV2, KaiHomeNewsItem } from "@/lib/services/api-service";

describe("toMoverGroups", () => {
  it("rejects a directionally invalid provider bucket and orders valid movers by magnitude", () => {
    const payload = {
      movers: {
        gainers: [
          { symbol: "BAD", price: 10, change_pct: -4, volume: 1 },
          { symbol: "GOOD", price: 20, change_pct: 1.5, volume: 2 },
          { symbol: "BEST", price: 30, change_pct: 4.5, volume: 3 },
          { symbol: "FLAT", price: 40, change_pct: 0, volume: 4 },
        ],
        losers: [
          { symbol: "WORST", price: 10, change_pct: -5, volume: 1 },
          { symbol: "WRONG", price: 20, change_pct: 2, volume: 2 },
          { symbol: "LOWER", price: 30, change_pct: -1, volume: 3 },
        ],
        active: [],
      },
    } as unknown as KaiHomeInsightsV2;

    const groups = toMoverGroups(payload);

    expect(groups.gain.map((row) => [row.symbol, row.changePct])).toEqual([
      ["BEST", 4.5],
      ["GOOD", 1.5],
    ]);
    expect(groups.lose.map((row) => [row.symbol, row.changePct])).toEqual([
      ["WORST", -5],
      ["LOWER", -1],
    ]);
  });
});

describe("shouldShowNewsCompanyLogo", () => {
  const news = (title: string): KaiHomeNewsItem => ({
    symbol: "NVDA",
    title,
    url: "https://example.test/article",
    published_at: "2026-07-16T00:00:00Z",
    source_name: "Example",
    provider: "test",
    degraded: false,
  });

  it("uses a neutral news cover when the claimed symbol is unrelated to the article", () => {
    expect(shouldShowNewsCompanyLogo(news("Boeing delivered 64 jets in June."))).toBe(false);
    expect(shouldShowNewsCompanyLogo(news("Nvidia expands its AI infrastructure."))).toBe(true);
  });
});

describe("market route overlays", () => {
  it("does not mount a hidden notification sheet on route load", () => {
    const source = readFileSync(
      join(process.cwd(), "components/kai/views/kai-market-preview-view.tsx"),
      "utf8",
    );

    expect(source).not.toContain("OneMarketNotificationsSheet");
    expect(source).not.toContain("notificationsOpen");
  });

  it("uses the Finance route shell instead of nesting another page canvas", () => {
    const source = readFileSync(
      join(process.cwd(), "components/kai/views/kai-market-preview-view.tsx"),
      "utf8",
    );

    expect(source).not.toContain("<AppPageShell");
    expect(source).not.toContain("bg-[color:var(--one-bg)] font-sans");
  });

  it("uses the same neutral primary header grammar as Portfolio and Analysis", () => {
    const source = readFileSync(
      join(process.cwd(), "components/kai/views/kai-market-preview-view.tsx"),
      "utf8",
    );
    const workspaceHeader = readFileSync(
      join(process.cwd(), "components/kai/kai-workspace-header.tsx"),
      "utf8",
    );

    expect(source).toContain('title="Market"');
    expect(source).toContain("<AppPageContentRegion>");
    expect(workspaceHeader).toContain('accent="neutral"');
    expect(workspaceHeader).toContain(
      'className="mb-[var(--page-header-section-gap)]"',
    );
    expect(source).not.toContain("eyebrow={marketStatus");
    expect(source).toContain('data-testid="market-header-status"');
    expect(source).toContain("actionsInlineMobile");
  });

  it("uses the shared header and content rhythm in every Finance tab state", () => {
    const portfolioDashboard = readFileSync(
      join(process.cwd(), "components/kai/views/dashboard-master-view.tsx"),
      "utf8",
    );
    const portfolioImport = readFileSync(
      join(process.cwd(), "components/kai/views/portfolio-import-view.tsx"),
      "utf8",
    );
    const analysis = readFileSync(
      join(process.cwd(), "app/one/kai/analysis/page.tsx"),
      "utf8",
    );
    const portfolioFlow = readFileSync(
      join(process.cwd(), "components/kai/kai-flow.tsx"),
      "utf8",
    );

    for (const source of [portfolioDashboard, portfolioImport, analysis]) {
      expect(source).toContain("KaiWorkspaceHeader");
      expect(source).toContain("AppPageContentRegion");
    }
    expect(portfolioDashboard).toContain("Loading portfolio sources...");
    expect(portfolioDashboard).toContain('workspace="portfolio"');
    expect(portfolioFlow).toContain('state === "checking"');
    expect(portfolioFlow).toContain("KaiWorkspaceHeader");
  });
});
