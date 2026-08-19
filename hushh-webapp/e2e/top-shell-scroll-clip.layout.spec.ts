import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  resolveTopChromeCollapseProgress,
  resolveTopChromeOpacityProgress,
  TOP_CHROME_ROW_MAX_HEIGHT_CSS,
  TOP_CHROME_ROW_OPACITY_CSS,
} from "../lib/navigation/top-chrome-scroll-progress";

/**
 * The fixed top shell's "🤫 One" brand row used to fade its opacity and lose
 * its reserved height (`max-height` + `overflow: hidden`) off the SAME raw
 * scroll-progress value, so through most of the collapse gesture the row was
 * still visibly opaque while its bottom edge was already being cropped — a
 * hard clip line through the mark and title, worst on the /one "Your agents"
 * dashboard, where the row sits directly above the page's own heading.
 *
 * `resolveTopChromeCollapseProgress` now holds the row at full height until
 * `resolveTopChromeOpacityProgress` has finished fading it to zero (see
 * lib/navigation/top-chrome-scroll-progress.ts). This file proves that
 * invariant against the REAL formulas the component writes
 * (`TOP_CHROME_ROW_MAX_HEIGHT_CSS` / `TOP_CHROME_ROW_OPACITY_CSS`), rendered
 * in an actual browser at every point across the scroll gesture — not just
 * the resting state e2e/app-shell-top-clearance.layout.spec.ts covers.
 *
 * Run with: npm run test:layout-contracts
 */

// iPhone SE, iPhone 15, iPhone 15 Pro Max — the iOS-first minimum this
// screen has to work on.
const WIDTHS = [375, 393, 430] as const;

// Sampled across the whole 0–1 gesture; the defect this guards showed up at
// every intermediate value, not just the endpoints.
const PROGRESS_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

async function buildStylesheet(): Promise<string> {
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

  const globals = fs
    .readFileSync(path.join(webappRoot, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, "");

  const compiler = await compile(globals, {
    base: path.join(webappRoot, "app"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(webappRoot, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css"
            ? path.join(
                webappRoot,
                "node_modules/tw-animate-css/dist/tw-animate.css",
              )
            : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });

  // No app-defined utility classes are needed here — only the :root token
  // block, which the theme layer emits regardless of the candidate list.
  return compiler.build([]);
}

/**
 * A minimal reproduction of the real fixed-bar markup
 * (components/app-ui/top-app-bar.tsx): a header box whose max-height and
 * opacity are the exact formulas the component ships, wrapping a row of
 * fixed height `var(--top-bar-h)` that holds the brand mark and title.
 */
function shellMarkup(): string {
  return `<div data-app-top-bar style="position: fixed; inset-inline: 0; top: 0; z-index: 50;">
      <div data-testid="app-top-shell-layout" style="position: relative; width: 100%;">
        <div
          data-testid="top-app-bar-header"
          style="position: relative; overflow: hidden; transform: translate3d(0,0,0);
            max-height: ${TOP_CHROME_ROW_MAX_HEIGHT_CSS};
            padding-top: calc(var(--top-inset) + var(--top-systembar-row-gap));
            opacity: ${TOP_CHROME_ROW_OPACITY_CSS};"
        >
          <div
            data-testid="top-app-bar-row"
            style="position: relative; width: 100%; height: var(--top-bar-h); display: flex; align-items: center; gap: 8px;"
          >
            <span data-testid="brand-mark" style="font-size: 23px; line-height: 1;">🤫</span>
            <span data-testid="brand-title" style="font-size: 20px; font-weight: 600; line-height: 1;">One</span>
          </div>
        </div>
      </div>
    </div>`;
}

async function writeFixture(): Promise<string> {
  const css = await buildStylesheet();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "top-shell-scroll-clip-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  html { --top-chrome-collapse-px: 0px; --top-chrome-progress: 0; }
  body { margin: 0; }
</style></head>
<body>${shellMarkup()}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("top shell scroll clip", () => {
  for (const width of WIDTHS) {
    test(`the brand row never clips while visible at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await writeFixture());

      const rowHeight = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;visibility:hidden;height:var(--top-bar-h);";
        document.body.appendChild(probe);
        const height = probe.getBoundingClientRect().height;
        probe.remove();
        return height;
      });

      for (const progress of PROGRESS_STEPS) {
        const opacityProgress = resolveTopChromeOpacityProgress(progress);
        const collapseProgress = resolveTopChromeCollapseProgress(progress);
        const collapsePx = Math.max(0, rowHeight * collapseProgress);

        const measured = await page.evaluate(
          ({ opacityProgress, collapsePx }) => {
            const root = document.documentElement;
            root.style.setProperty("--top-chrome-progress", String(opacityProgress));
            root.style.setProperty("--top-chrome-collapse-px", `${collapsePx}px`);
            const header = document.querySelector(
              '[data-testid="top-app-bar-header"]',
            )!;
            const row = document.querySelector(
              '[data-testid="top-app-bar-row"]',
            )!;
            return {
              opacity: parseFloat(getComputedStyle(header).opacity),
              headerBottom: header.getBoundingClientRect().bottom,
              rowBottom: row.getBoundingClientRect().bottom,
            };
          },
          { opacityProgress, collapsePx },
        );

        // The defect: a still-visible row (opacity above a barely-perceptible
        // floor) whose content sits below the header's own clamped bottom
        // edge — i.e. `overflow: hidden` is already cropping something a
        // person can still see. 0.5px covers sub-pixel rounding only.
        if (measured.opacity > 0.02) {
          expect(
            measured.rowBottom,
            `at progress=${progress} (opacity=${measured.opacity.toFixed(3)}), the row bottom (${measured.rowBottom.toFixed(2)}px) sits below the header's clamped bottom (${measured.headerBottom.toFixed(2)}px) while still visible`,
          ).toBeLessThanOrEqual(measured.headerBottom + 0.5);
        }
      }
    });
  }

  test("opacity and collapse curves both finish exactly at progress = 1", async ({
    page,
  }) => {
    // Sanity check on the fixture itself: a fully scrolled page must still
    // fully reclaim the row's space, not get stuck holding phantom height.
    await page.setViewportSize({ width: 393, height: 900 });
    await page.goto(await writeFixture());

    const rowHeight = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;height:var(--top-bar-h);";
      document.body.appendChild(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    });

    const collapsePx = rowHeight * resolveTopChromeCollapseProgress(1);
    const measured = await page.evaluate(
      ({ collapsePx }) => {
        const root = document.documentElement;
        root.style.setProperty("--top-chrome-progress", "1");
        root.style.setProperty("--top-chrome-collapse-px", `${collapsePx}px`);
        const header = document.querySelector(
          '[data-testid="top-app-bar-header"]',
        )!;
        return {
          opacity: parseFloat(getComputedStyle(header).opacity),
          height: header.getBoundingClientRect().height,
        };
      },
      { collapsePx },
    );

    expect(measured.opacity).toBeLessThanOrEqual(0.01);
    // Only the inset + row gap padding remains; the row's own height is
    // fully reclaimed.
    expect(measured.height).toBeLessThan(rowHeight);
  });
});
