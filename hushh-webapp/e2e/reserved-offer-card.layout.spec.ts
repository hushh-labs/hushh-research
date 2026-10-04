import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * Reserved-branch surfaces at the pixel grid (founder bar): the save card's
 * offers to finish a fact on its app's screen ("Add as Home in Location") and
 * a Memory item an app owns, read-only with "Open in Location".
 *
 * Contract: 4 and 8 pt spacing, rows of equal height on the 8 pt grid and at
 * least 44 px, the icon well on the 4 pt grid and centred with equal space
 * above and below, the bare duotone registry glyph centred in it, text and
 * chevrons aligned row to row, flat Morphy surfaces (no blur, no shadow), and
 * the Material press ripple clipped to the row. Light and dark, phone and
 * desktop, then again with the text widened (CI's Linux faces set wider).
 * Set RESERVED_OFFER_SHOT_DIR to capture one screenshot per state and theme.
 */
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-offer-card-"));
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
      lib: { entry: path.join(root, "e2e/fixtures/reserved-offer-card.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

// next-themes (attribute="class") puts `light` or `dark` on <html>, and the
// flat Morphy card tokens at phone width are scoped to exactly those classes.
async function open(page: Page, theme: "light" | "dark", state: "offers" | "memory" | "memory-kyc") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("http://localhost/reserved-offer-card**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`http://localhost/reserved-offer-card?state=${state}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("element has no box");
  return bounds;
}

const onGrid = (value: number, unit: number) => Math.abs(value / unit - Math.round(value / unit)) < 0.02;
const close = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

type RowReading = {
  height: number;
  /** Lines of title text: a long label wraps instead of hiding its app. */
  lines: number;
  /** The glyph's centre against its well's, both axes. */
  glyphCenterOffset: number;
  glyphSize: number;
  /** The icon well is the layout box on the grid; the glyph is centred in it. */
  glyphLeft: number;
  wellTop: number;
  wellBottom: number;
  wellSize: number;
  textLeft: number;
  textRight: number;
  chevronLeft: number;
  chevronRight: number;
  backdrop: string;
};

async function readRow(row: Locator): Promise<RowReading> {
  return row.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const well = element.querySelector<HTMLElement>("[data-slot='settings-row-icon']")!.getBoundingClientRect();
    const glyph = element.querySelector<HTMLElement>("[data-slot='settings-row-icon'] svg")!.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>("[data-slot='settings-row-title']")!.getBoundingClientRect();
    const trailing = element.querySelector<HTMLElement>("[data-slot='settings-row-trailing'] svg")!.getBoundingClientRect();
    const titleNode = element.querySelector<HTMLElement>("[data-slot='settings-row-title']")!;
    const lineHeight = parseFloat(getComputedStyle(titleNode).lineHeight);
    return {
      height: r.height,
      lines: Math.round(titleNode.getBoundingClientRect().height / lineHeight),
      glyphCenterOffset: Math.max(
        Math.abs(glyph.top + glyph.height / 2 - (well.top + well.height / 2)),
        Math.abs(glyph.left + glyph.width / 2 - (well.left + well.width / 2)),
      ),
      glyphSize: glyph.width,
      glyphLeft: well.left - r.left,
      wellTop: well.top - r.top,
      wellBottom: r.bottom - well.bottom,
      wellSize: well.height,
      textLeft: title.left - r.left,
      textRight: title.right,
      chevronLeft: trailing.left,
      chevronRight: r.right - trailing.right,
      backdrop: getComputedStyle(element).backdropFilter || "none",
    };
  });
}

function assertRows(readings: RowReading[], label: string) {
  for (const reading of readings) {
    expect(reading.height, `${label}: 44 px target`).toBeGreaterThanOrEqual(44);
    expect(onGrid(reading.height, reading.lines === 1 ? 8 : 4), `${label}: row height ${reading.height} on the grid`).toBe(true);
    const sameLines = readings.find((other) => other.lines === reading.lines)!;
    expect(close(reading.height, sameLines.height), `${label}: equal rows for equal text`).toBe(true);
    expect(reading.glyphCenterOffset, `${label}: glyph centred in its well`).toBeLessThanOrEqual(0.5);
    expect(onGrid(reading.glyphLeft, 4), `${label}: well inset ${reading.glyphLeft} on the 4 pt grid`).toBe(true);
    // The well is centred in the row: equal space above and below it.
    expect(close(reading.wellTop, reading.wellBottom), `${label}: symmetric vertical insets`).toBe(true);
    expect(onGrid(reading.wellSize, 4), `${label}: well ${reading.wellSize} on the 4 pt grid`).toBe(true);
    expect(close(reading.glyphLeft, readings[0]!.glyphLeft), `${label}: glyph column`).toBe(true);
    expect(close(reading.textLeft, readings[0]!.textLeft), `${label}: text column`).toBe(true);
    expect(close(reading.chevronRight, readings[0]!.chevronRight), `${label}: chevron column`).toBe(true);
    expect(reading.textRight, `${label}: title clear of the chevron`).toBeLessThanOrEqual(reading.chevronLeft + 0.5);
    expect(reading.backdrop, `${label}: flat surface, no blur`).toBe("none");
  }
}

/** Flat: every shadow layer, if any, has no offset, blur or spread. */
async function isFlat(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const shadow = getComputedStyle(element).boxShadow;
    if (!shadow || shadow === "none") return true;
    return shadow
      .split(/,(?![^(]*\))/)
      .every((layer) => [...layer.matchAll(/(-?\d*\.?\d+)px/g)].every((match) => Number(match[1]) === 0));
  });
}

const WIDEN = "[data-slot='settings-row-title'],[data-testid='memory-detail-reserved-note'],[data-testid='memory-save-offers'] p{letter-spacing:0.3px}";

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`offer rows sit on the 4/8 grid at ${width}px, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, theme, "offers");
      const card = page.getByTestId("memory-save-card");
      const section = page.getByTestId("memory-save-offers");
      await expect(section).toBeVisible();
      const rows = section.getByTestId("reserved-offer-row");
      // A receipt shows at most three offers (MAX_RECEIPT_OFFERS).
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveText("Add as Home in Location");
      // An identity fact opens Mail's KYC tab, with the KYC registry glyph.
      await expect(rows.nth(2)).toHaveText("Review legal name in Mail");
      // The whole label shows, so the app it opens is never cut off.
      for (const row of await rows.all()) {
        expect(await row.locator("[data-slot='settings-row-title']").evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 0.5 && getComputedStyle(element).textOverflow !== "ellipsis",
        )).toBe(true);
      }

      // The group spans the card's 16 px content box, symmetric left and right.
      const cardBox = await box(card);
      const border = await card.evaluate((element) => parseFloat(getComputedStyle(element).borderLeftWidth));
      const group = section.locator("[data-slot='settings-group-shell']");
      const groupBox = await box(group);
      const leftInset = groupBox.x - (cardBox.x + border);
      const rightInset = cardBox.x + cardBox.width - border - (groupBox.x + groupBox.width);
      expect(close(leftInset, rightInset)).toBe(true);
      expect(leftInset).toBeCloseTo(16, 0);
      expect(await isFlat(group), "flat Morphy surface, no shadow").toBe(true);
      expect(await group.evaluate((element) => getComputedStyle(element).backdropFilter || "none")).toBe("none");

      // Caption, then 8 px, then the rows; 12 px from the section before.
      const caption = section.locator(":scope > p");
      const captionBox = await box(caption);
      const gap = groupBox.y - (captionBox.y + captionBox.height);
      expect(gap).toBeCloseTo(8, 0);

      const readings = await Promise.all([0, 1, 2].map((index) => readRow(rows.nth(index))));
      assertRows(readings, `${width} ${theme}`);
      expect(readings[0]!.glyphSize).toBeCloseTo(22, 0);
      // The shared compact row: 56 px, a 28 px well, 16 px in from the edge.
      expect(readings[0]!.lines).toBe(1);
      expect(readings[0]!.height).toBeCloseTo(56, 0);
      expect(readings[0]!.glyphLeft).toBeCloseTo(16, 0);

      // Ripple on: a press grows the Material ripple inside the row, clipped to it.
      const first = rows.nth(0);
      const firstBox = await box(first);
      await page.mouse.move(firstBox.x + 40, firstBox.y + firstBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(80);
      const ripple = await first.evaluate((element) => {
        const host = element.querySelector<HTMLElement>(".morphy-ripple-host");
        const pressed = Boolean(host?.querySelector("md-ripple")?.shadowRoot?.querySelector(".surface.pressed"))
          || Boolean(host?.querySelector("[data-ripple-flat][data-pressed]"));
        const a = element.getBoundingClientRect();
        const b = host?.getBoundingClientRect();
        return {
          pressed,
          clipped: Boolean(b && Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1 &&
            Math.abs(a.top - b.top) < 1 && Math.abs(a.bottom - b.bottom) < 1),
          scaled: getComputedStyle(element).scale !== "none" && getComputedStyle(element).scale !== "1",
        };
      });
      await page.mouse.up();
      expect(ripple.pressed, "ripple on pointerdown").toBe(true);
      expect(ripple.clipped, "ripple clipped to the row").toBe(true);
      expect(ripple.scaled, "no bounce or press scale").toBe(false);

      // Widened text: rows hold their grid and every title still clears its chevron.
      await page.addStyleTag({ content: WIDEN });
      assertRows(await Promise.all([0, 1, 2].map((index) => readRow(rows.nth(index)))), `${width} ${theme} widened`);

      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      const text = (await section.textContent()) ?? "";
      expect(text).not.toMatch(/[—–]/);
      expect(await section.locator("[data-icon*='sparkle' i], [class*='sparkle' i], [class*='glass' i]").count()).toBe(0);
      expect(errors).toEqual([]);

      const metrics = { width, theme, leftInset, rightInset, captionGap: gap, row: readings[0] };
      testInfo.annotations.push({ type: "geometry", description: JSON.stringify(metrics) });
      const shotDir = process.env.RESERVED_OFFER_SHOT_DIR;
      if (shotDir) {
        await page.reload();
        await open(page, theme, "offers");
        await page.mouse.move(0, 0);
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, `geometry-offers-${width}-${theme}.json`), JSON.stringify(metrics, null, 2));
        await page.setViewportSize({ width, height: 1400 });
        await page.getByTestId("memory-save-card").screenshot({ path: path.join(shotDir, `offer-card-${width}-${theme}.png`) });
      }
    });

for (const [state, appName] of [["memory", "Location"], ["memory-kyc", "Mail"]] as const)
for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`a reserved Memory item is read-only with Open in ${appName} at ${width}px, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, theme, state);
      const reserved = page.getByTestId("memory-detail-reserved");
      await expect(reserved).toBeVisible();
      await expect(page.getByText("Edit", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Forget Memory", { exact: true })).toHaveCount(0);
      const row = page.getByTestId("memory-detail-open-owner");
      await expect(row).toHaveText(`Open in ${appName}`);

      const reading = await readRow(row);
      assertRows([reading], `${width} ${theme}`);
      expect(reading.height).toBeCloseTo(56, 0);
      // A page-level card: the same --app-card-* surface as the Sharing card
      // beside it, never blurred. (The chat's offers sit inside the receipt
      // card, so they carry no shadow at all: no card in a card.)
      const shell = page.getByTestId("memory-detail-owner").locator("[data-slot='settings-group-shell']");
      const sibling = page.getByTestId("memory-detail-meta").locator("[data-slot='settings-group-shell']");
      const surface = (locator: Locator) => locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return { shadow: style.boxShadow, background: style.backgroundColor, blur: style.backdropFilter || "none" };
      });
      const [own, beside] = [await surface(shell), await surface(sibling)];
      expect(own).toEqual(beside);
      expect(own.blur).toBe("none");

      // The note sits 8 px under the group, its text on the glyph's column.
      const note = page.getByTestId("memory-detail-reserved-note");
      const groupBox = await box(page.getByTestId("memory-detail-owner").locator("[data-slot='settings-group-shell']"));
      const noteBox = await box(note);
      expect(noteBox.y - (groupBox.y + groupBox.height)).toBeCloseTo(8, 0);
      const notePadding = await note.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft));
      const rowBox = await box(row);
      expect(close(noteBox.x + notePadding, rowBox.x + reading.glyphLeft, 0.5), "note text on the glyph column").toBe(true);

      await page.addStyleTag({ content: WIDEN });
      assertRows([await readRow(row)], `${width} ${theme} widened`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      expect(((await reserved.textContent()) ?? "")).not.toMatch(/[—–]/);
      expect(errors).toEqual([]);

      testInfo.annotations.push({ type: "geometry", description: JSON.stringify({ width, theme, row: reading }) });
      const shotDir = process.env.RESERVED_OFFER_SHOT_DIR;
      if (shotDir) {
        await page.reload();
        await open(page, theme, state);
        await page.mouse.move(0, 0);
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, `geometry-${state}-${width}-${theme}.json`), JSON.stringify({ width, theme, row: reading }, null, 2));
        await page.locator("[data-pkm-memory-detail='true']").screenshot({ path: path.join(shotDir, `${state}-reserved-${width}-${theme}.png`) });
      }
    });
