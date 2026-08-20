import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  MAP_CONSENT_PANEL_BOTTOM_PADDING,
  MAP_CONSENT_PANEL_CLASSNAME,
  MAP_CONSENT_PANEL_DIALOG_MIN_WIDTH_PX,
  MAP_CONSENT_PANEL_DIALOG_WIDTH_PX,
  MAP_CONSENT_SUPPORTING_LINE,
  MAP_CONSENT_TITLE,
  MAP_RENDERER_CLASSNAME,
  MAP_SURFACE_CLASSNAME,
} from "../components/one-location/map-consent-panel-layout";

/**
 * Your Map's renderer-consent screen, measured in a real browser.
 *
 * Three defects were reported on this screen, and only one of them was a
 * layout defect:
 *
 *  1. "A large blank strip above the map." NOT layout. The surface is
 *     `h-[100dvh]` and the renderer is `absolute inset-0`; the strip was
 *     Google's out-of-world backdrop, exposed by a fixed camera that could not
 *     cover a tall viewport. That is proved by arithmetic in
 *     `__tests__/one-location/map-world-view.test.ts`, because it is a property
 *     of Mercator and a box size, not of CSS. What THIS file proves is the
 *     other half of that claim: the box really does reach the top of the
 *     screen, so nobody re-diagnoses the camera as a container next time.
 *  2. The consent panel floated a rem above the bottom edge, leaving a strip of
 *     map beneath a full-width card. Measured here.
 *  3. Three sentences of copy under the title. Its LENGTH is measured here --
 *     rendered line count in the real typeface at the narrowest supported
 *     width -- because a word budget in a JSDOM test cannot see wrapping.
 *
 * The screen itself is behind sign-in and a vault, so reaching it through the
 * app would need a fixture no CI lane has. This renders the real class strings,
 * imported from the component's own module, in the real cascade.
 *
 * Run with: npm run test:layout-contracts
 */

const WIDTHS = [320, 360, 375, 390, 430, 767, 768, 769, 1024, 1280] as const;

/** Heights that matter: the shortest supported phone, and the tallest. */
const HEIGHTS = [568, 667, 844, 932] as const;

/** Compile just the utilities this fixture uses, with the real Tailwind. */
async function buildFixture(): Promise<string> {
  // Playwright runs from the webapp root (its config lives there).
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
  };

  const compiler = await compile('@import "tailwindcss";', {
    base: path.join(webappRoot, "node_modules"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(webappRoot, "node_modules/tailwindcss/index.css")
          : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });

  const buttonClasses =
    "mt-4 w-full inline-flex items-center justify-center rounded-full min-h-[50px] text-[17px] font-semibold";
  const classes = [
    MAP_SURFACE_CLASSNAME,
    MAP_RENDERER_CLASSNAME,
    MAP_CONSENT_PANEL_CLASSNAME,
    buttonClasses,
    "mt-3 text-xl font-semibold",
    "mt-2 text-sm leading-6",
    "h-6 w-6",
  ].join(" ");
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-consent-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  /* The two theme tokens the measured classes read. Values are irrelevant to
     geometry; their PRESENCE is not -- an undefined custom property collapses
     to nothing and can change a border box. */
  :root { --muted: #eef2f7; --background: #ffffff; --border: #d8dee7; --foreground: #0b0d11; }
  /* Stands in for the renderer's own canvas so the map box is visible in a
     trace. The plugin injects its map into this element at runtime. */
  [data-testid="one-location-map-renderer"] { background: #cfe3f2; }
</style>
</head><body style="margin:0">
<main class="${MAP_SURFACE_CLASSNAME}" data-testid="one-location-map">
  <div class="${MAP_RENDERER_CLASSNAME}" data-testid="one-location-map-renderer"></div>
  <section class="${MAP_CONSENT_PANEL_CLASSNAME}"
           style="padding-bottom:${MAP_CONSENT_PANEL_BOTTOM_PADDING}"
           data-testid="one-location-map-disclosure">
    <svg class="h-6 w-6" viewBox="0 0 24 24"></svg>
    <h1 class="mt-3 text-xl font-semibold">${MAP_CONSENT_TITLE}</h1>
    <p class="mt-2 text-sm leading-6" data-testid="map-consent-support">${MAP_CONSENT_SUPPORTING_LINE}</p>
    <button class="${buttonClasses}" data-testid="one-location-map-consent-continue">Continue</button>
  </section>
</main></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("Your Map consent panel layout", () => {
  for (const width of WIDTHS) {
    const isDialog = width >= MAP_CONSENT_PANEL_DIALOG_MIN_WIDTH_PX;

    test(`is ${isDialog ? "a centred dialog" : "a bottom-anchored sheet"} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const panel = page.getByTestId("one-location-map-disclosure");
      await expect(panel).toBeVisible();

      const measured = await panel.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const root = document.documentElement;
        return {
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          centerX: box.left + box.width / 2,
          overflow:
            Math.max(root.scrollWidth, document.body.scrollWidth) -
            root.clientWidth,
        };
      });

      // Nothing may push the page sideways at any width.
      expect(measured.overflow).toBeLessThanOrEqual(1);
      expect(measured.left).toBeGreaterThanOrEqual(-1);
      expect(measured.right).toBeLessThanOrEqual(width + 1);

      if (isDialog) {
        expect(
          Math.abs(measured.width - MAP_CONSENT_PANEL_DIALOG_WIDTH_PX),
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(measured.centerX - width / 2)).toBeLessThanOrEqual(1);
      } else {
        // The reported defect: a full-width card that stopped short of the
        // bottom edge, leaving a strip of live map under it. On a phone the
        // panel is the screen's content surface and reaches the edge.
        expect(Math.abs(measured.width - width)).toBeLessThanOrEqual(1);
        expect(Math.abs(measured.bottom - 844)).toBeLessThanOrEqual(1);
      }
    });
  }

  for (const height of HEIGHTS) {
    test(`fills the viewport from the very top at 390x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const geometry = await page.evaluate(() => {
        const surface = document
          .querySelector('[data-testid="one-location-map"]')!
          .getBoundingClientRect();
        const renderer = document
          .querySelector('[data-testid="one-location-map-renderer"]')!
          .getBoundingClientRect();
        const panel = document
          .querySelector('[data-testid="one-location-map-disclosure"]')!
          .getBoundingClientRect();
        return {
          surface: { top: surface.top, height: surface.height },
          renderer: {
            top: renderer.top,
            left: renderer.left,
            width: renderer.width,
            height: renderer.height,
          },
          panelTop: panel.top,
        };
      });

      // The claim the reported "white patch" made about this screen, tested.
      // The renderer starts at the top of the viewport and is exactly as wide
      // as it -- there is no header strip, margin or reserved toolbar above it.
      expect(geometry.renderer.top).toBeLessThanOrEqual(0.5);
      expect(geometry.renderer.left).toBeLessThanOrEqual(0.5);
      expect(Math.abs(geometry.renderer.width - 390)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.surface.height - height)).toBeLessThanOrEqual(1);
      // And the renderer fills the surface, so a taller phone is more map
      // rather than more panel.
      expect(
        Math.abs(geometry.renderer.height - geometry.surface.height),
      ).toBeLessThanOrEqual(1);
      // The map keeps most of the screen even on the shortest supported phone.
      expect(geometry.panelTop / height).toBeGreaterThan(0.5);
    });
  }

  test("spends extra screen height on map, not on panel", async ({ page }) => {
    // "A taller phone should generally show more map." The panel is sized by
    // its content, so the whole difference between an SE and a Pro Max goes to
    // the map -- rather than a content region that stretches with the viewport.
    const measurements: Array<{ height: number; map: number; panel: number }> =
      [];

    for (const height of HEIGHTS) {
      await page.setViewportSize({ width: 390, height });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const panel = await page
        .getByTestId("one-location-map-disclosure")
        .evaluate((node) => {
          const box = node.getBoundingClientRect();
          return { top: box.top, height: box.height };
        });
      measurements.push({ height, map: panel.top, panel: panel.height });
    }

    for (let index = 1; index < measurements.length; index += 1) {
      const previous = measurements[index - 1];
      const current = measurements[index];
      // Every extra pixel of viewport becomes a pixel of map.
      expect(
        current.map - previous.map,
        `${previous.height}px -> ${current.height}px`,
      ).toBeCloseTo(current.height - previous.height, 0);
      // And the panel does not grow with the screen.
      expect(Math.abs(current.panel - previous.panel)).toBeLessThanOrEqual(1);
    }
  });

  test("keeps the supporting copy to one rendered line at the narrowest width", async ({
    page,
  }) => {
    // The hard limit is two short lines. Measured, not counted in words: the
    // paragraph this replaced was inside the same character budget people
    // usually check and still wrapped to five lines on a phone.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(await buildFixture());
    await awaitProductFont(page);

    const lines = await page
      .getByTestId("map-consent-support")
      .evaluate((node) => {
        const style = getComputedStyle(node);
        const lineHeight = parseFloat(style.lineHeight);
        return Math.round(node.getBoundingClientRect().height / lineHeight);
      });

    expect(lines).toBeLessThanOrEqual(2);
    expect(lines).toBe(1);
  });

  test("keeps Continue inside the viewport and clear of the bottom edge", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(await buildFixture());
    await awaitProductFont(page);

    const cta = page.getByTestId("one-location-map-consent-continue");
    await expect(cta).toBeVisible();

    const box = (await cta.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(568 + 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320 + 1);
    // Touch target. The panel's own bottom padding is what keeps this clear of
    // the home indicator; `env()` resolves to 0 in a desktop browser, so the
    // inset itself is asserted as a declared value rather than a measurement.
    expect(box.height).toBeGreaterThanOrEqual(44);

    const declared = await page
      .getByTestId("one-location-map-disclosure")
      .evaluate((node) => (node as HTMLElement).style.paddingBottom);
    expect(declared).toContain("safe-area-inset-bottom");
  });
});
