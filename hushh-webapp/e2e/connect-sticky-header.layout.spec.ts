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
 * Connect owns an in-page segmented control, but it visually joins the fixed
 * app bar once pinned. The tab surface starts at the top mask's solid edge so
 * the mask can dissolve over the tabs themselves. There is therefore no empty
 * fade-tail band for list content to cross and no observer-timed cover.
 *
 * Run with: npm run test:layout-contracts
 */
const WIDTHS = [320, 360, 393, 600, 1440] as const;
const SLACK_PX = 2;
const PAGE_HEADER_HEIGHT_PX = 34;
const SURFACE_STRIP_HEIGHT_PX = 38;

function connectClassName(name: string): string {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/connect/page-client.tsx"),
    "utf8",
  );
  const match = source.match(new RegExp(`const ${name} =\\s*("[^"]+");`));
  if (!match) throw new Error(`Missing Connect layout constant: ${name}`);
  return JSON.parse(match[1]) as string;
}

const STICKY_HEADER_CLASSNAME = connectClassName(
  "CONNECT_STICKY_HEADER_CLASSNAME",
);
const STICKY_SEARCH_CLASSNAME = connectClassName(
  "CONNECT_STICKY_SEARCH_CLASSNAME",
);

async function buildStylesheet(candidates: string[]): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    pathToFileURL(
      path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs"),
    ).href
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (values: string[]) => string }>;
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
    <div data-app-top-bar style="position:fixed;inset-inline:0;top:0;z-index:50;height:var(--top-shell-live-height);">
      <div data-app-top-bar-solid style="height:var(--top-shell-mask-solid-height);background:#f5f5f7;"></div>
    </div>
    <div data-app-scroll-root="true" style="position:fixed;inset:0;overflow-y:auto;">
      <div data-app-shell-top-spacer="true" aria-hidden></div>
      <main class="app-page-shell ${APP_SHELL_FRAME_CLASSNAME} ${APP_SHELL_MAX_WIDTHS.agent}" data-app-density="compact" data-app-shell-width="agent">
        <div class="app-page-header-region w-full min-w-0">
          <div data-page-header style="height:${PAGE_HEADER_HEIGHT_PX}px;background:#c8c8d0;">Connect</div>
        </div>
        <div data-connect-content class="app-page-content-region w-full ${CONNECT_PAGE_CONTENT_CLASSNAME}">
          <div class="surface-stack surface-stack-compact">
            <div data-connect-stack class="relative space-y-3 sm:space-y-4">
              <div data-testid="connect-sticky-header" class="${STICKY_HEADER_CLASSNAME}">
                <div data-strip style="height:${SURFACE_STRIP_HEIGHT_PX}px;background:#e8e8ed;">Connections / Circles</div>
              </div>
              <div data-my-connections style="height:900px;background:#dddde2;">
                <div data-person-row class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5">
                  <div class="min-w-0">
                    <span data-person-title class="${CONNECT_WRAPPING_TEXT_CLASSNAME}">24E2100221 Mayank Featherstonehaugh-Rajendran</span>
                    <span data-person-description class="${CONNECT_WRAPPING_TEXT_CLASSNAME}">m***k@extraordinarily-long-university-domain.example</span>
                  </div>
                  <button data-person-action class="h-8 min-h-8 shrink-0 rounded-2xl px-2.5">Connect</button>
                </div>
              </div>
              <div data-testid="connect-search-row" class="${STICKY_SEARCH_CLASSNAME}">
                <div style="height:44px;background:#cfe0f5;">Search people</div>
              </div>
              <div data-directory style="height:1600px;background:#d5d5dd;">Directory results</div>
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
    "app-page-header-region",
    "surface-stack",
    "surface-stack-compact",
    "relative",
    "space-y-3",
    "sm:space-y-4",
    ...CONNECT_PAGE_CONTENT_CLASSNAME.split(" "),
    ...CONNECT_WRAPPING_TEXT_CLASSNAME.split(" "),
    "grid",
    "grid-cols-[minmax(0,1fr)_auto]",
    "items-center",
    "gap-x-3",
    "px-4",
    "py-2.5",
    "min-w-0",
    "h-8",
    "min-h-8",
    "shrink-0",
    "rounded-2xl",
    "px-2.5",
    ...APP_SHELL_FRAME_CLASSNAME.split(" "),
    APP_SHELL_MAX_WIDTHS.agent,
    ...STICKY_HEADER_CLASSNAME.split(" "),
    ...STICKY_SEARCH_CLASSNAME.split(" "),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-sticky-header-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${productFontStyle()}body{margin:0}</style><link rel="stylesheet" href="fixture.css"></head><body data-ambient-chrome-primed="true">${shellMarkup()}<script>(function(){var header=document.querySelector('[data-testid="connect-sticky-header"]');var stack=document.querySelector('[data-connect-stack]');stack.style.setProperty('--connect-sticky-header-height',Math.ceil(header.getBoundingClientRect().height)+'px');})();</script></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

async function measureAt(page: Page, y: number) {
  return page.evaluate(async (scrollTop) => {
    const scrollRoot = document.querySelector<HTMLElement>(
      "[data-app-scroll-root]",
    )!;
    scrollRoot.scrollTop = scrollTop;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const header = document.querySelector<HTMLElement>(
      '[data-testid="connect-sticky-header"]',
    )!;
    const search = document.querySelector<HTMLElement>(
      '[data-testid="connect-search-row"]',
    )!;
    const solid = document.querySelector<HTMLElement>(
      "[data-app-top-bar-solid]",
    )!;
    const topBar = document.querySelector<HTMLElement>("[data-app-top-bar]")!;
    const pageHeader =
      document.querySelector<HTMLElement>("[data-page-header]")!;
    const shell = document.querySelector<HTMLElement>(".app-page-shell")!;
    const headerBox = header.getBoundingClientRect();
    const searchBox = search.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const alpha = (color: string) => {
      const match = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(color);
      return match ? Number.parseFloat(match[1]!) : 1;
    };
    return {
      solidBottom: solid.getBoundingClientRect().bottom,
      liveBottom: topBar.getBoundingClientRect().bottom,
      headerTop: headerBox.top,
      headerBottom: headerBox.bottom,
      headerLeft: headerBox.left,
      headerRight: headerBox.right,
      headerAlpha: alpha(getComputedStyle(header).backgroundColor),
      searchTop: searchBox.top,
      searchLeft: searchBox.left,
      searchRight: searchBox.right,
      searchAlpha: alpha(getComputedStyle(search).backgroundColor),
      pageLeft: shellBox.left,
      pageRight: shellBox.right,
      pageHeaderBottom: pageHeader.getBoundingClientRect().bottom,
      sectionGap: Number.parseFloat(
        getComputedStyle(shell).getPropertyValue("--page-header-section-gap"),
      ),
      scrollRemaining:
        scrollRoot.scrollHeight -
        (scrollRoot.scrollTop + scrollRoot.clientHeight),
    };
  }, y);
}

test.describe("connect sticky header", () => {
  for (const width of WIDTHS) {
    test(`tabs join the solid top chrome at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);
      const atRest = await measureAt(page, 0);
      const scrolled = await measureAt(page, 700);

      expect(scrolled.scrollRemaining).toBeGreaterThan(0);
      expect(
        Math.abs(scrolled.headerTop - scrolled.solidBottom),
      ).toBeLessThanOrEqual(SLACK_PX);
      expect(scrolled.headerTop).toBeLessThan(scrolled.liveBottom - SLACK_PX);
      expect(
        Math.abs(
          atRest.headerTop - atRest.pageHeaderBottom - atRest.sectionGap,
        ),
      ).toBeLessThanOrEqual(SLACK_PX);
    });

    test(`tabs and search remain opaque and gutter-wide at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);
      const scrolled = await measureAt(page, 1400);

      expect(
        Math.abs(scrolled.searchTop - scrolled.headerBottom),
      ).toBeLessThanOrEqual(SLACK_PX);
      expect(scrolled.headerAlpha).toBe(1);
      expect(scrolled.searchAlpha).toBe(1);
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

    test(`long directory identities still wrap safely at ${width}px`, async ({
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
        const metrics = [
          "[data-person-title]",
          "[data-person-description]",
        ].map((selector) => {
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
        });
        return {
          metrics,
          actionRight: action.getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
        };
      });

      for (const metric of result.metrics) {
        expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
        expect(metric.scrollHeight).toBeLessThanOrEqual(
          metric.clientHeight + 1,
        );
        expect(metric.textOverflow).not.toBe("ellipsis");
        expect(metric.whiteSpace).not.toBe("nowrap");
      }
      expect(result.actionRight).toBeLessThanOrEqual(result.rowRight + 1);
    });
  }
});
