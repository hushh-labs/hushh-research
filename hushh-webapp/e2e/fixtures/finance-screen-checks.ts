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
        const overview = page.getByTestId("portfolio-overview-fixture");
        await overview.scrollIntoViewIfNeeded();
        await expect(overview.getByText("Invested", { exact: true })).toBeVisible();
        expect(await overview.getByRole("heading", { name: "Your portfolio" }).evaluate(el => getComputedStyle(el).fontSize)).toBe("14px");
        await expect(overview.getByText("$2,000.00", { exact: true })).toBeVisible();
        await expect(overview.getByText("Value history isn’t available for this source yet.")).toBeVisible();
        if (width >= 1024) {
          const value = await overview.getByTestId("portfolio-value-card").boundingBox();
          const options = await overview.getByTestId("portfolio-overview-options").boundingBox();
          expect(Math.abs(value!.y - options!.y)).toBeLessThanOrEqual(2);
        }
        await overview.screenshot({ path: test.info().outputPath(`overview-${width}-${theme}.png`) });
        await overview.getByRole("button", { name: "Share portfolio PDF" }).click();
        const report = page.getByRole("dialog", { name: "Portfolio report", exact: true });
        await expect(report.getByText("No value history is available for this source.")).toBeVisible();
        await report.getByRole("button", { name: "Export PDF" }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Export report");
        await page.keyboard.press("Escape");
        await expect(report).toHaveCount(0);
        await overview.getByTestId("portfolio-open-holdings").click();
        await expect(page.getByTestId("action-result")).toHaveText("Open holdings");
        await overview.getByRole("button", { name: "Open sample holding" }).click();
        const holding = page.getByRole("dialog", { name: "TEST", exact: true });
        await expect(holding.getByText("$21,000.00", { exact: true })).toBeVisible();
        expect(await holding.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await holding.getByRole("button", { name: "Edit Holding" }).click();
        await expect(page.getByTestId("action-result")).toHaveText("Edit sample");
        await page.keyboard.press("Escape");
        await expect(holding).toHaveCount(0);
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
