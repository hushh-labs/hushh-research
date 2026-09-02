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
import {
  CONNECT_PAGE_CONTENT_CLASSNAME,
  CONNECT_WRAPPING_TEXT_CLASSNAME,
} from "../app/connect/connect-surface-layout";

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
 * `--top-shell-live-height` is the mask's LAST VISIBLE pixel, not its solid
 * edge, so pinning there leaves the `--top-fade-active` band above the strips
 * showing whatever is behind it — and what is behind it is the roster. The
 * header covers that band with its own material while it is pinned, and only
 * while it is pinned: at rest the same band is the gap under the page title.
 * Both halves are measured below, because a cover that is always on and a cover
 * that is never on each pass exactly one of them.
 *
 * jsdom proves none of this: it applies no CSS and measures every element as
 * 0x0, so `className.toContain("sticky")` passes against a strip that never
 * pins and a search row that lands behind it.
 *
 * Run with: npm run test:layout-contracts
 */

/** Narrow-phone boundary, the reported phone sizes, tablet, and desktop. */
const WIDTHS = [320, 360, 393, 600, 1440] as const;

/** Sub-pixel line boxes only. A strip that does not pin drifts by hundreds. */
const SLACK_PX = 2;

/** Two strips, as every surface but Circles renders them. */
const SURFACE_STRIP_HEIGHT_PX = 38;
const TAB_STRIP_HEIGHT_PX = 38;

const STICKY_HEADER_CLASSNAME =
  "sticky top-[var(--top-shell-live-height,0px)] z-20 mx-[calc(var(--page-inline-gutter-standard)*-1)] space-y-3 bg-background px-[var(--page-inline-gutter-standard)] pb-3 pt-2 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:bg-background data-[pinned=true]:before:h-[calc(var(--top-fade-active,0px)+1px)] sm:space-y-4";

const STICKY_SEARCH_CLASSNAME =
  "sticky top-[calc(var(--top-shell-live-height,0px)+var(--connect-sticky-header-height,0px))] z-10 mx-[calc(var(--page-inline-gutter-standard)*-1)] bg-background px-[var(--page-inline-gutter-standard)] py-2";

/** The page title Connect renders above the strips, and its gap to them. */
const PAGE_HEADER_HEIGHT_PX = 34;

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
      >
        <!-- The mask paints solid to here and then dissolves over
             --top-fade-active to nothing. Modelled, not decorative: the band
             between this edge and the bar's full height is the one the roster
             was crossing in plain sight, and a bar drawn as one opaque block
             cannot show it. -->
        <div
          data-app-top-bar-solid
          style="height: var(--top-shell-mask-solid-height);"
        ></div>
      </div>
      <div
        data-app-scroll-root="true"
        style="position: fixed; inset: 0; overflow-y: auto;"
      >
        <div data-app-shell-top-spacer="true" aria-hidden></div>
        <main
          class="app-page-shell ${APP_SHELL_FRAME_CLASSNAME} ${APP_SHELL_MAX_WIDTHS.agent}"
          data-app-density="compact"
          data-app-shell-width="agent"
          data-top-content-anchor="true"
        >
          <!-- Connect renders a page title above the strips, and at compact
               density the page-header section gap leaves only 10px between the
               two. That gap is what makes the cover conditional, so the fixture
               has to contain the thing it must not cover. -->
          <div class="app-page-header-region w-full min-w-0">
            <div data-page-header style="height: ${PAGE_HEADER_HEIGHT_PX}px; background: #c8c8d0;">Connect</div>
          </div>
          <div data-connect-content class="app-page-content-region w-full ${CONNECT_PAGE_CONTENT_CLASSNAME}">
            <div class="surface-stack surface-stack-compact">
              <div data-connect-stack class="relative space-y-4 sm:space-y-5">
                <div data-testid="connect-sticky-pin-sentinel" aria-hidden class="pointer-events-none absolute inset-x-0 top-0 h-px"></div>
                <div data-testid="connect-sticky-header" data-pinned="false" class="${STICKY_HEADER_CLASSNAME}">
                  <div data-strip="surface" style="height: ${SURFACE_STRIP_HEIGHT_PX}px; background: #e8e8ed;">People / Circles</div>
                  <div data-strip="tab" style="height: ${TAB_STRIP_HEIGHT_PX}px; background: #e8e8ed;">People / RIAs / Around you</div>
                </div>
                <div data-my-connections style="height: 900px; background: #dddde2;">
                  <div data-person-row class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5">
                    <div class="min-w-0">
                      <span data-person-title class="${CONNECT_WRAPPING_TEXT_CLASSNAME}">24E2100221 Mayank Featherstonehaugh-Rajendran</span>
                      <span data-person-description class="${CONNECT_WRAPPING_TEXT_CLASSNAME}">m***k@extraordinarily-long-university-domain.example</span>
                    </div>
                    <button data-person-action class="h-8 min-h-8 shrink-0 rounded-2xl px-2.5">Connect</button>
                  </div>
                </div>
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
    ...CONNECT_PAGE_CONTENT_CLASSNAME.split(" "),
    ...CONNECT_WRAPPING_TEXT_CLASSNAME.split(" "),
    "flex",
    "items-center",
    "gap-2",
    "grid",
    "grid-cols-[minmax(0,1fr)_auto]",
    "gap-x-3",
    "px-4",
    "py-2.5",
    "h-8",
    "min-h-8",
    "shrink-0",
    "rounded-2xl",
    "px-2.5",
    "relative",
    "pointer-events-none",
    "absolute",
    "inset-x-0",
    "top-0",
    "h-px",
    ...APP_SHELL_FRAME_CLASSNAME.split(" "),
    APP_SHELL_MAX_WIDTHS.agent,
    ...STICKY_HEADER_CLASSNAME.split(" "),
    ...STICKY_SEARCH_CLASSNAME.split(" "),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-sticky-header-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  /* The pinned-state observer, again as the component runs it. Hard-coding
     data-pinned here would test a cover this fixture switched on by hand; the
     question is whether the component's own rootMargin puts the switch at the
     pin boundary. */
  (function () {
    var header = document.querySelector('[data-testid="connect-sticky-header"]');
    var sentinel = document.querySelector(
      '[data-testid="connect-sticky-pin-sentinel"]',
    );
    var scrollRoot = document.querySelector('[data-app-scroll-root="true"]');
    var pinnedAt = Math.max(
      0,
      Math.round(parseFloat(getComputedStyle(header).top) || 0),
    );
    new IntersectionObserver(
      function (entries) {
        var entry = entries[entries.length - 1];
        if (!entry) return;
        header.dataset.pinned = entry.isIntersecting ? "false" : "true";
      },
      { root: scrollRoot, rootMargin: "-" + pinnedAt + "px 0px 0px 0px" },
    ).observe(sentinel);
  })();
</script>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/** Scroll the app root by `y` and read back what is pinned where. */
async function measureAt(page: Page, y: number) {
  return page.evaluate(async (scrollTop) => {
    const scrollRoot = document.querySelector<HTMLElement>(
      "[data-app-scroll-root]",
    )!;
    scrollRoot.scrollTop = scrollTop;
    // Measured off the rendered bar, not read back from the custom property:
    // `getPropertyValue` hands back the unresolved `calc(...)` string, which is
    // NaN to `parseFloat` and would quietly pass every comparison below.
    const topBar = document.querySelector<HTMLElement>("[data-app-top-bar]")!;
    const solid = document.querySelector<HTMLElement>(
      "[data-app-top-bar-solid]",
    )!;
    const header = document.querySelector<HTMLElement>(
      '[data-testid="connect-sticky-header"]',
    )!;
    const sentinel = document.querySelector<HTMLElement>(
      '[data-testid="connect-sticky-pin-sentinel"]',
    )!;
    const search = document.querySelector<HTMLElement>(
      '[data-testid="connect-search-row"]',
    )!;
    const directory = document.querySelector<HTMLElement>("[data-directory]")!;
    const pageHeader = document.querySelector<HTMLElement>("[data-page-header]")!;
    const stack = document.querySelector<HTMLElement>("[data-connect-stack]")!;
    const shell = document.querySelector<HTMLElement>(".app-page-shell")!;
    const content = document.querySelector<HTMLElement>(
      "[data-connect-content]",
    )!;
    // The observer answers a frame or two after the scroll, so waiting a fixed
    // number of frames would be a race dressed as a constant. Wait for it to
    // AGREE with the geometry instead: pinned is exactly "the header is no
    // longer where the sentinel is". If the observer never fires, this times
    // out and every assertion below fails, which is the correct outcome.
    const settled = await new Promise<boolean>((resolve) => {
      let framesLeft = 60;
      const check = () => {
        const truth =
          header.getBoundingClientRect().top -
            sentinel.getBoundingClientRect().top >
          0.5;
        if ((header.dataset.pinned === "true") === truth) return resolve(true);
        if (framesLeft-- <= 0) return resolve(false);
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    /** The alpha term of a computed colour, in any of its serialisations. */
    const alphaOf = (colour: string): number => {
      const slashForm = /\/\s*([\d.]+%?)\s*\)/.exec(colour);
      const legacyForm = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(colour);
      const raw = slashForm?.[1] ?? legacyForm?.[1];
      if (raw === undefined) return 1;
      return raw.endsWith("%")
        ? Number.parseFloat(raw) / 100
        : Number.parseFloat(raw);
    };
    const shellBox = shell.getBoundingClientRect();
    const liveHeight = +topBar.getBoundingClientRect().height.toFixed(2);
    const headerBox = header.getBoundingClientRect();
    const searchBox = search.getBoundingClientRect();
    return {
      settled,
      pinned: header.dataset.pinned === "true",
      solidHeight: +solid.getBoundingClientRect().height.toFixed(2),
      // The band the header continues its own material into. Read off the
      // rendered pseudo-element, so a cover that resolved to `auto` — which is
      // what an unset `--top-fade-active` would give — reads as the 0 it is.
      coverHeight: +(
        Number.parseFloat(getComputedStyle(header, "::before").height) || 0
      ).toFixed(2),
      // Alpha, not the colour string. A computed background serialises as
      // `rgb()`, `rgba()`, `oklab(… / a)` or `color(srgb … / a)` depending on
      // the browser and on how the token was authored, and only one of those
      // shapes was ever going to be the one this suite guessed.
      headerAlpha: alphaOf(getComputedStyle(header).backgroundColor),
      coverAlpha: alphaOf(getComputedStyle(header, "::before").backgroundColor),
      searchAlpha: alphaOf(getComputedStyle(search).backgroundColor),
      stackTop: +stack.getBoundingClientRect().top.toFixed(2),
      pageHeaderBottom: +pageHeader.getBoundingClientRect().bottom.toFixed(2),
      sectionGap: Number.parseFloat(
        getComputedStyle(shell).getPropertyValue("--page-header-section-gap"),
      ),
      contentOverflowY: getComputedStyle(content).overflowY,
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
      expect(atRest.contentOverflowY).toBe("visible");
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

    test(`the strips cover the top mask's fade tail while pinned at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const scrolled = await measureAt(page, 700);

      expect(scrolled.settled).toBe(true);
      expect(scrolled.pinned).toBe(true);
      // The band exists in the first place. A fixture whose bar was one opaque
      // block would report 0 here and then pass everything below vacuously.
      const tail = scrolled.liveHeight - scrolled.solidHeight;
      expect(tail).toBeGreaterThan(0);
      // And the header's own material reaches back across it, up to the mask's
      // solid edge. Anything short of that is roster showing between the bar
      // and the strips, which is the whole report.
      expect(scrolled.coverHeight).toBeGreaterThanOrEqual(tail);
      expect(scrolled.headerTop - scrolled.coverHeight).toBeLessThanOrEqual(
        scrolled.solidHeight + SLACK_PX,
      );
    });

    test(`both pinned bands are opaque at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const scrolled = await measureAt(page, 1400);

      // Geometry alone does not settle this: a band in exactly the right place
      // at 85% still shows the names scrolling under it.
      expect(scrolled.headerAlpha).toBe(1);
      expect(scrolled.coverAlpha).toBe(1);
      expect(scrolled.searchAlpha).toBe(1);
    });

    test(`the cover keeps off the page title at rest at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const atRest = await measureAt(page, 0);

      expect(atRest.settled).toBe(true);
      expect(atRest.pinned).toBe(false);
      // Unpinned, the cover measures nothing at all, so the 10px that
      // `--page-header-section-gap` leaves under "Connect" at compact density is
      // not something it can take a bite out of.
      expect(atRest.coverHeight).toBe(0);
      expect(
        Math.abs(
          atRest.headerTop - atRest.pageHeaderBottom - atRest.sectionGap,
        ),
      ).toBeLessThanOrEqual(SLACK_PX);
      expect(atRest.headerTop - atRest.coverHeight).toBeGreaterThanOrEqual(
        atRest.pageHeaderBottom - SLACK_PX,
      );
      // And the out-of-flow sentinel left the strips where they were: it is the
      // first child of a `space-y-*` stack, which would otherwise be a 16px
      // shove down the page.
      expect(Math.abs(atRest.headerTop - atRest.stackTop)).toBeLessThanOrEqual(
        SLACK_PX,
      );
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

    test(`long Connect identities wrap without clipping at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const result = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>("[data-person-row]")!;
        const action = document.querySelector<HTMLElement>(
          "[data-person-action]",
        )!;
        const metrics = ["[data-person-title]", "[data-person-description]"].map(
          (selector) => {
            const node = document.querySelector<HTMLElement>(selector)!;
            const style = getComputedStyle(node);
            return {
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight,
              textOverflow: style.textOverflow,
              whiteSpace: style.whiteSpace,
            };
          },
        );
        return {
          metrics,
          actionRight: action.getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
        };
      });

      for (const metric of result.metrics) {
        expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
        expect(metric.scrollHeight).toBeLessThanOrEqual(metric.clientHeight + 1);
        expect(metric.textOverflow).not.toBe("ellipsis");
        expect(metric.whiteSpace).not.toBe("nowrap");
      }
      expect(result.actionRight).toBeLessThanOrEqual(result.rowRight + 1);
    });
  }
});
