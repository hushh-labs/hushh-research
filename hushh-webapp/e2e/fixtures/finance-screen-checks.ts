import { expect, test, type Locator, type Page } from "@playwright/test";

export async function expectMarketIndexChart(detail: Locator): Promise<void> {
  const chart = detail.getByRole("region", { name: "Intraday index history" });
  const line = chart.locator("path.recharts-area-curve");
  await expect(line).toHaveAttribute("d", /^M/);
  await expect(chart).toHaveAttribute("data-index-chart-tone", "positive");
  await expect(chart).toHaveAttribute("data-no-route-swipe", "true");
  await expect(chart.locator("path.recharts-area-area")).toHaveAttribute("fill", /^url\(#index-/);
  await expect(chart.locator(".recharts-reference-line line")).toHaveAttribute("stroke-dasharray", "3 4");
  await expect(chart.getByText(/Guide: first observed level 7,695.00 points/)).toBeVisible();
  const geometry = await line.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, stroke: getComputedStyle(element).stroke, color: getComputedStyle(element).color }));
  expect(geometry.width).toBeGreaterThan(100);
  expect(geometry.height).toBeGreaterThan(10);
  expect(geometry.stroke).not.toBe("none");
  expect(geometry.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(await detail.evaluate(element => {
    const value = [...element.querySelectorAll("p")].find(row => row.textContent === "7,712.57")!;
    return value.getBoundingClientRect().top < element.querySelector("path.recharts-area-curve")!.getBoundingClientRect().top;
  })).toBe(true);
  await detail.screenshot({ path: test.info().outputPath("index-detail.png") });
}

export async function expectMarketMiniCharts(page: Page): Promise<void> {
  const charts = page.locator("[data-index-chart-tone]");
  await expect(charts).toHaveCount(4);
  for (const chart of await charts.all()) {
    await expect(chart.locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
    await expect(chart.locator("path.recharts-area-area")).toHaveAttribute("fill", /^url\(#index-/);
  }
  const ids = await page.locator("linearGradient[id^='index-']").evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(ids).size).toBe(4);
  // The chart root owns the direction; cached status never desaturates its series.
  expect(await page.locator("[data-index-chart-tone='positive']").count()).toBe(1);
  expect(await page.locator("[data-index-chart-tone='negative']").count()).toBe(3);
  const stroke = async (tone: string) => page.locator(`[data-index-chart-tone='${tone}'] path.recharts-area-curve`).first().evaluate(element => getComputedStyle(element).stroke);
  expect(await stroke("positive")).not.toBe(await stroke("negative"));
  const strip = page.getByRole("button", { name: /^S&P 500:/ }).locator("..");
  await strip.scrollIntoViewIfNeeded();
  await strip.screenshot({ path: test.info().outputPath("market-indices.png") });
}

export function registerFinanceScreenChecks(
  mount: (page: Page, width?: number) => Promise<void>
): void {
  for (const width of [360, 393, 430, 1024, 1440]) {
    for (const theme of ["light", "dark"]) {
      test(`Finance complete screens ${width}px ${theme}`, async ({ page }) => {
        await mount(page, width);
        await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
        const importShell = page.getByTestId("finance-import-fixture").locator("[data-fullscreen-flow-shell]");
        expect(await importShell.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(880);
        expect(await importShell.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const overview = page.getByTestId("portfolio-overview-fixture");
        await overview.scrollIntoViewIfNeeded();
        const importAction = overview.getByRole("button", { name: "Import portfolio", exact: true });
        const manageAction = overview.getByRole("button", { name: "Manage portfolio", exact: true });
        const importBox = (await importAction.boundingBox())!;
        const manageBox = (await manageAction.boundingBox())!;
        await expect(overview.getByTestId("portfolio-overview-options")).toHaveCount(0);
        const valueBox = (await overview.getByTestId("portfolio-value-card").boundingBox())!;
        expect(importBox.y).toBeGreaterThanOrEqual(valueBox.y + valueBox.height);
        expect(manageBox.y).toBeGreaterThanOrEqual(valueBox.y + valueBox.height);
        expect(importBox.x + importBox.width).toBeLessThanOrEqual(manageBox.x);
        expect(Math.abs(importBox.y - manageBox.y)).toBeLessThanOrEqual(1);
        await importAction.click();
        await expect(page.getByTestId("action-result")).toHaveText("Import portfolio");
        await manageAction.click();
        await expect(page.getByTestId("action-result")).toHaveText("Open sources");
        await expect(overview.getByText("Invested", { exact: true })).toBeVisible();
        await expect(overview.getByRole("heading", { name: "Your portfolio", exact: true })).toHaveCount(0);
        expect(await overview.evaluate(el => getComputedStyle(el).getPropertyValue("--font-app-body").trim()))
          .toBe(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--font-app-body").trim()));
        await expect(overview.getByText("$2,000.00", { exact: true })).toBeVisible();
        await expect(overview.getByText("Balance snapshot · This source hasn’t supplied dated balance history.")).toBeVisible();
        if (width >= 1024) {
          // The workspace should use the available content width rather than
          // introducing a second, narrower reading measure below the tabs.
          const widths = await overview.evaluate(element => {
            const parent = element.parentElement!;
            const style = getComputedStyle(parent);
            const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return { available, workspace: element.getBoundingClientRect().width };
          });
          expect(Math.abs(widths.workspace - widths.available)).toBeLessThanOrEqual(1);
          const value = await overview.getByTestId("portfolio-value-card").boundingBox();
          const briefing = await overview.getByTestId("portfolio-briefing").boundingBox();
          expect(Math.abs(value!.y - briefing!.y)).toBeLessThanOrEqual(2);
          expect(value!.x + value!.width).toBeLessThanOrEqual(briefing!.x);
        }
        await overview.screenshot({ path: test.info().outputPath(`overview-${width}-${theme}.png`) });
        await overview.getByRole("button", { name: "Share portfolio PDF" }).click();
        const report = page.getByRole("dialog", { name: "Portfolio report", exact: true });
        await expect(report.getByText("No value history is available for this source.")).toBeVisible();
        await report.getByRole("button", { name: "Export PDF" }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Export report");
        await page.keyboard.press("Escape");
        await expect(report).toHaveCount(0);
        await overview.getByRole("button", { name: /^All \d+/ }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Open holdings");
        await overview.getByRole("button", { name: "Open sample holding" }).click();
        const holding = page.getByRole("dialog", { name: "TEST", exact: true });
        await expect(holding.getByText("$21,000.00", { exact: true })).toBeVisible();
        expect(await holding.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const holdingChart = holding.getByRole("region", { name: "Price history", exact: true });
        await expect(holdingChart.locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
        await expect.poll(() => holdingChart.evaluate(el => {
          const line = el.querySelector("path.recharts-area-curve")!.getBoundingClientRect();
          return line.width >= el.clientWidth - 85;
        })).toBe(true);
        const facts = holding.locator('dl[aria-label="Holding details"]');
        // Measure after the drawer settles and in one frame so its motion cannot
        // put chart and facts measurements in different coordinate frames.
        await expect.poll(() => holding.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
        await expect(async () => {
          const geometry = await holding.evaluate(element => {
            const sheet = element.getBoundingClientRect();
            const chart = element.querySelector('[aria-label="Price history"]')!.getBoundingClientRect();
            const facts = element.querySelector('dl[aria-label="Holding details"]')!.getBoundingClientRect();
            const close = element.querySelector("[data-slot='drawer-close']")!.getBoundingClientRect();
            const header = element.querySelector("[data-slot='drawer-header']")!.getBoundingClientRect();
            const title = element.querySelector("[data-slot='drawer-title']")!.parentElement!.getBoundingClientRect();
            return {
              sheetWidth: sheet.width, sheetX: sheet.x,
              chartWidth: chart.width, chartRight: chart.right, chartBottom: chart.bottom,
              factsX: facts.x, factsY: facts.y,
              hitSize: Math.min(close.width, close.height),
              centerGap: Math.abs(close.y + close.height / 2 - title.y - title.height / 2),
              rightInset: header.right - close.right,
            };
          });
          // Transformed coordinates can round a 44px target down by a tiny fraction.
          expect(geometry.hitSize + 0.0001).toBeGreaterThanOrEqual(44);
          expect(geometry.centerGap).toBeLessThanOrEqual(1);
          expect(Math.abs(geometry.rightInset - 20)).toBeLessThanOrEqual(1);
          if (width >= 1024) {
            expect(geometry.sheetWidth).toBeLessThanOrEqual(1120);
            expect(Math.abs(geometry.sheetX - (width - geometry.sheetWidth) / 2)).toBeLessThanOrEqual(2);
            expect(geometry.chartRight).toBeLessThanOrEqual(geometry.factsX);
            expect(geometry.chartWidth).toBeGreaterThan(400);
          } else {
            expect(geometry.factsY).toBeGreaterThanOrEqual(geometry.chartBottom);
          }
        }).toPass({ timeout: 5_000 });
        expect(await facts.locator("dd").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("14px");
        await holding.screenshot({ path: test.info().outputPath(`holding-${width}-${theme}.png`) });
        await holding.getByRole("button", { name: "Edit Holding" }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Edit sample");
        await holding.getByRole("button", { name: "Close", exact: true }).click();
        await expect(holding).toHaveCount(0);
        if (width >= 1024) {
          const table = page.getByTestId("holdings-table-fixture");
          await table.scrollIntoViewIfNeeded();
          expect(await table.locator("table").evaluate(el => el.getBoundingClientRect().width <= el.closest("[data-testid]")!.clientWidth)).toBe(true);
          await expect(table.getByText("$22,680.42", { exact: true })).toBeVisible();
          await table.screenshot({ path: test.info().outputPath(`holdings-table-${width}-${theme}.png`) });
        }
        const history = page.getByTestId("finance-history-fixture");
        await history.getByRole("button", { name: "Open TEST analysis" }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Open saved");
        await history.getByRole("button", { name: "Versions for TEST" }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Open versions");
        expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await history.screenshot({ path: test.info().outputPath(`history-${width}-${theme}.png`) });
        const subpages = page.getByTestId("finance-subpages-fixture");
        await expect(subpages.getByText(/Full investment thesis remains readable/)).toBeVisible();
        await expect(subpages.getByText(/Quote as of/)).toBeVisible();
        await expect(subpages.getByText("Tier KING", { exact: true })).toBeVisible();
        await expect(subpages.getByRole("button", { name: "Start analysis debate" })).toBeVisible();
        expect(await subpages.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await subpages.screenshot({ path: test.info().outputPath(`subpages-${width}-${theme}.png`) });
      });
    }
  }
}

export function registerHoldingEntryChecks(mount: (page: Page, width?: number) => Promise<void>): void {
  for (const width of [393, 1440]) {
    for (const theme of ["light", "dark"]) {
      test(`Portfolio entries stay grouped through edit, add and removal at ${width}px ${theme}`, async ({ page }) => {
        await mount(page, width);
        await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
        const list = page.getByTestId("grouped-holdings-fixture");
        if (width < 768) await list.getByRole("button", { name: "View TEST entries" }).click();
        else {
          await expect(list.locator("tbody tr")).toHaveCount(1);
          await list.getByRole("button", { name: "Manage entries", exact: true }).click();
        }
        const detail = page.getByRole("dialog", { name: "TEST", exact: true });
        const entryList = detail.getByRole("region", { name: "Your entries" });
        const shares = () => detail.getByText("Shares", { exact: true }).locator("..").locator("dd");
        await expect(entryList.getByRole("listitem")).toHaveCount(2);
        await expect(shares()).toHaveText("15");
        await expect(detail.getByRole("region", { name: "Price history", exact: true })).toHaveCount(1);
        await entryList.getByRole("button", { name: "Edit entry 2" }).click();
        const editor = page.getByRole("dialog", { name: "Edit Holding", exact: true });
        await expect(editor).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(1);
        const quantity = editor.getByLabel(/^quantity/i);
        await quantity.fill("0");
        await editor.getByRole("button", { name: /save/i }).click();
        await expect(quantity).toBeFocused();
        await expect(quantity).toHaveAttribute("aria-invalid", "true");
        await expect(quantity).toHaveAccessibleDescription("Enter a quantity other than 0.");
        expect(await quantity.evaluate(element => {
          const field = element.getBoundingClientRect();
          const viewport = element.closest(".overflow-y-auto")!.getBoundingClientRect();
          return field.top >= viewport.top && field.bottom <= viewport.bottom;
        })).toBe(true);
        await editor.screenshot({ path: test.info().outputPath(`holding-validation-${width}-${theme}.png`) });
        await editor.getByLabel(/quantity/i).fill("7");
        await editor.getByLabel(/cost basis/i).fill("840");
        await editor.getByRole("button", { name: /save/i }).click();
        await expect(shares()).toHaveText("17");
        await expect(entryList.getByText("Acquired 2026-05-10", { exact: true })).toBeVisible();
        await entryList.getByRole("button", { name: "Add entry", exact: true }).click();
        await expect(editor).toBeVisible();
        await editor.getByLabel(/quantity/i).fill("2");
        await editor.getByLabel(/^price/i).fill("130");
        await editor.getByLabel(/cost basis/i).fill("260");
        await editor.getByRole("button", { name: /save/i }).click();
        await expect(entryList.getByRole("listitem")).toHaveCount(3);
        await expect(shares()).toHaveText("19");
        await entryList.getByRole("button", { name: "Remove entry 1" }).click();
        await expect(shares()).toHaveText("9");
        await entryList.getByRole("button", { name: "Restore entry 1" }).click();
        await expect(shares()).toHaveText("19");
        expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        for (const button of await entryList.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: test.info().outputPath(`grouped-holding-${width}-${theme}.png`) });
      });
    }
  }
}

export function registerStockQuoteRecoveryChecks(mount: (page: Page, width?: number) => Promise<void>): void {
  for (const width of [393, 1440]) for (const theme of ["light", "dark"]) {
    test(`Stock quote recovery keeps history and facts available at ${width}px ${theme}`, async ({ page }) => {
      await mount(page, width);
      await page.evaluate(mode => {
        document.documentElement.classList.toggle("dark", mode === "dark");
        document.body.dataset.quoteMode = "unavailable";
      }, theme);
      expect(await page.evaluate(() => document.body.dataset.quoteReads)).toBeUndefined();
      const stocks = page.getByTestId("market-iphone-fixture");
      await stocks.getByRole("searchbox", { name: "Search stocks" }).fill("Berkshire");
      await stocks.getByTestId("market-pick-row").click();
      const detail = page.getByRole("dialog", { name: "Berkshire Hathaway Inc. Class B", exact: true });
      const quote = detail.getByRole("region", { name: "Stock quote", exact: true });
      await expect(quote.getByText("Unavailable", { exact: true })).toBeVisible();
      const retry = quote.getByRole("button", { name: "Retry quote", exact: true });
      await expect(retry).toBeVisible();
      await expect(detail.getByRole("region", { name: "Price history", exact: true }).locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
      await expect(detail.getByRole("region", { name: "Company facts", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.body.dataset.quoteReads)).toBe("1");
      await page.evaluate(() => { delete document.body.dataset.quoteMode; });
      await retry.click();
      await expect(quote.getByText("$456.78", { exact: true })).toBeVisible();
      await expect(quote.getByText(/Cached quote/)).toBeVisible();
      expect(await page.evaluate(() => document.body.dataset.quoteReads)).toBe("2");
      expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await detail.screenshot({ path: test.info().outputPath(`stock-quote-recovered-${width}-${theme}.png`) });
    });
  }
}

export async function expectMarketLocalTimes(page: Page, localTime: string): Promise<void> {
  const movers = page.getByRole("region", { name: "Market movers", exact: true });
  await expect(movers.locator("[data-market-mover-pair]")).toHaveCount(3);
  await expect(movers.getByRole("button")).toHaveCount(6);
  await expect(movers.locator("[data-market-mover-freshness]")).toContainText(localTime);
  await expect(page.locator("body")).not.toContainText(/\bcached\b/i);
  const index = page.getByRole("button", { name: /^S&P 500:/ });
  await expect(index.locator("time")).toHaveText(localTime);
  await expect(index.locator("time")).toHaveAttribute("datetime", "2026-10-21T14:00:00Z");
  await index.click();
  const detail = page.getByRole("dialog", { name: "S&P 500", exact: true });
  await expect(detail.locator("dl")).toContainText(localTime);
  await expect(detail).not.toContainText(/\bcached\b/i);
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
}

export function registerFinanceChartChecks(mount: (page: Page, width?: number) => Promise<void>): void {
for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`Finance chart review ${width}px ${theme}`, async ({ page }) => {
      await mount(page, width);
      await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
      const portfolio = page.getByTestId("portfolio-chart-fixture");
      await portfolio.scrollIntoViewIfNeeded();
      await expect(portfolio.locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
      // Panels fill the tab column (asserted on the identically styled overview
      // section above); only overflow is checked here, not a 728px reading cap.
      expect(await portfolio.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`portfolio-${width}-${theme}.png`) });
      const stocks = page.getByTestId("market-iphone-fixture");
      const search = stocks.getByRole("searchbox", { name: "Search stocks" });
      await search.fill("Berkshire");
      await expect(stocks.getByTestId("market-pick-row")).toHaveCount(1);
      const row = stocks.getByTestId("market-pick-row").first();
      const typography = await row.locator("[data-stock-name]").evaluate(el => ({ family: getComputedStyle(el).fontFamily, size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
      expect(typography.family).toContain("Plus Jakarta Sans");
      expect(typography.size).toBe("14px");
      expect(typography.weight).toBe("550");
      await row.click();
      const detail = page.getByRole("dialog", { name: "Berkshire Hathaway Inc. Class B", exact: true });
      await expect(detail.getByText("$456.78", { exact: true })).toBeVisible();
      const chart = detail.getByRole("region", { name: "Price history", exact: true });
      await expect(chart.locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
      const range = chart.getByRole("button", { name: "1W", exact: true });
      await expect.poll(async () => (await range.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await range.click();
      await expect(range).toHaveAttribute("aria-pressed", "true");
      await expect(chart.getByRole("button", { name: "1D", exact: true })).toHaveCount(0);
      expect(await detail.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const ids = await page.locator("linearGradient[id^='price-']").evaluateAll(nodes => nodes.map(node => node.id));
      expect(new Set(ids).size).toBe(ids.length);
      const profile = detail.locator("details").filter({ hasText: "Full company profile" });
      await profile.locator("summary").scrollIntoViewIfNeeded();
      await expect(detail.getByRole("listitem")).toHaveCount(2);
      await expect(profile).not.toHaveAttribute("open");
      expect((await profile.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await profile.locator("summary").click();
      await expect(profile.getByText(/Additional details remain available/)).toBeVisible();
      await profile.locator("summary").click();
      await page.screenshot({ path: test.info().outputPath(`stock-detail-${width}-${theme}.png`) });
      await detail.getByRole("button", { name: /^Close(?: detail panel)?$/, exact: true }).click();
      await expect(detail).toHaveCount(0);
      await expect(search).toHaveValue("Berkshire");
    });
  }
}
}
