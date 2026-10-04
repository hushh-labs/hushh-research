import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The secure Secrets card at the pixel grid (founder bar, 2026-09-29): 16 px
 * symmetric insets, 12 px section gaps, 56 px rows on the 4 pt scale, 44 px
 * controls, offers full width 8 px apart, bare duotone glyphs on a flat
 * surface, a ripple on every press, no bounce, no em dash and no sparkle.
 * Light and dark, phone and desktop, then again with the text widened (CI's
 * Linux faces set about 1.5 px wider). Set SECRETS_CARD_SHOT_DIR to capture
 * one screenshot and one geometry file per state, theme and width.
 */
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-card-"));
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
      lib: { entry: path.join(root, "e2e/fixtures/secrets-card.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

type State = "kept" | "revealed" | "locked" | "profile";

async function open(page: Page, theme: "light" | "dark", state: State) {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
  await page.route("http://localhost/secrets-card**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`http://localhost/secrets-card?state=${state}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  const card = page.locator(state === "profile" ? "[data-testid='profile-secrets-list']" : "[data-testid='secret-capture-card']");
  await expect(card).toBeVisible();
  return card;
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("element has no box");
  return bounds;
}

const round = (value: number) => Math.round(value * 100) / 100;
const onGrid = (value: number, unit: number) => Math.abs(value / unit - Math.round(value / unit)) < 0.02;

async function assertGrid(page: Page, card: Locator, state: State, label: string) {
  // Symmetric 16 px insets on all four sides of a flat surface.
  const surface = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat),
      border: parseFloat(style.borderLeftWidth),
      backdrop: style.backdropFilter,
      shadow: style.boxShadow,
    };
  });
  expect(surface.padding, label).toEqual([16, 16, 16, 16]);
  expect(surface.backdrop === "none" || surface.backdrop === "", `${label}: flat, no glass`).toBe(true);
  const cardBox = await box(card);
  const list = card.getByTestId("secret-rows");
  const listBox = await box(list);
  const leftInset = listBox.x - (cardBox.x + surface.border);
  const rightInset = cardBox.x + cardBox.width - surface.border - (listBox.x + listBox.width);
  expect(Math.abs(leftInset - rightInset), `${label}: symmetric insets`).toBeLessThan(0.5);
  expect(leftInset, label).toBeCloseTo(16, 0);

  // Vertical rhythm: every gap between sections is 12 px (the 4 pt scale).
  const sections = card.locator(":scope > *");
  const sectionBoxes = [];
  for (let index = 0; index < (await sections.count()); index += 1) sectionBoxes.push(await box(sections.nth(index)));
  const gaps = sectionBoxes.slice(1).map((section, index) => round(section.y - (sectionBoxes[index]!.y + sectionBoxes[index]!.height)));
  for (const gap of gaps) expect(gap, `${label}: section gap`).toBeCloseTo(12, 0);

  // Rows: at least 56 px, on the 4 pt grid; text starts 16 px inside the list.
  const rows = card.getByTestId("secret-row");
  const rowHeights: number[] = [];
  for (const row of await rows.all()) {
    const head = await box(row.locator(":scope > div").first());
    rowHeights.push(round(head.height));
    expect(head.height, `${label}: row height`).toBeGreaterThanOrEqual(56);
    expect(onGrid(head.height, 4), `${label}: row on the 4 pt grid (${head.height})`).toBe(true);
    const text = await box(row.getByTestId("secret-label"));
    expect(text.x - (listBox.x + 1), `${label}: row text inset`).toBeCloseTo(16, 0);
    expect(text.x + text.width, `${label}: label stays inside the row`).toBeLessThanOrEqual(listBox.x + listBox.width);
  }

  // Every control meets the 44 px target, carries the ripple, and stays inside.
  const controls = card.locator("button");
  for (const control of await controls.all()) {
    const bounds = await box(control);
    expect(bounds.height, `${label}: 44 px control`).toBeGreaterThanOrEqual(44);
    expect(bounds.x + bounds.width, `${label}: control inside the card`).toBeLessThanOrEqual(cardBox.x + cardBox.width - 16 + 0.5);
    expect(await control.locator(".morphy-ripple-host").count(), `${label}: ripple on`).toBe(1);
  }

  // Offers: full list width, 8 px apart, each glyph bare (no tile behind it).
  const offers = card.getByTestId("secret-offer");
  const offerBoxes = await Promise.all((await offers.all()).map(box));
  for (const offer of offerBoxes) expect(Math.abs(offer.width - listBox.width), `${label}: offer width`).toBeLessThan(0.5);
  for (let index = 1; index < offerBoxes.length; index += 1) {
    expect(offerBoxes[index]!.y - (offerBoxes[index - 1]!.y + offerBoxes[index - 1]!.height), `${label}: offer gap`).toBeCloseTo(8, 0);
  }
  const glyphs = card.locator("svg");
  for (const glyph of await glyphs.all()) {
    const parentFill = await glyph.evaluate((node) => getComputedStyle(node.parentElement!).backgroundColor);
    const isButton = await glyph.evaluate((node) => Boolean(node.closest("button")));
    if (!isButton) expect(parentFill, `${label}: bare glyph`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
  // The header glyph is a 20 px duotone, centred on its title line.
  const headerGlyph = await box(card.locator("header svg"));
  const title = await box(card.locator("header [role='status']"));
  expect(headerGlyph.width).toBeCloseTo(20, 0);
  expect(Math.abs(headerGlyph.y + headerGlyph.height / 2 - (title.y + title.height / 2)), `${label}: glyph centred`).toBeLessThan(0.5);
  expect(await card.locator("header svg [opacity]").count(), `${label}: duotone`).toBeGreaterThan(0);

  if (state === "revealed" || state === "profile") {
    const revealed = card.getByTestId("secret-revealed");
    const value = await box(card.getByTestId("secret-revealed-value"));
    const label0 = await box(card.getByTestId("secret-label").first());
    expect(Math.abs(value.x - label0.x), `${label}: value aligns with its label`).toBeLessThan(0.5);
    expect(await revealed.evaluate((element) => getComputedStyle(element).rowGap)).toBe("8px");
    if (state === "profile") {
      // The remove control's words start on the same edge as the label and value.
      const removeText = await card.getByTestId("secret-remove").evaluate((node) => {
        // The words themselves, not the ripple layer that spans the button.
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let left = Infinity;
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          if (!text.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          left = Math.min(left, range.getBoundingClientRect().left);
        }
        return left;
      });
      expect(Math.abs(removeText - label0.x), `${label}: remove aligns`).toBeLessThan(1);
    }
    // Labels never lose their words to a second control on the row.
    for (const rowLabel of await card.getByTestId("secret-label").all()) {
      expect(await rowLabel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${label}: label whole`).toBe(true);
    }
  }

  // Reduced motion: nothing slides, nothing bounces.
  expect(await card.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.locator("[class*='bounce' i]").count()).toBe(0);
  // Brand and punctuation: never a sparkle glyph or an em dash.
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).not.toMatch(/[—–]/);
  expect(await page.locator("[data-icon*='sparkle' i], [class*='sparkle' i]").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), `${label}: no sideways scroll`).toBe(false);

  return {
    padding: surface.padding, leftInset: round(leftInset), rightInset: round(rightInset), sectionGaps: gaps, rowHeights,
    offerWidths: offerBoxes.map((offer) => round(offer.width)), listWidth: round(listBox.width),
    headerGlyph: { width: round(headerGlyph.width), centreOffset: round(headerGlyph.y + headerGlyph.height / 2 - (title.y + title.height / 2)) },
  };
}

const STATES: readonly State[] = ["kept", "revealed", "locked", "profile"];

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`secrets card sits on the 4/8 grid at ${width}px, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shotDir = process.env.SECRETS_CARD_SHOT_DIR;
      for (const state of STATES) {
        const card = await open(page, theme, state);
        const metrics = await assertGrid(page, card, state, `${width} ${theme} ${state}`);
        // The transcript chip names the secret; the value is nowhere on the page.
        await expect(page.getByTestId("secret-placeholder-chip")).toHaveCount(2);
        expect(await page.locator("main").textContent()).not.toContain("⟦");
        // An offer reads whole: its label wraps, it is never cut with an ellipsis.
        for (const offer of await card.getByTestId("secret-offer").locator("span").all()) {
          expect(await offer.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${width} ${theme} offer label whole`).toBe(true);
        }
        if (shotDir) {
          fs.mkdirSync(shotDir, { recursive: true });
          await page.setViewportSize({ width, height: 1400 });
          await page.locator("main").screenshot({ path: path.join(shotDir, `secrets-${state}-${width}-${theme}-${testInfo.project.name}.png`), animations: "disabled" });
          await page.setViewportSize({ width, height });
        }

        await page.addStyleTag({ content: "[data-testid='secret-label'], button, [role='status'] { letter-spacing: 0.3px }" });
        const widened = await assertGrid(page, card, state, `${width} ${theme} ${state} widened`);

        const geometry = { project: testInfo.project.name, width, theme, state, metrics, widened };
        testInfo.annotations.push({ type: "geometry", description: JSON.stringify(geometry) });
        if (shotDir) {
          fs.writeFileSync(path.join(shotDir, `geometry-${state}-${width}-${theme}-${testInfo.project.name}.json`), JSON.stringify(geometry, null, 2));
        }
      }
      expect(errors).toEqual([]);
    });
