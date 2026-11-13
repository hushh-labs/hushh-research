import { registerAdvisorReviewChecks } from "./fixtures/advisor-review-checks";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { expectMarketIndexChart, expectMarketMiniCharts, registerFinanceScreenChecks, registerFinanceChartChecks, registerHoldingEntryChecks, registerStockQuoteRecoveryChecks, expectMarketLocalTimes } from "./fixtures/finance-screen-checks";
import os from "node:os";
import { registerFinanceSharingChecks } from "./fixtures/finance-sharing-checks";
import { registerFinanceOnboardingChecks } from "./fixtures/finance-onboarding-checks";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let marketScript: string;
let saveActionClass: string;
let importShellClasses: string[];
let fixtureOutDir: string | undefined;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const reviewSource = fs.readFileSync(path.join(root, "components/kai/views/portfolio-review-view.tsx"), "utf8");
  saveActionClass = reviewSource.match(/data-portfolio-review-save\s+className="([^"]+)"/)![1];
  importShellClasses = [
    "app/one/kai/import/page.tsx",
    "app/one/setup/finance/import/finance-import-onboarding-setup-client.tsx",
  ].map(file => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const shell = source.match(/<FullscreenFlowShell\b[^>]*className=(?:"([^"]+)"|\{`\$\{styles\.setupFlowShell\} ([^`]+)`\})/);
    return shell![1] ?? shell![2];
  });
  const shellFixtureClasses = ["h-full min-h-0 flex flex-col w-full pb-4", saveActionClass, ...importShellClasses];
  for (const candidate of scanner.scanFiles([{ content: shellFixtureClasses.join(" "), extension: "html" }])) candidates.add(candidate);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-markdown-"));
  fixtureOutDir = outDir;
  await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }]))
              candidates.add(candidate);
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: {
      alias: [
        ...["@/lib/advisor-review/service", "@/lib/advisor-review/snapshot", "@/lib/services/google-calendar-service", "@/lib/services/kai-profile-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/advisor-review-boundaries.ts") })),
        ...["@/lib/finance-sharing/use-finance-share-context", "@/lib/finance-sharing/saved-source", "@/lib/services/finance-sharing-service", "@/lib/finance-sharing/portfolio-review-cache"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/finance-sharing-boundaries.ts") })),
        { find: /^@\/lib\/kai\/ticker-universe-cache$/, replacement: path.join(root, "e2e/fixtures/finance-market-boundaries.ts") },
        { find: /^@\/lib\/kai\/kai-market-home-resource$/, replacement: path.join(root, "e2e/fixtures/finance-market-boundaries.ts") },
        { find: /^next\/navigation$/, replacement: path.join(root, "e2e/fixtures/agent-markdown-boundaries.ts") },
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/finance-interactions.tsx"),
        name: "Fixture",
        cssFileName: "finance-interactions",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const boundary = path.join(root, "e2e/fixtures/finance-market-boundaries.ts");
  await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    plugins: [{
      name: "market-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }]))
            candidates.add(candidate);
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: {
      alias: [
        ...["@/lib/advisor-review/service", "@/lib/advisor-review/snapshot", "@/lib/services/google-calendar-service", "@/lib/services/kai-profile-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/advisor-review-boundaries.ts") })),
        ...[
          "next/navigation", "@/hooks/use-auth", "@/lib/firebase/auth-context",
          "@/lib/vault/vault-context", "@/lib/cache/use-stale-resource",
          "@/lib/kai/kai-financial-resource", "@/lib/kai/kai-market-home-resource",
          "@/lib/kai/kai-market-news-resource", "@/lib/services/api-service",
          "@/lib/services/kai-token-guard", "@/lib/kai/actions/voice-surface-metadata",
        ].map(find => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: boundary })),
        ...["@/lib/finance-sharing/use-finance-share-context", "@/lib/finance-sharing/saved-source", "@/lib/services/finance-sharing-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/finance-sharing-boundaries.ts") })),
        { find: "@", replacement: root },
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/finance-market.tsx"),
        name: "MarketFixture",
        cssFileName: "finance-market",
        formats: ["iife"],
        fileName: () => "market.js",
      },
    },
  });
  marketScript = fs.readFileSync(path.join(outDir, "market.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
              : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  const featureCss = fs.readdirSync(outDir).filter(file => file.endsWith(".css"))
    .map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() + featureCss;
});

for (const width of [320, 360, 375, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"]) test.describe(`${width}px ${theme} local time`, () => {
    test.use({ locale: "en-US", timezoneId: theme === "light" ? "Asia/Kolkata" : "America/Los_Angeles" });
    test(`Market briefing stays readable and fits at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 932 });

      await page.route("http://localhost/finance-market", route => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html class="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{height:auto}</style></head><body><div id="root"></div></body></html>`,
      }));
      await page.goto("http://localhost/finance-market");
      await page.evaluate(() => {
        window.addEventListener("app-internal-navigation-requested", event => {
          document.body.dataset.navigationHref = (event as CustomEvent).detail.href;
        });
      });
      await page.addScriptTag({ content: marketScript });
      await awaitProductFont(page);

      await expectMarketMiniCharts(page);
      const action = page.getByRole("button", { name: "All news", exact: true });
      await expect(action).toBeVisible();
      const target = await action.boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(44);
      expect(target!.width).toBeGreaterThanOrEqual(44);
      const card = page.getByRole("button").filter({ hasText: "A longer market headline" });
      await expect(card).toBeVisible();
      const measurements = await card.evaluate(el => {
        const headline = el.querySelector("span > span")!;
        const metadata = headline.nextElementSibling!;
        const headlineStyle = getComputedStyle(headline);
        const metadataStyle = getComputedStyle(metadata);
        return {
          font: headlineStyle.fontFamily,
          headline: [headlineStyle.fontSize, headlineStyle.lineHeight, headlineStyle.fontWeight],
          metadata: [metadataStyle.fontSize, metadataStyle.lineHeight],
          clamp: headlineStyle.webkitLineClamp,
          cardOverflow: el.scrollWidth > el.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          railOverflow: el.parentElement!.scrollWidth > el.parentElement!.clientWidth,
        };
      });
      expect(measurements.font).toMatch(/Plus Jakarta Sans/);
      expect(measurements.headline).toEqual(["14px", "21px", "600"]);
      expect(measurements.metadata).toEqual(["12px", "18px"]);
      expect(measurements.clamp).toBe("none");
      expect(measurements.cardOverflow).toBe(false);
      expect(measurements.pageOverflow).toBe(false);
      expect(measurements.railOverflow).toBe(false);
      const movers = page.getByRole("region", { name: "Market movers", exact: true });
      await movers.scrollIntoViewIfNeeded();
      await expect(movers.getByRole("button")).toHaveCount(6);
      await expect(movers.locator("[data-market-mover-empty]")).toHaveCount(0);
      if (width >= 1024) {
        const sectorCard = page.getByRole("region", { name: "Sector rotation", exact: true }).locator(":scope > [data-surface-tone]");
        const moverCard = movers.locator(":scope > [data-surface-tone]");
        const sectorBounds = await sectorCard.boundingBox();
        const moverBounds = await moverCard.boundingBox();
        expect(moverBounds!.y).toBeGreaterThan(sectorBounds!.y + sectorBounds!.height);
        expect(Math.abs(sectorBounds!.width - moverBounds!.width)).toBeLessThanOrEqual(1);
      }
      const gainsHeading = movers.getByRole("heading", { name: "Gainers", exact: true });
      const lossesHeading = movers.getByRole("heading", { name: "Losers", exact: true });
      const headingPaint = (heading: typeof gainsHeading) => heading.evaluate(element => ({
        background: getComputedStyle(element).backgroundColor,
        text: getComputedStyle(element.querySelector("span")!).color,
      }));
      const gainsPaint = await headingPaint(gainsHeading);
      const lossesPaint = await headingPaint(lossesHeading);
      expect(gainsPaint.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(gainsPaint.background).not.toBe(lossesPaint.background);
      expect(gainsPaint.text).not.toBe(lossesPaint.text);
      const gainers = await gainsHeading.boundingBox();
      const decliners = await lossesHeading.boundingBox();
      if (width < 640) {
        expect(decliners!.y).toBeGreaterThan(gainers!.y + gainers!.height);
      } else {
        expect(Math.abs(gainers!.y - decliners!.y)).toBeLessThanOrEqual(1);
        expect(gainers!.x + gainers!.width).toBeLessThanOrEqual(decliners!.x);
        for (const rank of [0, 1, 2]) {
          const rows = movers.locator(`[data-market-mover-rank="${rank}"]`);
          const first = (await rows.nth(0).boundingBox())!;
          const second = (await rows.nth(1).boundingBox())!;
          expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(1);
        }
      }
      expect(await movers.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expectMarketLocalTimes(page, theme === "light" ? "7:30 PM" : "7:00 AM");

      for (const mover of await movers.getByRole("button").all()) {
        await expect(mover).toBeVisible();
        expect(await mover.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const quote = mover.locator(":scope > span").first();
        const ticker = await quote.locator(":scope > span").first().boundingBox();
        const percentage = await quote.locator(":scope > span").last().boundingBox();
        expect(Math.abs(ticker!.y - percentage!.y)).toBeLessThanOrEqual(1);
        expect(ticker!.x + ticker!.width).toBeLessThanOrEqual(percentage!.x);
        expect(await quote.locator(":scope > span").last().evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
        const company = mover.locator(":scope > span").nth(1);
        expect(await company.evaluate(element => {
          const style = getComputedStyle(element);
          return [style.fontSize, style.lineHeight, style.webkitLineClamp, element.scrollHeight <= element.clientHeight];
        })).toEqual(["12px", "18px", "none", true]);

      }
      await movers.screenshot({ path: test.info().outputPath(`finance-movers-${width}-${theme}.png`) });
      await action.click();
      await expect(page.locator("body")).toHaveAttribute("data-navigation-href", "/one/kai/news");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`finance-${width}-${theme}.png`) });
    });
  });
}

for (const result of ["success", "error"]) {
  test(`All news ignores an obsolete page ${result} after its snapshot changes`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 932 });
    await page.route("http://localhost/finance-market-news-fixture", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-defer-news="true"><div id="root"></div></body></html>`,
    }));
    await page.goto("http://localhost/finance-market-news-fixture");
    await page.addScriptTag({ content: marketScript });
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-news-pending", "true");
    await page.evaluate(() => window.dispatchEvent(new Event("finance-fixture-replace-news")));
    await expect(page.getByText("Latest replacement headlines", { exact: true })).toBeVisible();
    await page.evaluate(outcome => window.dispatchEvent(new CustomEvent("finance-fixture-complete-news", { detail: outcome })), result);
    await expect(page.locator("body")).toHaveAttribute("data-news-pending", "false");
    await expect(page.locator("article")).toHaveCount(1);
    await expect(page.getByText("More headlines from the same snapshot", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-news-refreshed", "true");
  });
}

test.afterAll(() => {
  if (fixtureOutDir) fs.rmSync(fixtureOutDir, { recursive: true, force: true });
});


async function mount(page: Page, width = 393, onboarding = false, advisorOnly = false) {
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.setViewportSize({ width, height: 852 });

  await page.route("http://localhost/finance-fixture", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{height:auto}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/finance-fixture");
  if (onboarding) await page.evaluate(() => { document.body.dataset.financeOnboarding = "true"; });
  if (advisorOnly) await page.evaluate(() => { document.body.dataset.advisorOnly = "true"; });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => Boolean(document.querySelector("#root > main")), undefined, { timeout: 5000 }).catch(error => {
    throw new Error(runtimeErrors.join("\n") || String(error));
  });
  expect(runtimeErrors).toEqual([]);
  await awaitProductFont(page);

}

test("finance swipe keeps a gap during drag and full-width settled cards", async ({ page }) => {
  await mount(page, 393);
  const fixture = page.getByTestId("finance-swipe-gap");
  await fixture.scrollIntoViewIfNeeded();
  const first = page.getByTestId("swipe-card-market");
  const second = page.getByTestId("swipe-card-portfolio");
  const viewport = fixture.locator('[data-swipe-views-root="true"]');
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + 70);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + 70, { steps: 8 });
  const a = (await first.boundingBox())!;
  const b = (await second.boundingBox())!;
  const v = (await viewport.boundingBox())!;
  expect(Math.abs((b.x - (a.x + a.width)) - 24)).toBeLessThan(2);
  expect(Math.abs(a.width - v.width)).toBeLessThan(2);
  await page.mouse.up();
  await fixture.getByRole("button", { name: "Swipe portfolio" }).click();
  await expect(async () => {
    const settled = (await second.boundingBox())!;
    const outer = (await viewport.boundingBox())!;
    expect(Math.abs(settled.x - outer.x)).toBeLessThan(2);
    expect(Math.abs(settled.width - outer.width)).toBeLessThan(2);
  }).toPass({ timeout: 5000 });
});

for (const width of [375, 393, 430]) {
  test(`Finance keeps readable Market typography and stocks at iPhone width ${width}`, async ({ page }) => {
    await page.route("https://images.example.test/**", route => route.fulfill({ contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII=", "base64") }));
    await mount(page, width);
    const news = page.getByTestId("market-news-iphone-fixture");
    const photos = news.locator("img");
    await expect(photos).toHaveCount(4);
    await photos.first().scrollIntoViewIfNeeded();
    await expect.poll(() => photos.first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await photos.nth(1).getAttribute("src")).toContain("small.png");
    expect((await photos.first().boundingBox())!.height).toBeLessThanOrEqual(180);
    expect((await photos.nth(1).boundingBox())!.width).toBeLessThanOrEqual(64);
    expect(await news.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const headline = news.getByRole("button").first().locator("span > span").first();
    const type = await headline.evaluate(element => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, weight: style.fontWeight, size: parseFloat(style.fontSize), clamp: style.webkitLineClamp, overflow: style.overflow };
    });
    expect(type.family).toMatch(/Plus Jakarta Sans/);
    expect(Number(type.weight)).toBeGreaterThanOrEqual(600);
    expect(type.size).toBe(14);
    expect(type.clamp).toBe("none");
    expect(type.overflow).not.toBe("hidden");
    const stocks = page.getByTestId("market-iphone-fixture");
    const row = stocks.getByTestId("market-pick-row").first();
    const cap = row.getByText("$850B cap", { exact: true });
    await expect(cap).toBeVisible();
    const geometry = await cap.evaluate((element) => {
      const row = element.closest("button")!.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { left: rect.left - row.left, right: row.right - rect.right, height: row.height };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeGreaterThanOrEqual(0);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    const search = stocks.getByRole("searchbox", { name: "Search stocks" });
    await expect(search).toBeVisible();
    expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const sectors = page.getByTestId("sector-iphone-fixture");
    await expect(sectors.locator("ul li")).toHaveCount(6);
    expect((await sectors.boundingBox())!.height).toBeLessThan(400);
    expect(await sectors.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await sectors.getByRole("button", { name: "All 11 sectors" }).click();
    await expect(sectors.locator("ul li")).toHaveCount(11);
    await sectors.getByRole("button", { name: "Show highlights" }).click();
    await expect(sectors.locator("ul li")).toHaveCount(6);
    for (const label of ["S&P 500", "NASDAQ Composite", "Dow Jones", "Russell 2000"]) {
      await page.getByRole("button", { name: `Open ${label} detail`, exact: true }).click();
      const detail = page.getByRole("dialog", { name: label, exact: true });
      await expect(detail).toBeVisible();
      const title = detail.getByRole("heading", { name: label, exact: true });
      const headingStyle = await title.evaluate(element => {
        const style = getComputedStyle(element);
        return { font: style.fontFamily, size: parseFloat(style.fontSize), clamp: style.webkitLineClamp, overflow: style.overflow };
      });
      expect(headingStyle.font).toMatch(/Plus Jakarta Sans/);
      expect(headingStyle.size).toBeGreaterThanOrEqual(20);
      expect(headingStyle.clamp).toBe("none");
      expect(headingStyle.overflow).not.toBe("hidden");
      expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expectMarketIndexChart(detail);
      await expect(detail.getByText("Yahoo Chart (Batch)", { exact: true })).toBeVisible();
      await expect(detail.getByText("Oct 21, 2:15 AM", { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await expect(detail).toHaveCount(0);
    }
  });
}

test("statement status keeps Cancel reachable while reading", async ({ page }) => {
  await mount(page);
  const importStatus = page.getByTestId("finance-import-status");
  await expect(importStatus.getByText("Finding holdings")).toBeVisible();
  await importStatus.getByRole("button", { name: "Finish reading statement" }).click();
  await expect(importStatus.getByText("Checking holdings")).toBeVisible();
  await importStatus.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("action-result")).toHaveText("Cancelled");
});

for (const width of [320, 393, 768]) {
  test(`consensus summary fits at ${width}px`, async ({ page }) => {
    await mount(page, width);
    await page.getByRole("button", { name: "Debate evidence & sources" }).click();
    const summary = page.locator("[data-consensus-summary]");
    await expect(summary).toBeVisible();
    const geometry = await summary.evaluate(el => {
      const header = el.children[0];
      const badge = header.children[1];
      const label = badge.children[1] as HTMLElement;
      const range = document.createRange(); range.selectNodeContents(label);
      return {
        lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
        overflow: el.scrollWidth > el.clientWidth,
        gap: el.children[1].getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        right: badge.getBoundingClientRect().right,
        edge: el.getBoundingClientRect().right,
      };
    });
    expect(geometry.lines).toBe(1);
    expect(geometry.overflow).toBe(false);
    expect(geometry.gap).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeLessThanOrEqual(geometry.edge + 1);
  });
}

test("holding actions dismiss on ancestor scroll without jumping back and still select the right row", async ({ page }) => {
  await mount(page);
  const container = page.getByTestId("review-scroll");
  const trigger = page.getByRole("button", { name: "Holding actions for TEST" });
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await container.evaluate(el => { el.scrollTop = 150; });
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await container.evaluate(el => el.scrollTop)).toBe(150);
  await container.evaluate(el => { el.scrollTop = 0; });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByTestId("action-result")).toHaveText("Edit TEST");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByTestId("action-result")).toHaveText("Delete TEST");
});

for (const width of [320, 393, 768]) {
  test(`review footer clears the last card and Talk to One at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 650 });
    for (const dockHeight of [86, 152]) {
      for (const shellClass of importShellClasses) {
        await page.setContent(`<style>${css}</style><style>
          html,body{height:100%;margin:0}
          #scroll{height:100%;overflow:auto;--app-scroll-bottom-pad:${dockHeight}px;--bottom-chrome-stack-height:${dockHeight}px}
          #holdings{height:1200px} #details{height:76px}
          #save{height:44px} #dock{position:fixed;bottom:0;height:${dockHeight}px;width:100%}
        </style><div id="scroll"><div data-app-shell-content class="h-full min-h-0 flex flex-col">
          <div class="fullscreen-flow-shell flex w-full flex-col ${shellClass}"><div class="flex w-full flex-col"><div class="pb-4">
          <div id="holdings">Holdings</div><div id="details">Asset allocation</div>
          <footer class="${saveActionClass}"><button id="save" onclick="this.textContent='Saved'">Save to Vault</button></footer>
        </div></div></div></div></div><button id="dock" onclick="this.textContent='Listening'">Talk to One</button>`);
        const scroll = page.locator("#scroll");
        const save = page.locator("#save");
        const details = page.locator("#details");
        const dock = page.locator("#dock");
        for (const scrollTop of [0, 650, 10_000]) {
          await scroll.evaluate((el, top) => { el.scrollTop = top; }, scrollTop);
          const lastCard = (await details.boundingBox())!;
          expect((await save.boundingBox())!.y).toBeGreaterThanOrEqual(lastCard.y + lastCard.height + 8);
        }
        const saveBounds = (await save.boundingBox())!;
        expect(saveBounds.y).toBeGreaterThanOrEqual(0);
        expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual((await dock.boundingBox())!.y - 12);
        await save.click();
        await expect(save).toHaveText("Saved");
        await dock.click();
        await expect(dock).toHaveText("Listening");
      }
    }
  });
}


registerFinanceChartChecks(mount);


registerFinanceSharingChecks(mount);

registerHoldingEntryChecks(mount);
registerStockQuoteRecoveryChecks(mount);

registerFinanceScreenChecks(mount);

registerFinanceOnboardingChecks((page, width) => mount(page, width, true));

registerAdvisorReviewChecks((page, width) => mount(page, width, false, true));
