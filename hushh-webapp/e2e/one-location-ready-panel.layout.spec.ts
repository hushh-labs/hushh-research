import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  READY_CODE_CLASSNAME,
  READY_MAP_CLASSNAME,
  READY_MAP_SHORT_WINDOW_CSS,
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

  const classes = `${READY_SURFACE_CLASSNAME} ${READY_MAP_CLASSNAME} ${READY_PANEL_CLASSNAME} ${READY_CODE_CLASSNAME} h-screen flex flex-col`;
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ready-panel-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<!-- The component's own short-window rule, read from the module it renders
     from rather than copied here, so the two cannot drift apart. -->
<style>${READY_MAP_SHORT_WINDOW_CSS}</style></head><body style="margin:0">
<div class="h-screen flex flex-col">
  <div class="${READY_SURFACE_CLASSNAME}" data-testid="one-location-onboarding-ready-surface">
    <div class="${READY_MAP_CLASSNAME}" data-testid="onboarding-live-map"></div>
    <div class="${READY_PANEL_CLASSNAME}" data-testid="one-location-onboarding-ready-panel">
      <div style="padding:24px">
        <h1>You&apos;re on the map.</h1><p>Private until you share.</p>
        <!-- The invite card's real insets: the panel's px-6 (24px, above) plus
             the card's own p-5. The code has to survive both at 320px. -->
        <div style="padding:20px;border:1px solid #e4e6e9;border-radius:20px">
          <p style="font-size:13px">Ankit&apos;s Circle</p>
          <p class="${READY_CODE_CLASSNAME}" data-testid="one-location-onboarding-invite-code">SWDX-ENDP-B954</p>
          <p style="font-size:12px">Expires in 72 hours</p>
        </div>
        <button>Copy</button><button>Share</button>
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

/**
 * The invite code, measured rather than reasoned about.
 *
 * Twelve characters of fixed-width type with two separators cannot reflow: at
 * any width it either fits or it clips, and half a circle code is not a circle
 * code. The arithmetic says it fits inside a 320px phone once the panel's 24px
 * insets and the card's 20px insets are taken off; this is the check that the
 * arithmetic is right, in a real engine, with the real class string.
 */
const PHONE_WIDTHS = [320, 360, 375, 390, 430] as const;

test.describe("One Location invite code", () => {
  for (const width of PHONE_WIDTHS) {
    test(`is never clipped or ellipsized at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const code = page.getByTestId("one-location-onboarding-invite-code");
      await expect(code).toBeVisible();

      const measured = await code.evaluate((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          overflowX: node.scrollWidth - node.clientWidth,
          overflowY: node.scrollHeight - node.clientHeight,
          textOverflow: style.textOverflow,
          webkitLineClamp: style.webkitLineClamp,
          fontSizePx: Number.parseFloat(style.fontSize),
          left: box.left,
          right: box.right,
          text: (node.textContent ?? "").trim(),
        };
      });

      expect(measured.text).toBe("SWDX-ENDP-B954");
      expect(measured.overflowX).toBeLessThanOrEqual(1);
      expect(measured.overflowY).toBeLessThanOrEqual(1);
      expect(measured.textOverflow).not.toBe("ellipsis");
      expect(measured.webkitLineClamp).toBe("none");
      // Small enough to fit is not the same as readable. The clamp floor is
      // 20px and nothing may take it below that.
      expect(measured.fontSizePx).toBeGreaterThanOrEqual(20);
      expect(measured.left).toBeGreaterThanOrEqual(-1);
      expect(measured.right).toBeLessThanOrEqual(width + 1);
    });
  }
});

/**
 * The map band's share of the screen.
 *
 * It grew from 34dvh to 42dvh when it stopped being a decorative grid and
 * started being a map of where the person is -- the ticket's "the map can
 * occupy more useful visual area rather than leaving a giant blank white
 * middle". The two failure modes that bound it are opposite, so both are
 * measured: too small to read as a place, and so tall that the panel below it
 * loses the invite code and the primary action.
 */
const PHONE_HEIGHTS = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 15", width: 390, height: 844 },
  { name: "iPhone 15 Pro Max", width: 430, height: 932 },
] as const;

test.describe("One Location finale map band", () => {
  for (const device of PHONE_HEIGHTS) {
    test(`leaves room for the panel on ${device.name}`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const map = document.querySelector<HTMLElement>(
          '[data-testid="onboarding-live-map"]',
        );
        const panel = document.querySelector<HTMLElement>(
          '[data-testid="one-location-onboarding-ready-panel"]',
        );
        if (!map || !panel) throw new Error("fixture missing a node");
        return {
          mapHeight: map.getBoundingClientRect().height,
          panelHeight: panel.getBoundingClientRect().height,
          viewport: window.innerHeight,
        };
      });

      const share = measured.mapHeight / measured.viewport;
      // Enough map to read as a place. The old band bottomed out near a fifth
      // of the screen on a short phone.
      expect(share).toBeGreaterThan(0.22);
      // And never so much that the panel becomes a strip. The panel holds the
      // code, both invite actions, the way in and the primary action.
      expect(share).toBeLessThan(0.5);
      expect(measured.panelHeight).toBeGreaterThan(measured.viewport * 0.45);
    });
  }
});
