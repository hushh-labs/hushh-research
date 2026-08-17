import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  READY_MAP_CLASSNAME,
  READY_PANEL_CLASSNAME,
  READY_PANEL_DIALOG_MIN_WIDTH_PX,
  READY_PANEL_DIALOG_WIDTH_PX,
  READY_SURFACE_CLASSNAME,
} from "../components/one-location/onboarding/ready-panel-layout";

/**
 * The invite panel on the final onboarding screen, measured in a real browser.
 *
 * The sibling JSDOM test proves the component still renders these classes; it
 * cannot prove what they do, because JSDOM performs no layout. That gap is not
 * academic -- the bug this guards against (the panel anchored to the right edge
 * instead of centred) is invisible to a class assertion and shows up here as a
 * ~348px offset at desktop width.
 *
 * The screen itself only exists for a brand-new account, so reaching it through
 * the app would need a first-run fixture. Instead this renders the real class
 * strings, imported from the component's own module, in the real cascade. That
 * proves the half a class assertion cannot: that these classes centre the box.
 *
 * Run with: npm run test:layout-contracts
 */

const WIDTHS = [320, 360, 375, 390, 430, 767, 768, 769, 1024, 1280] as const;

/** Compile just the utilities this fixture uses, with the real Tailwind. */
async function buildFixture(): Promise<string> {
  // Playwright runs from the webapp root (its config lives there).
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as { compile: (css: string, opts: unknown) => Promise<{ build: (c: string[]) => string }> };

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

  const classes = `${READY_SURFACE_CLASSNAME} ${READY_MAP_CLASSNAME} ${READY_PANEL_CLASSNAME} h-screen flex flex-col`;
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ready-panel-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css"></head><body style="margin:0">
<div class="h-screen flex flex-col">
  <div class="${READY_SURFACE_CLASSNAME}" data-testid="one-location-onboarding-ready-surface">
    <div class="${READY_MAP_CLASSNAME}" data-testid="onboarding-live-map"></div>
    <div class="${READY_PANEL_CLASSNAME}" data-testid="one-location-onboarding-ready-panel">
      <div style="padding:24px">
        <h1>You&apos;re on the map.</h1><p>Private until you share.</p>
        <p>SWDX-ENDP-B954</p><button>Copy</button><button>Share</button>
      </div>
    </div>
  </div>
</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("One Location ready panel layout", () => {
  for (const width of WIDTHS) {
    const isDialog = width >= READY_PANEL_DIALOG_MIN_WIDTH_PX;

    test(`is ${isDialog ? "centred as a dialog" : "a full-width sheet"} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const panel = page.getByTestId("one-location-onboarding-ready-panel");
      await expect(panel).toBeVisible();

      const measured = await panel.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const root = document.documentElement;
        return {
          left: box.left,
          right: box.right,
          width: box.width,
          centerX: box.left + box.width / 2,
          position: getComputedStyle(node).position,
          overflow:
            Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
        };
      });

      // Nothing may push the page sideways at any width.
      expect(measured.overflow).toBeLessThanOrEqual(1);
      expect(measured.left).toBeGreaterThanOrEqual(-1);
      expect(measured.right).toBeLessThanOrEqual(width + 1);

      if (isDialog) {
        expect(measured.position).toBe("absolute");
        expect(Math.abs(measured.width - READY_PANEL_DIALOG_WIDTH_PX)).toBeLessThanOrEqual(1);
        // The regression this file exists for: right-anchored was ~348px off here.
        expect(Math.abs(measured.centerX - width / 2)).toBeLessThanOrEqual(1);
      } else {
        // Phone widths -- and therefore the iOS build -- keep the sheet in flow.
        expect(measured.position).not.toBe("absolute");
        expect(Math.abs(measured.width - width)).toBeLessThanOrEqual(1);
      }
    });
  }
});
