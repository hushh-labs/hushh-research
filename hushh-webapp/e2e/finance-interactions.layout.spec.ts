import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let marketScript: string;
let saveActionClass: string;
let stickyOffsets: string[];
let fixtureOutDir: string | undefined;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const providerSource = fs.readFileSync(path.join(root, "app/providers.tsx"), "utf8");
  const offsets = providerSource.match(/"--app-sticky-bottom-offset"\s*:\s*shouldLockFullscreenRoot\s*&&\s*!hideGlobalChrome\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/);
  if (!offsets) {
    throw new Error("Could not extract --app-sticky-bottom-offset branch values from app/providers.tsx");
  }
  stickyOffsets = [offsets[1], offsets[2]];
  const reviewSource = fs.readFileSync(path.join(root, "components/kai/views/portfolio-review-view.tsx"), "utf8");
  saveActionClass = reviewSource.match(/data-portfolio-review-save\s+className="([^"]+)"/)![1];
  for (const candidate of scanner.scanFiles([{ content: saveActionClass, extension: "html" }])) candidates.add(candidate);

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
        {
          find: /^next\/navigation$/,
          replacement: path.join(root, "e2e/fixtures/agent-markdown-boundaries.ts"),
        },
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
        ...[
          "next/navigation", "@/hooks/use-auth", "@/lib/firebase/auth-context",
          "@/lib/vault/vault-context", "@/lib/cache/use-stale-resource",
          "@/lib/kai/kai-financial-resource", "@/lib/kai/kai-market-home-resource",
          "@/lib/kai/kai-market-news-resource",
          "@/lib/services/api-service",
          "@/lib/services/kai-token-guard", "@/lib/kai/actions/voice-surface-metadata",
        ].map(find => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: boundary })),
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
  for (const theme of ["light", "dark"]) {
    test(`Market briefing stays readable and fits at ${width}px in ${theme}`, async ({ page }) => {
      page.on("pageerror", error => { throw error; });
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
      const financeTitle = page.getByRole("heading", { name: "Finance", exact: true });
      await expect(financeTitle).toHaveCount(1);
      expect(await financeTitle.evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight];
      })).toEqual(["17px", "22px", "600"]);
      const frame = page.locator(".app-page-shell").first();
      const frameStyle = await frame.evaluate(element => {
        const style = getComputedStyle(element);
        return { width: element.getBoundingClientRect().width, gutter: style.paddingLeft };
      });
      expect(frameStyle.width).toBeLessThanOrEqual(728);
      expect(frameStyle.gutter).toBe(width <= 350 ? "16px" : width <= 620 ? "20px" : "24px");
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
      expect(measurements.headline).toEqual(["14px", "21px", "550"]);
      expect(measurements.metadata).toEqual(["12px", "18px"]);
      expect(measurements.clamp).toBe("none");
      expect(measurements.cardOverflow).toBe(false);
      expect(measurements.pageOverflow).toBe(false);
      expect(measurements.railOverflow).toBe(false);
      const sectionTypography = await page.getByRole("heading", { name: "US markets", exact: true }).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.lineHeight, style.fontWeight];
      });
      expect(sectionTypography[0]).toMatch(/Plus Jakarta Sans/);
      expect(sectionTypography.slice(1)).toEqual(["14px", "22px", "600"]);
      const movers = page.getByRole("region", { name: "Market movers", exact: true });
      await movers.scrollIntoViewIfNeeded();
      const gainers = await movers.getByRole("heading", { name: "Gainers", exact: true }).boundingBox();
      const decliners = await movers.getByRole("heading", { name: "Decliners", exact: true }).boundingBox();
      expect(Math.abs(gainers!.y - decliners!.y)).toBeLessThanOrEqual(1);
      expect(gainers!.x + gainers!.width).toBeLessThanOrEqual(decliners!.x);
      expect(await movers.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      for (const mover of await movers.getByRole("button").all()) {
        await expect(mover).toBeVisible();
        expect(await mover.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const quote = mover.locator(":scope > span").first();
        const ticker = await quote.locator(":scope > span").first().boundingBox();
        const percentage = await quote.locator(":scope > span").last().boundingBox();
        expect(Math.abs(ticker!.y - percentage!.y)).toBeLessThanOrEqual(1);
        expect(ticker!.x + ticker!.width).toBeLessThanOrEqual(percentage!.x);
      }
      await action.click();
      await expect(page.locator("body")).toHaveAttribute("data-navigation-href", "/one/kai/news");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`finance-${width}-${theme}.png`) });

      await page.route("https://images.example.test/**", route => route.request().url().endsWith("broken.png")
        ? route.fulfill({ status: 404 })
        : route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII=", "base64") }));
      await page.route("http://localhost/finance-market-news-fixture", route => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html class="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{height:auto}</style></head><body><div id="root"></div></body></html>`,
      }));
      await page.goto("http://localhost/finance-market-news-fixture");
      await page.addScriptTag({ content: marketScript });
      await awaitProductFont(page);
      const allNews = page.getByRole("region", { name: "Headlines", exact: true });
      expect(await allNews.getByRole("heading", { name: "Headlines", exact: true }).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.lineHeight, style.fontWeight];
      })).toEqual(sectionTypography);
      const firstArticle = allNews.locator("article").first();
      await expect(firstArticle.getByText("NVDA · MSFT", { exact: true })).toBeVisible();
      await expect(firstArticle.getByText("Positive", { exact: true })).toBeVisible();
      await expect(allNews.getByText("Risk", { exact: true })).toBeVisible();
      const fullHeadline = firstArticle.getByText("A longer market headline stays readable on a narrow phone screen", { exact: true });
      const allNewsType = await fullHeadline.evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.lineHeight, style.fontWeight, style.webkitLineClamp];
      });
      expect(allNewsType[0]).toMatch(/Plus Jakarta Sans/);
      expect(allNewsType.slice(1)).toEqual(["14px", "21px", "550", "none"]);
      const summary = firstArticle.getByText("The full article summary remains readable without clipping, even when it takes several lines on a narrow phone screen.", { exact: true });
      const summaryBounds = await summary.boundingBox();
      const articleBounds = await firstArticle.getByRole("button").boundingBox();
      expect(Math.abs(summaryBounds!.width - articleBounds!.width)).toBeLessThanOrEqual(1);
      await expect.poll(() => allNews.locator("article").nth(1).locator("img").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.src.endsWith("large.png"))).toBe(true);
      expect(await allNews.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const refresh = page.getByRole("button", { name: "Refresh market news", exact: true });
      const refreshBounds = await refresh.boundingBox();
      expect(refreshBounds!.width).toBeGreaterThanOrEqual(44);
      expect(refreshBounds!.height).toBeGreaterThanOrEqual(44);
      await refresh.click();
      await expect(page.locator("body")).toHaveAttribute("data-news-refreshed", "true");
      await allNews.getByRole("button", { name: "Load more", exact: true }).click();
      await expect(allNews.locator("article")).toHaveCount(3);
      await expect(allNews.getByText("More headlines from the same snapshot", { exact: true })).toBeVisible();
      await expect(allNews.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`finance-all-news-${width}-${theme}.png`) });
    });
  }
}

test.afterAll(() => {
  if (fixtureOutDir) fs.rmSync(fixtureOutDir, { recursive: true, force: true });
});


async function mount(page: Page, width = 393) {
  await page.setViewportSize({ width, height: 852 });
  await page.route("http://localhost/finance-fixture", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{height:auto}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/finance-fixture");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
}

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
    expect(type.weight).toBe("550");
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
    await row.click();
    const stockDetail = page.getByRole("dialog", { name: "Berkshire Hathaway Inc. Class B", exact: true });
    await expect(stockDetail).toBeVisible();
    const capLabel = stockDetail.getByText("Market cap", { exact: true });
    expect(await capLabel.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontFamily, style.fontSize, style.lineHeight];
    })).toEqual([expect.stringMatching(/Plus Jakarta Sans/), "14px", "21px"]);
    await expect(stockDetail.getByText("$850B", { exact: true })).toBeVisible();
    expect(await stockDetail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await stockDetail.getByRole("button", { name: "Close", exact: true }).click();
    const search = stocks.getByRole("button", { name: "Search list" });
    await expect(search).toBeVisible();
    const bounds = await search.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await search.click();
    await expect(stocks.getByPlaceholder("Search symbol, company, sector, or thesis")).toBeVisible();
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
      const line = detail.locator("path.recharts-line-curve");
      await expect(line).toHaveAttribute("d", /^M/);
      const chart = await line.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
        stroke: getComputedStyle(element).stroke, color: getComputedStyle(element).color }));
      expect(chart.width).toBeGreaterThan(100);
      expect(chart.height).toBeGreaterThan(10);
      expect(chart.stroke).not.toBe("none");
      expect(chart.color).not.toBe("rgba(0, 0, 0, 0)");
      // Measure both positions in one frame while the sheet is entering.
      expect(await detail.evaluate(element => {
        const value = [...element.querySelectorAll("p")].find(row => row.textContent === "7,712.57")!;
        return value.getBoundingClientRect().top < element.querySelector("path.recharts-line-curve")!.getBoundingClientRect().top;
      })).toBe(true);
      await expect(detail.getByText("Yahoo Chart (Batch)", { exact: true })).toBeVisible();
      await expect(detail.getByText("Oct 21, 2:15 AM", { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await expect(detail).toHaveCount(0);
    }
  });
}

test("import progress and stream updates retain their layout", async ({ page }) => {
  await mount(page);
  const bar = page.getByRole("progressbar", { name: "Import progress" });
  const footer = page.getByTestId("after-import");
  const initialBar = await bar.boundingBox();
  const initialFooter = await footer.boundingBox();
  await page.getByRole("button", { name: "Update progress" }).click();
  await expect(bar).toHaveAttribute("aria-valuenow", "77");
  expect((await bar.boundingBox())?.y).toBe(initialBar?.y);
  expect((await footer.boundingBox())?.y).toBe(initialFooter?.y);
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
  test(`review save action clears the dock throughout scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    for (const dockHeight of [86, 152]) {
      for (const [host, offset] of stickyOffsets.entries()) {
        const rootPad = host === 0 ? 0 : dockHeight;
        await page.setContent(`<style>${css}</style><style>
          html,body{height:100%;margin:0} #scroll{height:100%;overflow:auto;padding-bottom:${rootPad}px;--app-scroll-bottom-pad:${dockHeight}px;--bottom-chrome-stack-height:${dockHeight}px;--app-sticky-bottom-offset:${offset}}
          #review{position:relative;width:100%} #flow{padding-bottom:${host === 0 ? dockHeight : 0}px} #holdings{height:1600px;overflow:hidden} #save{height:52px;width:100%}
          #dock{position:fixed;bottom:0;height:${dockHeight}px;width:100%}
        </style><div id="scroll"><div id="flow"><div id="review"><div id="holdings">Holdings</div>
        <div class="${saveActionClass}"><button id="save">Save to Vault</button></div></div></div></div><div id="dock">Talk to One</div>`);
        for (const scrollTop of [0, 400, 10000, 650, 500]) {
          await page.locator("#scroll").evaluate((el, top) => { el.scrollTop = top; }, scrollTop);
          const save = await page.locator("#save").boundingBox();
          const dock = await page.locator("#dock").boundingBox();
          expect(save!.y).toBeGreaterThanOrEqual(0);
          expect(save!.y + save!.height).toBeLessThanOrEqual(dock!.y - 11);
          expect(dock!.y - (save!.y + save!.height)).toBeLessThanOrEqual(25);
        }
      }
    }
  });
}
