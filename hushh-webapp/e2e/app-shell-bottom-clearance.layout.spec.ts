import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";

/**
 * A route may reserve the bottom chrome ONCE.
 *
 * `app/providers.tsx` gives the scroll root `padding-bottom:
 * var(--app-scroll-bottom-pad)`, which resolves to the measured height of the
 * fixed bottom stack (the "Talk to One" bar plus the tab bar plus the home
 * indicator). Its own comment says why: "The scroll root owns the clearance for
 * that fixed chrome so feature routes do not need to guess at device safe areas
 * or bar geometry."
 *
 * `.app-page-shell` then guessed at it anyway, with
 * `padding-bottom: var(--app-bottom-content-clearance)` — which is that same
 * measured stack height PLUS 24px. Every page carrying the shell therefore
 * reserved the bottom bars twice: ~190px of empty scroll under the last card at
 * 390px, and the reason a short page scrolled at all. That extra scroll length
 * is also how content ended up under the top bar on screens with nothing to
 * scroll: there was a viewport of manufactured travel below them.
 *
 * This measures the dead space under the last element of a SHORT page and holds
 * it to one chrome height plus a reading gap.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE through desktop. iOS is where the users are; the founder's
 *  report came from both a phone and a 1440 browser. */
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1440] as const;

/** The gap the page itself is allowed to add under its last row. */
const CONTENT_BOTTOM_GAP_PX = 24;

/**
 * Slack over `chrome + gap`. Sub-pixel line boxes only — NOT room for a second
 * bar. A regression that re-adds the chrome height lands ~82px over this.
 */
const SLACK_PX = 8;

/** What `AppBottomShell` publishes once it has measured itself: the Talk-to-One
 *  bar and the tab bar. Realistic, and the exact number does not matter — the
 *  budget is expressed in terms of it. */
const BOTTOM_SHELL_HEIGHT_PX = 132;

/**
 * Taller than the 844px viewport on purpose. A short page cannot show this
 * defect: its dead space is unused viewport, which is not a bug and not
 * something padding can fix. The void the founder photographed was under a page
 * that DID scroll, and only a scrolling page makes the reserved space visible.
 */
const ROUTE_BODY_HEIGHT_PX = 1400;

async function buildStylesheet(candidates: string[]): Promise<string> {
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

  // The app's own @font-face rules cannot load over file:// and, sharing a
  // family name with the working one, stop it satisfying fonts.check.
  return stripAppFontFaces(compiler.build(candidates));
}

function inlineStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .map(([name, value]) => `${name}: ${String(value)};`)
    .join(" ");
}

/**
 * The signed-in shell as `app/providers.tsx` builds it for a standard route:
 * a scrolling root that owns the bottom clearance, a spacer that clears the top
 * bar, and the page's own `.app-page-shell` inside it.
 */
function shellMarkup(navigationHidden = false): string {
  const offset = resolveSignedInShellContentOffset({
    shellVisible: true,
    routeLayoutMode: "standard",
    localOffset: "0px",
  });

  const shellStyle = inlineStyle({
    ...offset.style,
    ...resolveTopShellGeometryStyle({ hasTabs: false }),
    // Published by AppBottomShell after it measures itself. Declared here for
    // the same reason the top geometry is: a `:root` fallback resolves to a
    // different, much smaller number and a real bug would pass.
    "--app-bottom-shell-height": `${BOTTOM_SHELL_HEIGHT_PX}px`,
    // The standard signed-in branch of providers.tsx: neither hidden chrome nor
    // an RIA/setup surface.
    "--bottom-chrome-stack-height": navigationHidden
      ? "var(--app-bottom-shell-height, calc(var(--onboarding-agent-bar-clearance) + 1.5rem))"
      : "var(--app-bottom-shell-height)",
    "--app-scroll-bottom-pad": "var(--bottom-chrome-stack-height)",
  });

  return `<div data-app-shell-root="true" style="${shellStyle}; position: fixed; inset: 0; display: flex; flex-direction: column;">
      <div
        data-app-scroll-root="true"
        style="flex: 1 1 0%; min-height: 0; overflow-y: auto; padding-bottom: var(--app-scroll-bottom-pad);"
      >
        <div data-app-shell-top-spacer="true" aria-hidden></div>
        <div data-app-shell-content="true" style="min-height: 0;">
          <main class="app-page-shell" data-app-shell-width="standard">
            <div data-route-body style="height: ${ROUTE_BODY_HEIGHT_PX}px; background: #ddd;">
              The last card on a short page
            </div>
          </main>
        </div>
      </div>
      <div
        data-bottom-chrome
        data-navigation-hidden="${navigationHidden || ""}"
        style="position: fixed; inset-inline: 0; bottom: 0; height: var(--bottom-chrome-stack-height);"
      ></div>
    </div>`;
}

async function writeFixture(navigationHidden = false): Promise<string> {
  const css = await buildStylesheet(["app-page-shell"]);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "app-shell-bottom-clearance-"),
  );
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  html { --top-chrome-collapse-px: 0px; }
  body { margin: 0; }
</style></head>
<body data-ambient-chrome-primed="true">${shellMarkup(navigationHidden)}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("app shell bottom clearance", () => {
  for (const width of WIDTHS) {
    test(`a short page reserves the bottom chrome once at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const scrollRoot = document.querySelector<HTMLElement>(
          "[data-app-scroll-root]",
        )!;
        const shell = document.querySelector<HTMLElement>(".app-page-shell")!;
        const body = document.querySelector<HTMLElement>("[data-route-body]")!;
        const chrome = document.querySelector<HTMLElement>(
          "[data-bottom-chrome]",
        )!;
        // Scrolled to the end, which is where a void under the last card is
        // actually seen. `scrollHeight - (scrollTop + clientHeight)` is 0 here,
        // so the last card's distance from the viewport bottom IS the reserve.
        scrollRoot.scrollTop = scrollRoot.scrollHeight;
        return {
          bodyBottomToViewport: +(
            scrollRoot.getBoundingClientRect().bottom -
            body.getBoundingClientRect().bottom
          ).toFixed(2),
          shellPad: Number.parseFloat(
            getComputedStyle(shell).paddingBottom || "0",
          ),
          rootPad: Number.parseFloat(
            getComputedStyle(scrollRoot).paddingBottom || "0",
          ),
          chromeHeight: +chrome.getBoundingClientRect().height.toFixed(2),
          scrollable: scrollRoot.scrollHeight > scrollRoot.clientHeight,
        };
      });

      const budget = measured.chromeHeight + CONTENT_BOTTOM_GAP_PX + SLACK_PX;

      // A fixture that stopped scrolling would pass every assertion below by
      // measuring nothing.
      expect(measured.scrollable, "fixture page must scroll").toBe(true);

      expect(
        measured.shellPad + measured.rootPad,
        `the page reserves ${measured.shellPad}px and the scroll root reserves ${measured.rootPad}px under a ${measured.chromeHeight}px bottom chrome at ${width}px — it is counted more than once`,
      ).toBeLessThanOrEqual(budget);

      expect(
        measured.bodyBottomToViewport,
        `${measured.bodyBottomToViewport}px of empty screen under the last card at ${width}px, against a ${measured.chromeHeight}px bottom chrome`,
      ).toBeLessThanOrEqual(budget);
    });
  }

  for (const width of WIDTHS.filter((candidate) => candidate <= 430)) {
    test(`an Agent-Bar-only flow stays clear at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture(true));

      const measured = await page.evaluate(() => {
        const scrollRoot = document.querySelector<HTMLElement>(
          "[data-app-scroll-root]",
        )!;
        const body = document.querySelector<HTMLElement>("[data-route-body]")!;
        const chrome = document.querySelector<HTMLElement>(
          "[data-bottom-chrome]",
        )!;
        scrollRoot.scrollTop = scrollRoot.scrollHeight;
        return {
          bodyBottom: body.getBoundingClientRect().bottom,
          chromeTop: chrome.getBoundingClientRect().top,
          rootPad: Number.parseFloat(
            getComputedStyle(scrollRoot).paddingBottom || "0",
          ),
          chromeHeight: chrome.getBoundingClientRect().height,
        };
      });

      expect(measured.rootPad).toBeGreaterThanOrEqual(measured.chromeHeight);
      expect(
        measured.bodyBottom,
        "the last action must finish above the fixed Agent Bar",
      ).toBeLessThanOrEqual(measured.chromeTop);
    });
  }
});
