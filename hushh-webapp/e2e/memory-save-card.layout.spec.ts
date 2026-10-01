import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The explicit memory-save receipt card at the pixel grid (founder bar,
 * 2026-09-29): 16 px symmetric insets, spacing on the 4 and 8 pt tokens, four
 * equal count tiles with tabular numerals, and category counts in fixed-width
 * columns whose digits line up row to row. Light and dark, phone and desktop.
 * Set MEMORY_SAVE_CARD_SHOT_DIR to capture one screenshot per theme and width.
 */
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-save-card-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      },
    }],
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/memory-save-card.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function open(page: Page, theme: "light" | "dark", state = "full") {
  // Settled frames only: the disclosure caret turns on open.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("http://localhost/memory-save-card**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`http://localhost/memory-save-card?state=${state}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("memory-save-card")).toBeVisible();
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("element has no box");
  return bounds;
}

const onGrid = (value: number, unit: number) => Math.abs(value / unit - Math.round(value / unit)) < 0.02;

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`memory save card sits on the 4/8 grid at ${width}px, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, theme);
      const card = page.getByTestId("memory-save-card");
      await expect(card.getByRole("status")).toHaveText("Partly saved to Memory");

      // Symmetric 16 px insets on all four sides.
      const padding = await card.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
      });
      expect(padding).toEqual([16, 16, 16, 16]);
      const cardBox = await box(card);
      const borderWidth = await card.evaluate((element) => parseFloat(getComputedStyle(element).borderLeftWidth));
      const counts = page.getByTestId("memory-save-counts");
      const countsBox = await box(counts);
      const leftInset = countsBox.x - (cardBox.x + borderWidth);
      const rightInset = cardBox.x + cardBox.width - borderWidth - (countsBox.x + countsBox.width);
      expect(Math.abs(leftInset - rightInset)).toBeLessThan(0.5);
      expect(leftInset).toBeCloseTo(16, 0);

      // Vertical rhythm: every gap between sections is 12 px (the 4 pt scale).
      const sections = card.locator(":scope > *");
      const sectionBoxes = [];
      for (let index = 0; index < (await sections.count()); index += 1) sectionBoxes.push(await box(sections.nth(index)));
      for (let index = 1; index < sectionBoxes.length; index += 1) {
        const gap = sectionBoxes[index]!.y - (sectionBoxes[index - 1]!.y + sectionBoxes[index - 1]!.height);
        expect(gap, `gap before section ${index}`).toBeCloseTo(12, 0);
      }

      // Four equal tiles, 8 px apart, 64 px tall, numerals tabular and centred.
      const tiles = page.getByTestId("memory-save-count");
      await expect(tiles).toHaveCount(4);
      const tileBoxes = await Promise.all([0, 1, 2, 3].map((index) => box(tiles.nth(index))));
      for (const tile of tileBoxes) {
        expect(Math.abs(tile.width - tileBoxes[0]!.width)).toBeLessThan(0.5);
        expect(tile.height).toBeCloseTo(64, 0);
        expect(onGrid(tile.height, 8)).toBe(true);
      }
      for (let index = 1; index < 4; index += 1) {
        const gap = tileBoxes[index]!.x - (tileBoxes[index - 1]!.x + tileBoxes[index - 1]!.width);
        expect(gap).toBeCloseTo(8, 0);
      }
      for (const numeric of await tiles.locator("dd").all()) {
        expect(await numeric.evaluate((element) => getComputedStyle(element).fontVariantNumeric)).toContain("tabular-nums");
      }

      // Category counts: fixed 56 px columns whose right edges align row to row.
      await card.getByText("Show what changed").click();
      const rows = page.getByTestId("memory-save-domain-row");
      await expect(rows).toHaveCount(5);
      const columns: number[][] = [[], [], []];
      for (const row of await rows.all()) {
        const cells = row.getByTestId("memory-save-domain-count");
        for (let column = 0; column < 3; column += 1) {
          const cell = cells.nth(column);
          const cellBox = await box(cell);
          expect(cellBox.width).toBeCloseTo(56, 0);
          expect(cellBox.height).toBeCloseTo(32, 0);
          expect(await cell.evaluate((element) => getComputedStyle(element).fontVariantNumeric)).toContain("tabular-nums");
          columns[column]!.push(cellBox.x + cellBox.width);
        }
      }
      for (const edges of columns) expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(0.5);

      // Controls meet the 44 px target and nothing scrolls sideways.
      for (const control of [card.getByRole("button", { name: "Save these 2 too" }), card.getByRole("link", { name: "View Memory" }),
        card.getByText("Show what changed")]) {
        expect((await box(control)).height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      // Brand and punctuation: never a sparkle glyph or an em dash on the card.
      const text = (await card.textContent()) ?? "";
      expect(text).not.toMatch(/[—–]/);
      expect(await card.locator("[data-icon*='sparkle' i], [class*='sparkle' i]").count()).toBe(0);
      expect(errors).toEqual([]);

      const metrics = { width, theme, padding, leftInset, rightInset, tileWidth: tileBoxes[0]!.width,
        tileHeight: tileBoxes[0]!.height, sectionGaps: sectionBoxes.slice(1).map((section, index) =>
          Math.round((section.y - (sectionBoxes[index]!.y + sectionBoxes[index]!.height)) * 100) / 100),
        columnEdgeSpread: columns.map((edges) => Math.round((Math.max(...edges) - Math.min(...edges)) * 100) / 100) };
      testInfo.annotations.push({ type: "geometry", description: JSON.stringify(metrics) });
      const shotDir = process.env.MEMORY_SAVE_CARD_SHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, `geometry-${width}-${theme}.json`), JSON.stringify(metrics, null, 2));
        await page.setViewportSize({ width, height: 1800 });
        await card.screenshot({ path: path.join(shotDir, `memory-save-card-${width}-${theme}.png`) });
      }
    });

test("a save that changed nothing says so and shows no zero-count noise", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, "light", "unchanged");
  const card = page.getByTestId("memory-save-card");
  await expect(card.getByRole("status")).toHaveText("Already in Memory");
  await expect(card).toContainText("51 details were already in Memory.");
  await expect(card.getByTestId("memory-save-needs-owner")).toHaveCount(0);
  await expect(card.getByTestId("memory-save-details")).toHaveCount(0);
});
