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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

for (const width of [320, 375, 393, 430, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`Market news matches Location text and fits at ${width}px in ${theme}`, async ({ page }) => {
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
      const action = page.getByRole("button", { name: "All news", exact: true });
      await expect(action).toBeVisible();
      const target = await action.boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(44);
      expect(target!.width).toBeGreaterThanOrEqual(44);
      const card = page.getByRole("button").filter({ hasText: "A longer market headline" });
      await expect(card).toBeVisible();
      const measurements = await card.evaluate(el => {
        const reference = document.querySelector("[data-location-type-reference]")!;
        const style = (root: Element, selector: string) => {
          const css = getComputedStyle(root.querySelector(selector)!);
          return [css.fontFamily, css.fontSize, css.lineHeight, css.color];
        };
        const content = el.lastElementChild!;
        return {
          headline: style(el, ".ui-text-medium-row-label"),
          row: style(reference, ".ui-text-row-label"),
          description: style(el, ".ui-text-row-description"),
          descriptionReference: style(reference, ".ui-text-row-description"),
          helper: style(el, ".ui-text-helper-text"),
          helperReference: style(reference, ".ui-text-helper-text"),
          action: style(el, ".ui-text-trailing-action"),
          actionReference: style(reference, ".ui-text-trailing-action"),
          padding: getComputedStyle(content).padding,
          cardOverflow: el.scrollWidth > el.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          railOverflow: el.parentElement!.scrollWidth > el.parentElement!.clientWidth,
        };
      });
      expect(measurements.headline).toEqual(measurements.row);
      expect(measurements.description).toEqual(measurements.descriptionReference);
      expect(measurements.helper).toEqual(measurements.helperReference);
      expect(measurements.action).toEqual(measurements.actionReference);
      expect(measurements.padding).toBe("16px");
      expect(measurements.cardOverflow).toBe(false);
      expect(measurements.pageOverflow).toBe(false);
      expect(measurements.railOverflow).toBe(true);
      await action.click();
      await expect(page.locator("body")).toHaveAttribute("data-navigation-href", "/one/kai/news");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`finance-${width}-${theme}.png`) });
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
