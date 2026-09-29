import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * One's onboarding chips, connect action and daily tip in a real browser with
 * the real modules and the app stylesheet. JSDOM has no layout, so it cannot
 * see a chip rail that scrolls the page sideways on a phone, a tap target that
 * shrank under 44px, or an action that slid out of the reading column.
 *
 * Run: CI=1 npx playwright test e2e/chat-onboarding.layout.spec.ts --project=chromium
 */

let css: string;
let script: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-onboarding-"));
  await build({
    configFile: false,
    logLevel: "error",
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
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/chat-onboarding.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
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

async function mount(page: Page, theme: "light" | "dark") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost/chat-onboarding", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${theme}"><head><title>Chat onboarding layout contract</title><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto("http://localhost/chat-onboarding");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("transcript")).toBeVisible();
  return errors;
}

async function assertContract(page: Page, viewportWidth: number) {
  // No sideways page scroll: the chip rail wraps inside the column.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const chips = page.getByTestId("chat-onboarding-chips").getByRole("button");
  await expect(chips).toHaveCount(7);
  for (const box of await chips.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().toJSON() as DOMRect),
  )) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  }

  // Chips and the connect action start at the assistant column's left edge.
  const bubble = (await page.locator('[data-message-role="assistant"]').first().boundingBox())!;
  const firstChip = (await chips.first().boundingBox())!;
  const connect = (await page.getByTestId("chat-onboarding-connect").boundingBox())!;
  expect(Math.abs(firstChip.x - bubble.x)).toBeLessThanOrEqual(6);
  expect(Math.abs(connect.x - bubble.x)).toBeLessThanOrEqual(6);
  expect(connect.height).toBeGreaterThanOrEqual(44);

  // The tip's dismiss control keeps a full tap target.
  const dismiss = (await page.getByRole("button", { name: "Dismiss tip" }).boundingBox())!;
  expect(dismiss.width).toBeGreaterThanOrEqual(44);
  expect(dismiss.height).toBeGreaterThanOrEqual(44);
}

type Rgba = [number, number, number, number];

function luminance([r, g, b]: Rgba) {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Selects the person's own message and reads the highlight the browser would
 * paint, resolved to pixels by painting it on a canvas: the selection colour
 * over each stop of the bubble's accent gradient, and the selected text alone.
 * The regression this guards: the theme highlight is the accent at 28%, so on
 * the accent bubble selected text was invisible.
 */
async function ownBubbleSelection(page: Page) {
  const text = page.locator('[data-message-role="user"] span').first();
  return text.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (...colors: string[]) => {
      context.clearRect(0, 0, 1, 1);
      for (const color of colors) {
        context.fillStyle = "rgba(1, 2, 3, 0.5)";
        context.fillStyle = color;
        if (context.fillStyle === "rgba(1, 2, 3, 0.5)") throw new Error(`unparsed colour ${color}`);
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data] as [number, number, number, number];
    };
    const bubble = getComputedStyle(node.parentElement!);
    const own = getComputedStyle(node, "::selection");
    const accent = bubble.getPropertyValue("--app-accent").trim();
    const accentDeep = bubble.getPropertyValue("--app-accent-deep").trim();
    return {
      ownBackground: own.backgroundColor,
      themeBackground: getComputedStyle(document.body, "::selection").backgroundColor,
      bubbleImage: bubble.backgroundImage,
      text: paint(own.color),
      stops: [accent, accentDeep].map((stop) => ({
        fill: paint(stop),
        highlight: paint(stop, own.backgroundColor),
      })),
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`phone (${theme})`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("chips wrap inside the column with full tap targets", async ({ page }) => {
      const errors = await mount(page, theme);
      await assertContract(page, 390);
      await page.screenshot({ path: test.info().outputPath(`phone-${theme}.png`), fullPage: true });
      expect(errors).toEqual([]);
    });

    test("selected text on the person's own bubble stays readable", async ({ page }) => {
      const errors = await mount(page, theme);
      const selected = await ownBubbleSelection(page);
      await page
        .locator('[data-message-role="user"]')
        .first()
        .screenshot({ path: test.info().outputPath(`selection-${theme}.png`) });

      expect(selected.bubbleImage).toContain("linear-gradient");
      expect(selected.ownBackground).not.toBe(selected.themeBackground);
      for (const stop of selected.stops) {
        // The highlight separates from the bubble (WCAG 1.4.11 non-text, 3:1)
        // and the selected text reads on the highlight (WCAG AA body, 4.5:1).
        expect(contrast(stop.highlight, stop.fill)).toBeGreaterThanOrEqual(3);
        expect(contrast(selected.text, stop.highlight)).toBeGreaterThanOrEqual(4.5);
      }
      expect(errors).toEqual([]);
    });
  });

  test.describe(`desktop (${theme})`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("chips sit under One's reply, and the keyboard walks them", async ({ page }) => {
      const errors = await mount(page, theme);
      await assertContract(page, 1440);

      const chips = page.getByTestId("chat-onboarding-chips").getByRole("button");
      await chips.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(chips.nth(1)).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.getByRole("button", { name: "Skip for now" })).toBeFocused();

      await page.getByRole("button", { name: "Dismiss tip" }).click();
      await expect(page.getByTestId("chat-onboarding-daily-tip")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`desktop-${theme}.png`), fullPage: true });
      expect(errors).toEqual([]);
    });
  });
}
