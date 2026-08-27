import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  APP_SHELL_FRAME_CLASSNAME,
  APP_SHELL_MAX_WIDTHS,
} from "../components/app-ui/app-page-shell";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";

/**
 * Connect pins two things, at two different heights, for two different reasons.
 *
 * The tab strips pin to the top of the scroll container. They name what the
 * whole page is showing, so losing them mid-roster leaves rows with nothing
 * saying which surface or which tab they came from.
 *
 * The search row pins UNDER them, and only once its own section arrives. That
 * field searches the directory, and the directory is what sits below it —
 * `My connections` is above. Lifting it into the header would fix a control to
 * the top of a screen whose first list it does not filter.
 *
 * Both offsets are relative to `--top-shell-live-height`, not to `0`: the scroll
 * root clears the fixed top bar with a spacer rather than padding, so `top: 0`
 * sticks to the scrollport edge, which the bar overlays. The search adds the
 * header's measured height on top of that — measured, because the header is one
 * strip on Circles and two everywhere else.
 *
 * jsdom proves none of this: it applies no CSS and measures every element as
 * 0x0, so `className.toContain("sticky")` passes against a strip that never
 * pins and a search row that lands behind it.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE through the tablet width the issue asks for. */
const WIDTHS = [320, 375, 390, 430, 768] as const;

/** Sub-pixel line boxes only. A strip that does not pin drifts by hundreds. */
const SLACK_PX = 2;

/** Two strips, as every surface but Circles renders them. */
const SURFACE_STRIP_HEIGHT_PX = 38;
const TAB_STRIP_HEIGHT_PX = 38;

const STICKY_HEADER_CLASSNAME =
  "sticky top-[var(--top-shell-live-height,0px)] z-20 mx-[calc(var(--page-inline-gutter-standard)*-1)] space-y-3 bg-background/85 px-[var(--page-inline-gutter-standard)] pb-3 pt-2 backdrop-blur-md sm:space-y-4";

const STICKY_SEARCH_CLASSNAME =
  "sticky top-[calc(var(--top-shell-live-height,0px)+var(--connect-sticky-header-height,0px))] z-10 mx-[calc(var(--page-inline-gutter-standard)*-1)] bg-background/85 px-[var(--page-inline-gutter-standard)] py-2 backdrop-blur-md";

async function buildStylesheet(candidates: string[]): Promise<string> {
  const webappRoot = process.cwd();
  // `pathToFileURL`, not a bare path: the ESM loader rejects a Windows absolute
  // path as an unknown "c:" scheme, and this suite runs locally as well as in
  // CI.
  const { compile } = (await import(
    pathToFileURL(
      path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs"),
    ).href
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

  return stripAppFontFaces(compiler.build(candidates));
}

function inlineStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .map(([name, value]) => `${name}: ${String(value)};`)
    .join(" ");
}

/**
 * The signed-in shell as `app/providers.tsx` builds it for a standard route,
 * with Connect's stack inside it.
 *
 * The derived top geometry is re-declared through `resolveTopShellGeometryStyle`
 * rather than hand-copied: a `:root` definition of the mask resolves against
 * root's own 8px fade instead of the shell's 22px, which shortens the header by
 * 14px and lets a real pinning bug pass.
 *
 * The ancestor chain is the real one, down to `.surface-stack`, and that is not
 * decoration. `position: sticky` dies silently under an `overflow` ancestor, and
 * `.surface-stack` is a flex column that bleeds itself by `--page-surface-overscan`
 * and pads the same amount back. A fixture that skips it would prove the header
 * pins somewhere the header never renders.
 */
function shellMarkup(): string {
  const offset = resolveSignedInShellContentOffset({
    shellVisible: true,
    routeLayoutMode: "standard",
    localOffset: "0px",
  });

  const shellStyle = inlineStyle({
    ...offset.style,
    ...resolveTopShellGeometryStyle({ hasTabs: false }),
  });

  return `<div data-app-shell-root="true" style="${shellStyle}">
      <div
        data-app-top-bar
        style="position: fixed; inset-inline: 0; top: 0; z-index: 50; height: var(--top-shell-live-height); background: rgba(0,0,0,0.06);"
      ></div>
      <div
        data-app-scroll-root="true"
        style="position: fixed; inset: 0; overflow-y: auto;"
      >
        <div data-app-shell-top-spacer="true" aria-hidden></div>
        <main
          class="app-page-shell ${APP_SHELL_FRAME_CLASSNAME} ${APP_SHELL_MAX_WIDTHS.standard}"
          data-app-density="compact"
          data-app-shell-width="standard"
          data-top-content-anchor="true"
        >
          <div class="app-page-content-region w-full min-w-0">
            <div class="surface-stack surface-stack-compact">
              <div data-connect-stack class="space-y-4 sm:space-y-5">
                <div data-testid="connect-sticky-header" class="${STICKY_HEADER_CLASSNAME}">
                  <div data-strip="surface" style="height: ${SURFACE_STRIP_HEIGHT_PX}px; background: #e8e8ed;">People / Circles</div>
                  <div data-strip="tab" style="height: ${TAB_STRIP_HEIGHT_PX}px; background: #e8e8ed;">People / RIAs / Around you</div>
                </div>
                <div data-my-connections style="height: 900px; background: #dddde2;">My connections</div>
                <div data-testid="connect-search-row" class="${STICKY_SEARCH_CLASSNAME} flex items-center gap-2">
                  <div style="height: 44px; flex: 1 1 0%; background: #cfe0f5;">Search people</div>
                </div>
                <div data-directory style="height: 1600px; background: #d5d5dd;">Directory results</div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>`;
}

async function writeFixture(): Promise<string> {
  const css = await buildStylesheet([
    "app-page-shell",
    "app-page-content-region",
    "surface-stack",
    "surface-stack-compact",
    "space-y-4",
    "sm:space-y-5",
    "min-w-0",
    "flex",
    "items-center",
    "gap-2",
    ...APP_SHELL_FRAME_CLASSNAME.split(" "),
    APP_SHELL_MAX_WIDTHS.standard,
    ...STICKY_HEADER_CLASSNAME.split(" "),
    ...STICKY_SEARCH_CLASSNAME.split(" "),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-sticky-header-"));
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
<body data-ambient-chrome-primed="true">${shellMarkup()}
<script>
  /* The same measurement the page runs, so the offset the search row resolves
     is the one the component would give it rather than a number this fixture
     chose. A wrong calc() fails here exactly as it would in the app. */
  (function () {
    var header = document.querySelector('[data-testid="connect-sticky-header"]');
    var stack = document.querySelector("[data-connect-stack]");
    stack.style.setProperty(
      "--connect-sticky-header-height",
      Math.ceil(header.getBoundingClientRect().height) + "px",
    );
  })();
</script>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/** Scroll the app root by `y` and read back what is pinned where. */
async function measureAt(page: Page, y: number) {
  return page.evaluate((scrollTop) => {
    const scrollRoot = document.querySelector<HTMLElement>(
      "[data-app-scroll-root]",
    )!;
    scrollRoot.scrollTop = scrollTop;
    // Measured off the rendered bar, not read back from the custom property:
    // `getPropertyValue` hands back the unresolved `calc(...)` string, which is
    // NaN to `parseFloat` and would quietly pass every comparison below.
    const topBar = document.querySelector<HTMLElement>("[data-app-top-bar]")!;
    const header = document.querySelector<HTMLElement>(
      '[data-testid="connect-sticky-header"]',
    )!;
    const search = document.querySelector<HTMLElement>(
      '[data-testid="connect-search-row"]',
    )!;
    const directory = document.querySelector<HTMLElement>("[data-directory]")!;
    const shell = document.querySelector<HTMLElement>(".app-page-shell")!;
    const shellBox = shell.getBoundingClientRect();
    const liveHeight = +topBar.getBoundingClientRect().height.toFixed(2);
    const headerBox = header.getBoundingClientRect();
    const searchBox = search.getBoundingClientRect();
    return {
      liveHeight,
      headerTop: +headerBox.top.toFixed(2),
      headerBottom: +headerBox.bottom.toFixed(2),
      searchTop: +searchBox.top.toFixed(2),
      searchBottom: +searchBox.bottom.toFixed(2),
      headerLeft: +headerBox.left.toFixed(2),
      headerRight: +headerBox.right.toFixed(2),
      searchLeft: +searchBox.left.toFixed(2),
      searchRight: +searchBox.right.toFixed(2),
      pageLeft: +shellBox.left.toFixed(2),
      pageRight: +shellBox.right.toFixed(2),
      directoryTop: +directory.getBoundingClientRect().top.toFixed(2),
      // The page still has somewhere to go, or nothing here is pinned — it has
      // simply run out of scroll and everything is sitting where it started.
      scrollRemaining: +(
        scrollRoot.scrollHeight -
        (scrollRoot.scrollTop + scrollRoot.clientHeight)
      ).toFixed(2),
    };
  }, y);
}

test.describe("connect sticky header", () => {
  for (const width of WIDTHS) {
    test(`the tab strips pin under the top bar at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const atRest = await measureAt(page, 0);
      // Deep enough that the strips' own position is far above the viewport:
      // whatever is on screen is pinned, not merely not-yet-scrolled.
      const scrolled = await measureAt(page, 700);

      expect(scrolled.scrollRemaining).toBeGreaterThan(0);
      expect(scrolled.headerTop).toBeLessThan(atRest.headerTop);
      expect(
        Math.abs(scrolled.headerTop - scrolled.liveHeight),
      ).toBeLessThanOrEqual(SLACK_PX);
    });

    test(`the search row pins under the strips, not behind them, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      // Past the search row's own resting place, into the directory it filters.
      const scrolled = await measureAt(page, 1400);

      expect(scrolled.scrollRemaining).toBeGreaterThan(0);
      // Under the strips, never overlapping them.
      expect(scrolled.searchTop).toBeGreaterThanOrEqual(
        scrolled.headerBottom - SLACK_PX,
      );
      expect(
        Math.abs(scrolled.searchTop - scrolled.headerBottom),
      ).toBeLessThanOrEqual(SLACK_PX);
      // And still on screen while its own results scroll under it.
      expect(scrolled.searchBottom).toBeLessThan(844);
      expect(scrolled.directoryTop).toBeLessThan(scrolled.searchBottom);
    });

    test(`both pinned bands reach the page gutters at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const scrolled = await measureAt(page, 1400);

      // A pinned band that stops at the text column leaves a gutter's worth of
      // rows sliding past in plain sight on either side of it -- 16px at phone
      // widths, 24px at tablet. The negative inline margin is what closes that,
      // and it has to survive `.surface-stack`'s own overscan.
      expect(
        Math.abs(scrolled.headerLeft - scrolled.pageLeft),
      ).toBeLessThanOrEqual(SLACK_PX);
      expect(
        Math.abs(scrolled.headerRight - scrolled.pageRight),
      ).toBeLessThanOrEqual(SLACK_PX);
      expect(
        Math.abs(scrolled.searchLeft - scrolled.pageLeft),
      ).toBeLessThanOrEqual(SLACK_PX);
      expect(
        Math.abs(scrolled.searchRight - scrolled.pageRight),
      ).toBeLessThanOrEqual(SLACK_PX);
    });

    test(`the search row stays out of the way before its section arrives at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      // At rest the search row sits below 900px of connections, so it is off
      // screen. A row pinned from the start would be sitting in the header.
      const atRest = await measureAt(page, 0);

      expect(atRest.searchTop).toBeGreaterThan(atRest.headerBottom);
      expect(atRest.searchTop).toBeGreaterThan(844);
    });
  }
});
