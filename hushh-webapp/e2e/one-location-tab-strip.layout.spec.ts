import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * The Location hub's Menu / People / Links strip, measured against the cards
 * under it.
 *
 * Reported: the strip should span the content width "jaisa apple mein hota
 * hain". It did not, for two stacked reasons, and neither was visible without
 * measuring:
 *
 *   1. The tablist carried `mx-5` INSIDE a frame that already applies
 *      `px-[var(--page-inline-gutter-standard)]`, so it paid the page gutter
 *      twice — left edge 36px against the cards' 16px, 40px narrower on EVERY
 *      phone. This is not a desktop-only defect.
 *   2. It capped at `max-w-[720px]`, a number belonging to nothing else on the
 *      screen, while the Location column is 880px. 112px short at 1024, 104px
 *      at 1280 and 1440.
 *
 * THE ASSERTION IS DELIBERATELY RELATIVE. It compares the tablist's edges to
 * the MEASURED card's edges, never to 880 or 824. Asserting literals would lock
 * in the coupling to `AppPageShell width="agent"` rather than guard it: change
 * that prop and a literal test keeps passing while the strip silently
 * mismatches again.
 *
 * The strip lives in the FIXED top bar and the cards live in the page, so they
 * are siblings, not ancestor and descendant — two independently measured
 * frames that have to agree. That is exactly why this needs a browser.
 *
 * Run: npx playwright test e2e/one-location-tab-strip.layout.spec.ts
 */

const WEBAPP_ROOT = process.cwd();

/** Every compact width the product supports, plus the desktop steps. */
const WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1440] as const;

/**
 * The Location tablist's class string, read out of the component.
 *
 * Anchored on the `isLocationTabs` branch rather than on the class text itself.
 * Anchoring on the text means any edit to it makes this throw "marker not
 * found" instead of reporting the geometry that actually broke — the spec would
 * fail, but for the wrong reason, and would say nothing useful.
 */
function locationTablistClass(): string {
  const source = fs.readFileSync(
    path.join(WEBAPP_ROOT, "components/app-ui/top-shell-tabs.tsx"),
    "utf8",
  );
  const base = source.match(
    /aria-label=\{`\$\{tabSet\.label\} navigation`\}\s*className=\{cn\(\s*"([^"]+)"/,
  )?.[1];
  if (!base) throw new Error("Location tablist base class string not found");
  // Anchored on the pill's own fill token, which is what makes this element the
  // Location segmented control and appears nowhere else in the file. Anchoring
  // on the width classes instead would make any edit to them throw "not found"
  // rather than report the geometry that broke.
  const anchor = source.indexOf("bg-[color:var(--app-neutral-fill)]");
  if (anchor < 0) throw new Error("Location tablist fill token not found");
  const open = source.lastIndexOf('"', anchor);
  const close = source.indexOf('"', anchor);
  if (open < 0 || close < 0) throw new Error("tablist class string not found");
  return `${base} ${source.slice(open + 1, close)}`;
}

const TABLIST_CLASS = locationTablistClass();

/** The top bar's frame and the page shell's frame — the two that must agree. */
const FRAME_CLASS = "mx-auto w-full px-[var(--page-inline-gutter-standard)]";

async function buildFixture(theme: "light" | "dark" = "light"): Promise<string> {
  const { compile } = (await import(
    path.join(WEBAPP_ROOT, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (css: string, opts: unknown) => Promise<{ build: (c: string[]) => string }>;
  };

  const globals = fs
    .readFileSync(path.join(WEBAPP_ROOT, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, "");
  const compiler = await compile(globals, {
    base: path.join(WEBAPP_ROOT, "app"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(WEBAPP_ROOT, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css"
            ? path.join(WEBAPP_ROOT, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });

  const markup = `
<div data-app-top-bar style="position:fixed;inset-inline:0;top:0">
  <div style="position:relative;width:100%">
    <div class="${FRAME_CLASS} flex flex-col" style="max-width:80rem">
      <div style="position:relative;width:100%;flex-shrink:0">
        <div class="flex h-14 w-full items-center justify-center">
          <div data-testid="tablist" role="tablist" class="${TABLIST_CLASS}">
            <button class="flex h-full flex-1 items-center justify-center px-3">Menu</button>
            <button class="flex h-full flex-1 items-center justify-center px-3">People</button>
            <button class="flex h-full flex-1 items-center justify-center px-3">Links</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<main class="app-page-shell ${FRAME_CLASS} max-w-[880px]" data-app-shell-width="agent" style="padding-top:56px">
  <div class="w-full min-w-0 space-y-4">
    <div data-testid="card" data-ui-role="grouped-card" style="height:60px;background:var(--app-card-surface-default-solid);border-radius:24px"></div>
  </div>
</main>`;

  const used = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  // The app's own @font-face rules cannot load over file:// and, sharing a
  // family name with the working one, stop it satisfying fonts.check.
  const css = stripAppFontFaces(compiler.build([...used]));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tab-strip-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="fixture.css">
<style>
  body{margin:0}
${productFontStyle()}
</style>
</head><body>${markup}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("One Location tab strip", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [320, 768, 1440] as const) {
      test(`${theme} tab strip uses product tokens at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(await buildFixture(theme));
        await awaitProductFont(page);
        const state = await page.evaluate(() => {
          const tablist = document.querySelector<HTMLElement>(
            '[data-testid="tablist"]',
          )!;
          const tokenProbe = document.createElement("div");
          tokenProbe.style.backgroundColor = "var(--app-neutral-fill)";
          document.body.append(tokenProbe);
          const result = {
            fill: getComputedStyle(tablist).backgroundColor,
            expectedFill: getComputedStyle(tokenProbe).backgroundColor,
            font: getComputedStyle(tablist).fontFamily,
            pageWidth: document.documentElement.scrollWidth,
          };
          tokenProbe.remove();
          return result;
        });
        expect(state.fill).toBe(state.expectedFill);
        expect(state.fill).not.toBe("rgba(0, 0, 0, 0)");
        expect(state.font).toContain("DMSansVariable");
        expect(state.pageWidth).toBeLessThanOrEqual(width + 1);
        if (process.env.ONE_THEME_EVIDENCE_DIR && (width === 320 || width === 1440)) {
          fs.mkdirSync(process.env.ONE_THEME_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.ONE_THEME_EVIDENCE_DIR, `location-${theme}-${width}.png`),
          });
        }
      });
    }
  }
  for (const width of WIDTHS) {
    test(`shares its edges with the cards below at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const tablist = document
          .querySelector('[data-testid="tablist"]')!
          .getBoundingClientRect();
        const card = document
          .querySelector('[data-testid="card"]')!
          .getBoundingClientRect();
        return {
          tabLeft: Math.round(tablist.left * 100) / 100,
          tabRight: Math.round(tablist.right * 100) / 100,
          tabWidth: Math.round(tablist.width * 100) / 100,
          cardLeft: Math.round(card.left * 100) / 100,
          cardRight: Math.round(card.right * 100) / 100,
          cardWidth: Math.round(card.width * 100) / 100,
        };
      });

      // THE CONTRACT: the strip and the cards are one column.
      expect(
        Math.abs(measured.tabLeft - measured.cardLeft),
        `left edges differ: strip ${measured.tabLeft} vs card ${measured.cardLeft}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(measured.tabRight - measured.cardRight),
        `right edges differ: strip ${measured.tabRight} vs card ${measured.cardRight}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(measured.tabWidth - measured.cardWidth),
        `widths differ: strip ${measured.tabWidth} vs card ${measured.cardWidth}`,
      ).toBeLessThanOrEqual(0.5);

      // And neither leaves the viewport.
      expect(measured.tabLeft).toBeGreaterThanOrEqual(-0.5);
      expect(measured.tabRight).toBeLessThanOrEqual(width + 0.5);
    });
  }

  test("caps to the page column rather than an unrelated number", async () => {
    // The cap has to be derived from the shell the page actually uses, or the
    // two drift apart again the next time either is retuned. Reading it here
    // stops a literal creeping back in.
    expect(TABLIST_CLASS).toContain("var(--app-shell-agent)");
    expect(TABLIST_CLASS).toContain("var(--page-inline-gutter-standard)");
    expect(TABLIST_CLASS).not.toContain("max-w-[720px]");
    // `mx-5` was the second inset that made it 40px narrower on every phone.
    expect(TABLIST_CLASS).not.toContain("mx-5");
  });
});
