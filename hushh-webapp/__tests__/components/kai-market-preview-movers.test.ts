import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  shouldShowNewsCompanyLogo,
  toMoverGroups,
  toIndexStripItems,
  OneMarketIndexStrip,
  OneMarketMovers,
  sectorRowsForPeriod,
  SectorRotationChart,
  OneMarketNewsCover,
  OneMarketNewsBriefing,
  marketNewsImageUrl,
} from "@/components/kai/views/kai-market-preview-view";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { withStableOverviewFromCache } from "@/lib/kai/kai-market-home-resource";
import type { KaiHomeInsightsV2, KaiHomeNewsItem } from "@/lib/services/api-service";

describe("market period and image evidence", () => {
  it("switches to actual weekly values and exposes the observed period", async () => {
    const rows = [{ sector: "Technology", change_pct: 1, change_1w_pct: -2,
      period_start_1d: "2026-10-19", period_start_1w: "2026-10-13", period_end: "2026-10-20",
      basis: "Sector ETF price return", as_of: "2026-10-20T20:00:00Z", source_tags: ["Yahoo"], degraded: false }];
    expect(sectorRowsForPeriod(rows, "1d")[0]?.changePct).toBe(1);
    expect(sectorRowsForPeriod(rows, "1w")[0]?.changePct).toBe(-2);
    expect(sectorRowsForPeriod([{ ...rows[0]!, change_1w_pct: null }], "1w")).toEqual([]);
    render(createElement(SectorRotationChart, { rows }));
    fireEvent.click(screen.getByRole("tab", { name: "1 week" }));
    expect(screen.getByRole("tab", { name: "1 week" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTitle("2026-10-13 to 2026-10-20")).toHaveTextContent(/Oct.*13.*20.*2026/);
    expect(screen.getByText("Sector ETF price return")).toBeVisible();
    expect(screen.getByText("Technology: -2.00%")).toBeTruthy();
    const dayAction = resolveLocalOnboardingHandler("market.sectors.show_day");
    expect(dayAction).toBeTruthy();
    await act(async () => { await dayAction?.({}); });
    expect(screen.getByRole("tab", { name: "1 day" }).getAttribute("aria-selected")).toBe("true");
  });

  it("uses the supplied article thumbnail and recovers from image errors", () => {
    expect(marketNewsImageUrl("https://s.yimg.com/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png")).toBeNull();
    expect(marketNewsImageUrl("https://example.test/article.jpg")).toBe("https://example.test/article.jpg");
    const row = { symbol: "NVDA", title: "Economy update", url: "https://example.test/story",
      published_at: "2026-10-20T20:00:00Z", source_name: "Publisher", provider: "test", degraded: false,
      image_url: "https://example.test/story.jpg" };
    const { container, rerender } = render(createElement(OneMarketNewsCover, { row, index: 0 }));
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(row.image_url);
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    rerender(createElement(OneMarketNewsCover, { row: { ...row, image_thumbnail_url: "https://example.test/small.jpg" }, index: 0, thumbnail: true }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/small.jpg");
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(row.image_url);
    rerender(createElement(OneMarketNewsBriefing, { rows: [{ ...row, image_url: null, image_thumbnail_url: "https://example.test/small.jpg" }] }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/small.jpg");
  });

  it("keeps the highest and lowest period returns, expands every sector and supports voice scope changes", async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({ sector: `Sector ${index}`, change_pct: index - 5, change_1w_pct: 5 - index }));
    const onScopeAvailabilityChange = vi.fn();
    const { container, rerender } = render(createElement(SectorRotationChart, { rows, onScopeAvailabilityChange }));
    const shown = () => [...container.querySelectorAll("ul li")].map((row) => row.textContent?.split(":")[0]);
    expect(shown()).toEqual(["Sector 10", "Sector 9", "Sector 8", "Sector 2", "Sector 1", "Sector 0"]);
    fireEvent.click(screen.getByRole("tab", { name: "1 week" }));
    expect(shown()).toEqual(["Sector 0", "Sector 1", "Sector 2", "Sector 8", "Sector 9", "Sector 10"]);
    fireEvent.click(screen.getByRole("button", { name: "All 11 sectors" }));
    expect(shown()).toHaveLength(11);
    await act(async () => { await resolveLocalOnboardingHandler("market.sectors.show_highlights")?.({}); });
    expect(shown()).toHaveLength(6);
    await act(async () => { await resolveLocalOnboardingHandler("market.sectors.show_all")?.({}); });
    expect(shown()).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "Show highlights" }));
    rerender(createElement(SectorRotationChart, { rows: rows.slice(0, 5), onScopeAvailabilityChange }));
    expect(new Set(shown()).size).toBe(5);
    expect(resolveLocalOnboardingHandler("market.sectors.show_all")).toBeNull();
    rerender(createElement(SectorRotationChart, { rows: rows.map((row) => ({ ...row, change_1w_pct: null })), onScopeAvailabilityChange }));
    expect(shown()).toHaveLength(0);
    expect(onScopeAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(resolveLocalOnboardingHandler("market.sectors.show_all")).toBeNull();
  });
});

describe("market index quote evidence", () => {
  const quote = {
    label: "S&P 500", symbol: "^GSPC", value: 7712.57, delta_pct: null,
    as_of: "2026-10-20T20:45:45Z", source: "Yahoo Chart (Batch)",
    degraded: true, is_delayed: true, sparkline: [7700, 7712.57],
  };

  it("shares matching quote status while preserving individual times and mixed-status exceptions", () => {
    const [first] = toIndexStripItems({ market_overview: [quote] });
    const metrics = [first, { ...first, id: "nasdaq", label: "NASDAQ Composite", quotedAt: "2026-10-20T20:50:00Z" }];
    const { container, rerender } = render(createElement(OneMarketIndexStrip, { metrics, onMetricSelect: () => {} }));
    expect(screen.getByText("Index levels in points")).toBeVisible();
    expect(screen.getByRole("button", { name: /S&P 500/ })).toHaveTextContent("7,712.57");
    expect(screen.getByRole("button", { name: /S&P 500/ }).textContent).not.toMatch(/[$₹]/);
    expect(screen.getAllByText(/Delayed/)).toHaveLength(1);
    expect([...container.querySelectorAll("time")].map((time) => time.dateTime)).toEqual([quote.as_of, metrics[1].quotedAt]);
    rerender(createElement(OneMarketIndexStrip, { metrics: [first, { ...metrics[1], quoteStatus: "Unavailable", quotedAt: null }], onMetricSelect: () => {} }));
    expect(screen.getByRole("button", { name: /S&P 500/ }).textContent).toContain("Delayed");
    expect(screen.getByRole("button", { name: /NASDAQ Composite/ }).textContent).toContain("Unavailable");
    expect(container.querySelectorAll("time")).toHaveLength(1);
  });

  it("preserves delayed levels, provider time and real series without inventing a flat change", () => {
    const [metric] = toIndexStripItems({ market_overview: [quote] });
    expect(metric.value).toBe("7,712.57");
    expect(metric.delta).toBe("Change unavailable");
    expect(metric.quotedAt).toBe(quote.as_of);
    expect(metric.quoteStatus).toBe("Delayed");
    expect(metric.sparkline).toEqual([7700, 7712.57]);
    expect(metric.detailPanel?.statusLabel).toBe("Delayed");
    expect(metric.detailPanel?.facts).toContainEqual({ label: "Source", value: "Yahoo Chart (Batch)" });
    expect(metric.detailPanel?.facts?.find((fact) => fact.label === "Quoted")?.value).not.toBe("Timestamp unavailable");
  });

  it("keeps cached chart direction tied to daily change, including small moves and unavailable change", () => {
    const cases = [
      { change: 0.02, tone: "positive" }, { change: -0.02, tone: "negative" },
      { change: 0, tone: "neutral" }, { change: null, tone: "warning" },
    ];
    const metrics = cases.map(({ change }, index) => ({
      ...toIndexStripItems({ market_overview: [{ ...quote, delta_pct: change }] })[0], id: `quote-${index}`,
    }));
    const { container } = render(createElement(OneMarketIndexStrip, { metrics, onMetricSelect: () => {} }));
    expect([...container.querySelectorAll("[data-index-chart-tone]")].map(node => node.getAttribute("data-index-chart-tone")))
      .toEqual(cases.map(item => item.tone));
    expect(metrics.every(metric => metric.quoteStatus === "Delayed" && metric.quotedAt === quote.as_of)).toBe(true);
    expect(metrics[1].sparkline).toEqual([7700, 7712.57]); // Rising intraday points can still be a down day.
  });

  it("rejects ETF proxy rows and leaves missing benchmarks unavailable", () => {
    const metrics = toIndexStripItems({ market_overview: [{ ...quote, symbol: "SPY" }] });
    expect(metrics.map((metric) => metric.label)).toEqual([
      "S&P 500", "NASDAQ Composite", "Dow Jones", "Russell 2000",
    ]);
    expect(metrics.every((metric) => metric.value === "Awaiting data")).toBe(true);
    expect(metrics.every((metric) => metric.quoteStatus === "Unavailable")).toBe(true);
    expect(metrics.every((metric) => metric.sparkline === undefined)).toBe(true);
  });

  it("distinguishes closed sessions and missing timestamps from live quotes", () => {
    const [closed] = toIndexStripItems({ market_overview: [{
      ...quote, degraded: false, is_delayed: false, market_state: "closed",
    }] });
    expect(closed.quoteStatus).toBe("Market closed");
    const [unknown] = toIndexStripItems({ market_overview: [{
      ...quote, degraded: false, is_delayed: false, as_of: null,
    }] });
    expect(unknown.quoteStatus).toBe("Time unavailable");
    expect(unknown.quotedAt).toBeNull();
  });

  it("restores each unavailable index from cache even when market status is usable", () => {
    const payload = withStableOverviewFromCache({ market_overview: [
      { ...quote, value: null, degraded: true },
      { label: "Market Status", value: "Open", delta_pct: null, as_of: null, source: "Schedule", degraded: false },
    ] }, { market_overview: [{ ...quote, degraded: false, is_delayed: false }] });
    expect(payload.market_overview?.[0]).toMatchObject({ value: 7712.57, degraded: true, as_of: quote.as_of });
    expect(toIndexStripItems(payload)[0].quoteStatus).toBe("");
    expect(toIndexStripItems(payload)[0].quotedAt).toBe(quote.as_of);
    const metrics = toIndexStripItems(payload);
    const { container } = render(createElement(OneMarketIndexStrip, { metrics, onMetricSelect: () => {} }));
    expect(container.textContent).not.toMatch(/cached/i);
    expect(metrics[0].detailPanel?.statusLabel).toBe("");
    expect(metrics[0].degraded).toBe(true);
    const next = withStableOverviewFromCache({ market_overview: [{ ...quote, value: 7800, degraded: false }] }, payload);
    expect(next.market_overview?.[0].value).toBe(7800);
  });
});

describe("toMoverGroups", () => {
  const time = "2026-10-21T14:00:00Z";
  const mover = (symbol: string, change_pct: number, degraded = true, as_of: string | null = time) => ({
    symbol, company_name: `${symbol} Company`, price: 10, change_pct, volume: 1, degraded, as_of,
  });
  const groupsFor = (gainers: ReturnType<typeof mover>[], losers: ReturnType<typeof mover>[], degraded = false) => toMoverGroups({
    movers: { gainers, losers, active: [mover("HIDDEN", 1, false)], degraded },
  } as unknown as KaiHomeInsightsV2);

  it("opens the clicked mover through the ticker preview contract", () => {
    const navigate = vi.fn();
    window.addEventListener("app-internal-navigation-requested", navigate);
    try {
      render(createElement(OneMarketMovers, { groups: groupsFor([mover("AAPL", 1)], []) }));
      fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));
      expect(navigate).toHaveBeenCalledOnce();
      const href = (navigate.mock.calls[0]![0] as CustomEvent<{ href: string }>).detail.href;
      expect(href).toBe("/one/kai?tab=analysis&ticker=AAPL");
    } finally {
      window.removeEventListener("app-internal-navigation-requested", navigate);
    }
  });

  it("keeps three ranks and a common local observation time without cache wording", () => {
    const groups = groupsFor([mover("A", 4), mover("B", 3), mover("C", 2), mover("FOURTH", 1, false)], [mover("D", -1)]);
    const { container } = render(createElement(OneMarketMovers, { groups }));
    expect(container.querySelectorAll("button")).toHaveLength(4);
    expect(container.querySelectorAll("[data-market-mover-freshness]")).toHaveLength(1);
    expect(container.querySelector("[data-market-mover-freshness]")).toHaveTextContent(formatLocalDateTime(time)!);
    expect(container.querySelectorAll("[data-market-mover-empty]")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/cached/i);
    expect(screen.queryByText("Cached", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("FOURTH", { exact: true })).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-market-mover-pair]")).toHaveLength(3);
  });

  it("retains differing local times and unavailable observations without cache labels", () => {
    const later = "2026-10-21T15:00:00Z";
    const { container, rerender } = render(createElement(OneMarketMovers, { groups: groupsFor([mover("A", 1)], [mover("B", -1, false, later)]) }));
    expect(container.querySelector("[data-market-mover-freshness]")).toBeNull();
    expect([...container.querySelectorAll("time")].map(node => node.textContent)).toEqual(
      [time, later].map(value => formatLocalDateTime(value, { hour: "numeric", minute: "2-digit" })),
    );
    rerender(createElement(OneMarketMovers, { groups: groupsFor([mover("A", 1)], [mover("B", -1, true, null)]) }));
    expect(screen.getByText("Time unavailable", { exact: true })).toBeVisible();
    expect(container.querySelectorAll("button > time")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/cached/i);
    rerender(createElement(OneMarketMovers, { groups: groupsFor([], []) }));
    expect(container.querySelectorAll("[data-market-mover-pair]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-market-mover-empty]")).toHaveLength(6);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/cached|[+-]\d/);
  });

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
  it("routes the Market News preview to the full news workspace, never Analysis", () => {
    const source = readFileSync(
      join(process.cwd(), "components/kai/views/kai-market-preview-view.tsx"),
      "utf8",
    );

    expect(source).toContain('actionLabel="All news"');
    expect(source).toContain("actionHref={ROUTES.KAI_NEWS}");
    expect(source).not.toContain('actionHref={buildKaiMarketRoute("analysis")}');
  });

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
    // The title is not drawn (the bar and the tab already name the screen),
    // so the status sits on its own line: inline, it took the right half and
    // wrapped the description after three words.
    expect(workspaceHeader).toContain("titleVisuallyHidden");
    expect(source).not.toContain("actionsInlineMobile");
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

  it("lets a stock preview return to recommendations without the archived global Search", () => {
    const analysis = readFileSync(
      join(process.cwd(), "app/one/kai/analysis/page.tsx"),
      "utf8",
    );
    const preview = readFileSync(
      join(process.cwd(), "components/kai/cards/stock-comparison-preview.tsx"),
      "utf8",
    );

    expect(preview).toContain("Recommendations");
    expect(preview).toContain("Change stock");
    expect(preview).toContain("onBrowseRecommendations");
    expect(preview).toContain("onChangeStock");
    expect(analysis).toContain("handleBrowseRecommendations");
    expect(analysis).toContain('router.replace(buildKaiMarketRoute("analysis"), { scroll: false })');
    expect(analysis).toContain("onBrowseRecommendations={handleBrowseRecommendations}");
    expect(analysis).not.toContain("openKaiCommandBar");
  });

  it('labels the preview start button "Start analysis debate" on every surface', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
    const analysis = read("app/one/kai/analysis/page.tsx");
    const preview = read("components/kai/cards/stock-comparison-preview.tsx");
    const voice = JSON.parse(read("components/kai/analysis-controls.voice-action-contract.json")) as {
      actions: Array<{ action_id: string; aliases: string[] }>;
    };

    for (const source of [analysis, preview]) {
      expect(source).toContain('"Start analysis debate"');
      expect(source).not.toContain(': "Start debate"');
    }
    // Saying the button's text reaches the same action; the id is unchanged.
    const confirm = voice.actions.find((action) => action.action_id === "analysis.confirm_preview");
    expect(confirm?.aliases).toContain("start analysis debate");
  });
});
