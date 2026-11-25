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
        ...["@/lib/advisor-review/service", "@/lib/advisor-review/snapshot", "@/lib/services/google-calendar-service", "@/lib/services/kai-profile-service", "@/lib/services/kai-profile-sync-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/advisor-review-boundaries.ts") })),
        ...["@/lib/finance-sharing/use-finance-share-context", "@/lib/finance-sharing/saved-source", "@/lib/services/finance-sharing-service", "@/lib/finance-sharing/portfolio-review-cache"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/finance-sharing-boundaries.ts") })),
        { find: /^@\/lib\/kai\/ticker-universe-cache$/, replacement: path.join(root, "e2e/fixtures/finance-market-boundaries.ts") },
        { find: /^@\/lib\/kai\/kai-market-home-resource$/, replacement: path.join(root, "e2e/fixtures/finance-market-boundaries.ts") },
        ...["@/hooks/use-auth", "@/lib/firebase/auth-context", "@/lib/vault/vault-context"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/finance-market-boundaries.ts") })),
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
        ...["@/lib/advisor-review/service", "@/lib/advisor-review/snapshot", "@/lib/services/google-calendar-service", "@/lib/services/kai-profile-service", "@/lib/services/kai-profile-sync-service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/advisor-review-boundaries.ts") })),
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

      const status = page.getByTestId("market-header-status");
      const refresh = page.getByRole("button", { name: "Refresh market home" });
      const heading = page.getByRole("heading", { name: "US markets", exact: true });
      await expect(status).toHaveText("Closed (exchange calendar)");
      const [indicator, label, refreshBox, headingBox] = await Promise.all([
        status.locator("[aria-hidden=true]").boundingBox(),
        status.getByText("Closed (exchange calendar)").boundingBox(),
        refresh.boundingBox(),
        heading.boundingBox(),
      ]);
      if (width < 640) {
        expect(label!.y).toBeGreaterThan(refreshBox!.y + refreshBox!.height);
        expect(indicator!.x + indicator!.width).toBeLessThan(label!.x);
        expect(headingBox!.y).toBeLessThan(refreshBox!.y + refreshBox!.height);
        expect(refreshBox!.x + refreshBox!.width).toBeLessThanOrEqual(width);
      } else {
        expect(label!.y).toBeLessThan(refreshBox!.y + refreshBox!.height);
        expect(label!.x + label!.width).toBeLessThan(indicator!.x);
        expect(indicator!.x).toBeLessThan(refreshBox!.x);
      }

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
      expect(measurements.clamp).toBe("2");
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

test("Finance sector pagination uses compact controls and reaches both pages", async ({ page }) => {
  await mount(page);
  const allocation = page.getByRole("region", { name: "Sector Allocation", exact: true });
  await allocation.getByRole("button", { name: /Healthcare/ }).click();
  const prev = allocation.getByRole("button", { name: "Prev", exact: true });
  const next = allocation.getByRole("button", { name: "Next", exact: true });
  await expect(prev).toBeDisabled();
  expect((await next.boundingBox())!.height).toBeLessThanOrEqual(36);
  await next.click();
  await expect(allocation.getByText("Showing 5–6 of 6")).toBeVisible();
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(allocation.getByText("Showing 1–4 of 6")).toBeVisible();
});

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
      return {
        family: style.fontFamily, weight: style.fontWeight, size: parseFloat(style.fontSize),
        clamp: style.webkitLineClamp, height: element.clientHeight, lineHeight: parseFloat(style.lineHeight),
        clipped: element.scrollHeight > element.clientHeight,
      };
    });
    expect(type.family).toMatch(/Plus Jakarta Sans/);
    expect(Number(type.weight)).toBeGreaterThanOrEqual(600);
    expect(type.size).toBe(14);
    expect(type.clamp).toBe("2");
    expect(type.height).toBe(2 * type.lineHeight);
    expect(type.clipped).toBe(true);
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

test("desktop Market news keeps thumbnails aligned through image failures", async ({ page }) => {
  await page.route("https://images.example.test/**", route => {
    if (route.request().url().includes("/story-")) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII=", "base64") });
  });
  await mount(page, 1024);
  const news = page.getByTestId("market-news-iphone-fixture");
  const headline = news.getByText(/^Foreign investors bought shares/);
  const height = await headline.evaluate(element => ({
    visible: element.clientHeight, full: element.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(height.visible).toBe(2 * height.lineHeight);
  expect(height.full).toBeGreaterThan(height.visible);
  const covers = news.locator("article button > div:first-of-type");
  await expect(covers).toHaveCount(4);
  for (const [index, imagePath] of ["small.png", "large.png", "publisher.png"].entries()) {
    const image = covers.nth(index).locator("img");
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveAttribute("src", `https://images.example.test/${imagePath}`);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(covers.nth(3).getByText("P", { exact: true })).toBeVisible();
  const boxes = await Promise.all([0, 1, 2, 3].map(index => covers.nth(index).boundingBox()));
  expect(boxes[0]!.y).toBeCloseTo(boxes[1]!.y, 0);
  expect(boxes[2]!.y).toBeCloseTo(boxes[3]!.y, 0);
  expect(boxes[0]!.x).toBeCloseTo(boxes[2]!.x, 0);
  expect(boxes[1]!.x).toBeCloseTo(boxes[3]!.x, 0);
});

test("statement status keeps Cancel reachable while reading", async ({ page }) => {
  await mount(page);
  const importStatus = page.getByTestId("finance-import-status");
  await expect(importStatus.getByText("Finding holdings")).toBeVisible();
  await importStatus.getByRole("button", { name: "Finish reading statement" }).click();
  await expect(importStatus.getByText("Checking holdings")).toBeVisible();
  await importStatus.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("action-result")).toHaveText("Cancelled");
});

test("desktop Portfolio aligns the balance beside the review and compact sharing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, 1024);
  const fixture = page.getByTestId("portfolio-overview-fixture");
  const overview = fixture.getByTestId("portfolio-overview");
  await expect(overview.getByRole("button", { name: "View performance" }).getByText("$24,680.42", { exact: true })).toHaveCSS("font-size", "36px");
  const cards = overview.getByTestId("portfolio-explore");
  const mix = cards.getByRole("button", { name: "View allocation" });
  const holdings = cards.getByRole("button", { name: "View holdings" });
  const review = overview.getByTestId("portfolio-briefing");
  await expect(cards.getByRole("button")).toHaveCount(2);
  await expect(mix.getByText("8.1%")).toBeVisible();
  await expect(holdings.getByText("TEST", { exact: true })).toBeVisible();
  await expect(review.getByText(/One company accounts for most of your balance/)).toBeVisible();
  const sharing = overview.getByTestId("portfolio-sharing-card");
  await expect(review.getByText("Growth-oriented", { exact: true })).toBeVisible();
  const [hero, insight, shareBox, mixBox, holdingsBox] = await Promise.all([
    overview.getByTestId("portfolio-value-card").boundingBox(), review.boundingBox(), sharing.boundingBox(),
    mix.locator("..").boundingBox(), holdings.locator("..").boundingBox(),
  ]);
  const available = (await overview.boundingBox())!;
  expect(hero!.x).toBeCloseTo(available.x);
  expect(insight!.x + insight!.width).toBeCloseTo(available.x + available.width);
  expect(hero!.y).toBeCloseTo(insight!.y);
  expect(hero!.x + hero!.width).toBeLessThan(insight!.x);
  await expect(sharing.getByRole("heading", { name: "Sharing", exact: true })).toHaveCount(0);
  expect(shareBox!.x).toBeCloseTo(insight!.x);
  expect(shareBox!.width).toBeCloseTo(insight!.width);
  expect(shareBox!.y).toBeGreaterThanOrEqual(insight!.y + insight!.height);
  expect(hero!.y + hero!.height).toBeCloseTo(shareBox!.y + shareBox!.height);
  expect(mixBox!.y).toBeGreaterThanOrEqual(hero!.y + hero!.height);
  expect(mixBox!.y).toBeCloseTo(holdingsBox!.y);
  expect(mixBox!.x).toBeCloseTo(hero!.x);
  expect(mixBox!.width).toBeCloseTo(hero!.width);
  expect(holdingsBox!.x).toBeCloseTo(insight!.x);
  expect(holdingsBox!.width).toBeCloseTo(insight!.width);
  const actions = await overview.getByRole("group", { name: "Portfolio actions" }).boundingBox();
  expect(actions!.x + actions!.width).toBeCloseTo(holdingsBox!.x + holdingsBox!.width);
  await page.locator("#root > main").evaluate(element => { element.style.maxWidth = "57rem"; });
  await overview.screenshot({ path: test.info().outputPath("portfolio-overview-desktop.png") });
});

test("desktop Portfolio opens the downside fallback and rotates reported insights", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => { document.body.dataset.portfolioReviewFallback = "true"; });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await mount(page, 1024);
  const overview = page.getByTestId("portfolio-overview");
  const review = overview.getByTestId("portfolio-briefing");
  await expect(review.getByRole("heading", { name: "Largest stock down 20%" })).toBeVisible();
  await expect(review.getByText("−18.4%", { exact: true })).toBeVisible();
  const assumption = review.getByText("estimate if other holdings stay flat", { exact: true });
  await review.scrollIntoViewIfNeeded();
  await expect(assumption).toBeInViewport({ ratio: 1 });
  await expect(review.getByRole("button", { name: "Takeaway" })).toHaveCount(0);
  await page.locator("#root > main").evaluate(element => { element.style.maxWidth = "57rem"; });
  await overview.screenshot({ path: test.info().outputPath("portfolio-overview-desktop-fallback.png") });
  const summary = overview.getByRole("region", { name: "Portfolio summary" });
  const height = (await summary.boundingBox())!.height;
  await review.getByRole("button", { name: "Resume review rotation" }).focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(3100);
  await expect(review.getByRole("heading", { name: "Net deposits" })).toBeVisible();
  await expect(review.getByText("$500.00", { exact: true })).toBeVisible();
  expect((await summary.boundingBox())!.height).toBeCloseTo(height);
  await page.keyboard.press("Enter");
  await page.clock.runFor(3100);
  await expect(review.getByRole("heading", { name: "Net deposits" })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const track = review.locator("[data-portfolio-review-track]");
  expect(await track.evaluate(el => getComputedStyle(el).transitionProperty)).toBe("transform");
  await review.getByRole("button", { name: "Downside", exact: true }).click();
  await expect(review.getByText("−18.4%", { exact: true })).toBeVisible();
  expect((await summary.boundingBox())!.height).toBeCloseTo(height);
});

test("mobile Portfolio rotates the review and opens the full allocation", async ({ page, browserName }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await mount(page, 393);
  const fixture = page.getByTestId("portfolio-overview-fixture");
  const overview = fixture.getByTestId("portfolio-overview");
  const explore = overview.getByTestId("portfolio-explore");
  await expect(overview.getByRole("button", { name: "View performance" }).getByText("$24,680.42", { exact: true })).toHaveCSS("font-size", "30px");
  const totals = overview.getByTestId("portfolio-value-card").getByRole("group", { name: "Portfolio balance summary" });
  await expect(totals.getByText("Invested", { exact: true })).toBeVisible();
  await expect(totals.getByText("Cash", { exact: true })).toBeVisible();
  await expect(overview.getByText("Statement through Oct 31, 2026", { exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "View analysis" })).toBeVisible();
  await expect(overview.getByText("Growth-oriented", { exact: true })).toBeVisible();
  const review = overview.getByTestId("portfolio-briefing");
  const reviewViews = review.getByRole("group", { name: "Portfolio review views" });
  const takeaway = reviewViews.getByRole("button", { name: "Takeaway", exact: true });
  await expect(takeaway).toHaveAttribute("aria-pressed", "true");
  await expect(review.getByText(/One company accounts for most of your balance/)).toHaveCSS("font-size", "14px");
  const reviewHeight = (await review.boundingBox())!.height;
  await reviewViews.getByRole("button", { name: "Resume review rotation" }).focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(3100);
  await expect(takeaway).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(3000);
  await expect(reviewViews.getByRole("button", { name: "Downside", exact: true })).toHaveAttribute("aria-pressed", "true");
  await review.scrollIntoViewIfNeeded();
  await expect(review.getByText("estimate if other holdings stay flat")).toBeInViewport({ ratio: 1 });
  expect((await review.boundingBox())!.height).toBeCloseTo(reviewHeight);
  if (browserName === "chromium") {
    const stage = review.locator("[data-portfolio-review-swipe]");
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (dx: number, dy: number) => {
      await stage.scrollIntoViewIfNeeded();
      const box = (await stage.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove", touchPoints: [{ x: x + dx * fraction, y: y + dy * fraction }],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    try {
      await swipe(0, -70);
      await expect(reviewViews.getByRole("button", { name: "Downside", exact: true })).toHaveAttribute("aria-pressed", "true");
      await swipe(85, 0);
      await expect(takeaway).toHaveAttribute("aria-pressed", "true");
      await expect(reviewViews.getByRole("button", { name: "Resume review rotation" })).toBeVisible();
      await page.clock.runFor(6200);
      await expect(takeaway).toHaveAttribute("aria-pressed", "true");
      await swipe(-85, 0);
      await expect(reviewViews.getByRole("button", { name: "Downside", exact: true })).toHaveAttribute("aria-pressed", "true");
    } finally {
      await cdp.detach();
    }
  }
  await reviewViews.getByRole("button", { name: "Deposits", exact: true }).click();
  await expect(review.getByRole("heading", { name: "Net deposits", exact: true })).toBeVisible();
  expect((await review.boundingBox())!.height).toBeCloseTo(reviewHeight);
  await takeaway.click();
  await expect(takeaway).toHaveAttribute("aria-pressed", "true");
  await expect(explore.getByRole("button")).toHaveCount(2);
  const sharing = overview.getByTestId("portfolio-sharing-card");
  await expect(sharing).toHaveCount(1);
  const [exploreBox, sharingBox] = await Promise.all([explore.boundingBox(), sharing.boundingBox()]);
  expect(sharingBox!.y).toBeGreaterThan(exploreBox!.y + exploreBox!.height);
  const actions = overview.getByRole("group", { name: "Portfolio actions" });
  const importButton = actions.getByRole("button", { name: "Import portfolio" });
  const manageButton = actions.getByRole("button", { name: "Manage portfolio" });
  const [actionBox, importBox, manageBox] = await Promise.all([actions.boundingBox(), importButton.boundingBox(), manageButton.boundingBox()]);
  expect(actionBox!.x).toBeCloseTo(sharingBox!.x);
  expect(actionBox!.width).toBeCloseTo(sharingBox!.width);
  expect(importBox!.width).toBeCloseTo(manageBox!.width);
  expect(importBox!.y).toBeCloseTo(manageBox!.y);
  await importButton.click();
  await expect(page.getByTestId("action-result")).toHaveText("Import portfolio");
  await manageButton.click();
  await expect(page.getByTestId("action-result")).toHaveText("Open sources");
  await expect(explore.getByText("1 saved holding")).toBeVisible();
  await expect(explore.getByText("TEST", { exact: true })).toBeHidden();
  await expect(overview.getByText("Portfolio score")).toHaveCount(0);
  await expect(fixture.getByRole("list", { name: "Asset breakdown" })).toHaveCount(0);
  await overview.screenshot({ path: test.info().outputPath("portfolio-overview-mobile.png") });
  await page.setViewportSize({ width: 320, height: 850 });
  expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await actions.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 393, height: 850 });
  await explore.getByRole("button", { name: "View allocation" }).click();
  const breakdown = fixture.getByRole("list", { name: "Asset breakdown" });
  await expect(breakdown.getByText("$22,680.42", { exact: true })).toBeVisible();
  await expect(breakdown.getByText("8.1% of portfolio", { exact: true })).toBeVisible();
  expect(await breakdown.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const equities = breakdown.getByRole("button", { name: /Equities/ });
  await equities.click();
  await expect(equities).toHaveAttribute("aria-pressed", "true");
  await equities.click();
  await expect(equities).toHaveAttribute("aria-pressed", "false");
  await fixture.getByRole("region", { name: "Asset mix" }).screenshot({ path: test.info().outputPath("portfolio-allocation-detail-mobile.png") });
});

test("mobile Portfolio keeps a single downside slide compact and fully visible", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.dataset.portfolioReviewFallback = "true";
      document.body.dataset.portfolioSingleReview = "true";
    });
  });
  await mount(page, 320);
  const review = page.getByTestId("portfolio-overview").getByTestId("portfolio-briefing");
  await review.scrollIntoViewIfNeeded();
  const headline = review.getByRole("heading", { name: "Largest stock down 20%" });
  const openReview = review.getByRole("button", { name: "View analysis" });
  await expect(headline).toBeVisible();
  const assumption = review.getByText("estimate if other holdings stay flat");
  await expect(assumption).toBeInViewport({ ratio: 1 });
  await expect(review.getByText("30% drop", { exact: true })).toBeInViewport({ ratio: 1 });
  const [copy, chartStart, chartEnd] = await Promise.all([
    assumption.boundingBox(),
    review.getByText("0% drop", { exact: true }).boundingBox(),
    review.getByText("30% drop", { exact: true }).boundingBox(),
  ]);
  expect(chartStart!.x).toBeGreaterThan(copy!.x + copy!.width);
  expect(chartEnd!.x).toBeGreaterThan(chartStart!.x + chartStart!.width);
  expect(chartStart!.y).toBeCloseTo(chartEnd!.y);
  await expect(review.getByRole("group", { name: "Portfolio review views" })).toHaveCount(0);
  expect((await openReview.boundingBox())!.x).toBeCloseTo((await headline.boundingBox())!.x);
  await expect(headline).toHaveCSS("font-size", "14px");
  expect(await headline.evaluate(element => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return text.getClientRects().length;
  })).toBe(1);
  await page.setViewportSize({ width: 393, height: 852 });
  expect((await review.boundingBox())!.height).toBeLessThan(210);
  const [slideBox, contentBox] = await Promise.all([
    review.locator("[data-portfolio-review-track]").boundingBox(),
    headline.locator("../..").boundingBox(),
  ]);
  const topSpace = contentBox!.y - slideBox!.y;
  const bottomSpace = slideBox!.y + slideBox!.height - contentBox!.y - contentBox!.height;
  expect(topSpace).toBeGreaterThan(5);
  expect(topSpace).toBeCloseTo(bottomSpace, 0);
  await review.screenshot({ path: test.info().outputPath("portfolio-single-review-mobile.png") });
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
