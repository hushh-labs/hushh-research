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
 * The shared top-bar breadcrumb trail (`TopShellBreadcrumbTrail` in
 * `components/app-ui/top-app-bar.tsx`) used to give every ancestor crumb
 * `min-w-0 shrink truncate max-w-[9rem]` with no floor, so a plain short word
 * — "Location", "Profile", "Security" — could be crushed to one or two
 * characters under real width pressure even though it would trivially fit:
 * `Profile > Security > Lock methods` rendered as `P... > S. > Lock methods`,
 * and `Location > Share location` rendered as `Locati... > Share location`.
 *
 * The fix is two parts:
 *   1. The visible trail never shows more than the immediate parent + the
 *      current page (`breadcrumbTrailItems` in top-app-bar.tsx drops the
 *      earliest ancestor of a deeper chain rather than truncating everyone —
 *      pinned by the source-string assertion in top-app-bar.contract.test.ts,
 *      since it is control flow, not a CSS property Playwright can measure).
 *   2. The remaining ancestor crumb drops the `min-w-0`/`max-w-[9rem]` pair
 *      and instead sets `min-w-min` (`min-width: min-content`) explicitly —
 *      a plain element gets that floor for free, but a `<button>` does not
 *      (a form-control sizing quirk this file's adversarial test caught: a
 *      button-based crumb with no `min-w-0` still shrank past its own text
 *      width until `min-w-min` was added), so it can still shrink under
 *      genuine width pressure but never below its own unbreakable text.
 *
 * jsdom cannot prove pixel truncation, so this compiles the real
 * `app/globals.css` and mounts real markup (structure and class strings
 * copied from `components/app-ui/top-app-bar.tsx` — keep them in sync if
 * that component's breadcrumb row changes), then measures in a real engine.
 *
 * Run with: npm run test:layout-contracts
 */

const PHONES = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 14", width: 390, height: 844 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932 },
] as const;

/** Sub-pixel slack only. Not room for a hidden character. */
const SLACK_PX = 1;

const SCENARIOS = [
  {
    name: "Profile > Security > Lock methods",
    ancestor: "Security",
    current: "Lock methods",
  },
  {
    name: "Location > Share location",
    ancestor: "Location",
    current: "Share location",
  },
  {
    name: "Location > Shared with me",
    ancestor: "Location",
    current: "Shared with me",
  },
] as const;

/** The exact ancestor-crumb classNames as shipped in top-app-bar.tsx today. */
const ANCESTOR_CRUMB_CLASS =
  "min-w-min shrink truncate text-[color:var(--app-secondary-label)] transition-colors hover:text-current";

async function buildStylesheet(): Promise<string> {
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

  return stripAppFontFaces(
    compiler.build([
      "mx-auto",
      "w-full",
      "flex",
      "h-full",
      "w-11",
      "h-11",
      "shrink-0",
      "items-center",
      "justify-start",
      "justify-end",
      "min-w-0",
      "min-w-min",
      "flex-1",
      "gap-3",
      "sm:gap-4",
      "gap-1",
      "gap-1.5",
      "sm:gap-2",
      "pointer-events-none",
      "pointer-events-auto",
      "shrink",
      "truncate",
      "font-semibold",
      "text-current",
      "mx-0.5",
      "h-3.5",
      "w-3.5",
      "rounded-full",
    ]),
  );
}

/**
 * The row `TopShellBreadcrumbTrail` renders inside, and the trail itself —
 * structure and classNames mirror `AppTopShell` / `TopShellBreadcrumbTrail`
 * in `components/app-ui/top-app-bar.tsx`. Only ever renders the immediate
 * parent + current page: that is what `breadcrumbTrailItems` produces once a
 * chain is deeper than two, which is what this fixture proves stays whole.
 */
function breadcrumbRowMarkup(scenario: (typeof SCENARIOS)[number]): string {
  return `<div
      class="pointer-events-none flex h-full w-full items-center gap-3 sm:gap-4"
      style="height: var(--top-bar-h); background: var(--app-canvas, #fff);"
    >
      <div
        class="pointer-events-none flex h-full shrink-0 items-center justify-start"
        style="width: auto;"
      >
        <div class="pointer-events-auto flex h-11 w-11 items-center justify-center">
          <button
            type="button"
            aria-label="Go back"
            style="width: 36px; height: 36px; border-radius: 9999px; border: 0; background: transparent;"
          ></button>
        </div>
      </div>

      <div class="pointer-events-none flex min-w-0 flex-1 items-center justify-start">
        <nav
          aria-label="Breadcrumb"
          data-testid="top-app-bar-breadcrumb-trail"
          class="ui-text-navigation-title top-shell-ambient-ink pointer-events-auto flex min-w-0 items-center gap-1 text-current"
        >
          <span class="flex items-center gap-1 shrink">
            <button
              type="button"
              data-testid="ancestor-crumb"
              class="${ANCESTOR_CRUMB_CLASS}"
            >${scenario.ancestor}</button>
          </span>
          <span class="flex items-center gap-1 shrink-0">
            <svg
              aria-hidden="true"
              class="mx-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--app-tertiary-label)]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            ><path d="M9 6l6 6-6 6" /></svg>
            <span
              data-testid="current-crumb"
              class="truncate min-w-0 shrink-0 font-semibold text-current"
              aria-current="page"
            >${scenario.current}</span>
          </span>
        </nav>
      </div>

      <div
        class="pointer-events-none flex h-full shrink-0 items-center justify-end"
        style="min-width: var(--top-bar-side-w);"
      >
        <div class="pointer-events-auto flex flex-nowrap items-center justify-end gap-1.5 sm:gap-2">
          <button
            type="button"
            aria-label="Open Profile"
            style="width: 32px; height: 32px; border-radius: 9999px; border: 0; background: var(--app-accent, #007aff);"
          ></button>
        </div>
      </div>
    </div>`;
}

/**
 * An isolated, deliberately adversarial rig: just the ancestor-crumb button
 * (real classes) inside a wrapper narrower than the word itself could ever
 * need. This is what directly exercises removing `min-w-0`/`max-w-[9rem]`,
 * independent of guessing the exact production row budget (which depends on
 * Dynamic Type, trailing-action count, and gutter breakpoint, none of which
 * this fixture can fully reconstruct) — CSS `flex-shrink` cannot compress a
 * `white-space: nowrap` text run below its own min-content width unless
 * something removes that floor, so this proves the floor is gone from the
 * shipped classes, not merely that today's specific row happens to fit.
 */
function narrowCrumbMarkup(label: string, wrapperWidthPx: number): string {
  return `<div style="display:flex; width:${wrapperWidthPx}px; border:1px solid #ccc;">
      <button
        type="button"
        data-testid="narrow-crumb"
        class="ui-text-navigation-title ${ANCESTOR_CRUMB_CLASS}"
      >${label}</button>
    </div>`;
}

async function writeFixture(): Promise<string> {
  const css = await buildStylesheet();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "top-shell-breadcrumb-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  const rows = SCENARIOS.map(
    (scenario) =>
      `<div data-testid="row" data-scenario="${scenario.name}" style="width: 100%; margin-bottom: 8px;">${breadcrumbRowMarkup(scenario)}</div>`,
  ).join("\n");
  const narrowRig = `<div data-testid="narrow-rig">${narrowCrumbMarkup("Location", 40)}</div>`;
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html class="light"><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  body { margin: 0; padding: 0; }
  .frame { width: 100%; padding-left: var(--page-inline-gutter-standard); padding-right: var(--page-inline-gutter-standard); box-sizing: border-box; max-width: 90rem; margin: 0 auto; }
</style></head>
<body><div class="frame">${rows}${narrowRig}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

let fixtureUrl: string;

test.beforeAll(async () => {
  fixtureUrl = await writeFixture();
});

for (const phone of PHONES) {
  test.describe(`breadcrumb trail at ${phone.name} (${phone.width}x${phone.height})`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    for (const scenario of SCENARIOS) {
      test(`"${scenario.name}" shows both crumbs whole, no ellipsis`, async ({
        page,
      }) => {
        await page.goto(fixtureUrl);
        await awaitProductFont(page);

        const row = page.locator(
          `[data-testid="row"][data-scenario="${scenario.name}"]`,
        );
        const ancestor = row.getByTestId("ancestor-crumb");
        const current = row.getByTestId("current-crumb");

        await expect(ancestor).toHaveText(scenario.ancestor);
        await expect(current).toHaveText(scenario.current);

        const metrics = await row.evaluate((rowEl) => {
          const a = rowEl.querySelector(
            '[data-testid="ancestor-crumb"]',
          ) as HTMLElement;
          const c = rowEl.querySelector(
            '[data-testid="current-crumb"]',
          ) as HTMLElement;
          return {
            ancestorScrollWidth: a.scrollWidth,
            ancestorClientWidth: a.clientWidth,
            currentScrollWidth: c.scrollWidth,
            currentClientWidth: c.clientWidth,
            rowScrollWidth: rowEl.scrollWidth,
            rowClientWidth: rowEl.clientWidth,
          };
        });

        // The ancestor crumb carries `truncate` (overflow:hidden +
        // text-overflow:ellipsis); scrollWidth > clientWidth here is exactly
        // what a visible "..." looks like. Equal means the whole word shows.
        expect(
          metrics.ancestorScrollWidth,
          `"${scenario.ancestor}" ancestor crumb ellipsized at ${phone.name}`,
        ).toBeLessThanOrEqual(metrics.ancestorClientWidth + SLACK_PX);

        // The current page crumb is `shrink-0` by design and must never
        // ellipsize either.
        expect(
          metrics.currentScrollWidth,
          `"${scenario.current}" current-page crumb ellipsized at ${phone.name}`,
        ).toBeLessThanOrEqual(metrics.currentClientWidth + SLACK_PX);

        // Neither crumb shrinking below content may push the row itself into
        // horizontal overflow.
        expect(
          metrics.rowScrollWidth,
          `breadcrumb row overflows horizontally at ${phone.name}`,
        ).toBeLessThanOrEqual(metrics.rowClientWidth + SLACK_PX);
      });
    }
  });
}

test.describe("ancestor crumb under adversarial width pressure", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("never shrinks below its own unbreakable text width", async ({
    page,
  }) => {
    await page.goto(fixtureUrl);
    await awaitProductFont(page);

    const crumb = page.getByTestId("narrow-crumb");
    await expect(crumb).toHaveText("Location");

    const metrics = await crumb.evaluate((el: HTMLElement) => {
      // Its own min-content width: what it would render at with no
      // constraint at all, for comparison against the constrained wrapper.
      const probe = el.cloneNode(true) as HTMLElement;
      probe.style.cssText =
        "position:absolute; visibility:hidden; width:auto; max-width:none;";
      document.body.appendChild(probe);
      const naturalWidth = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        naturalWidth,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });

    // The wrapper is 40px — deliberately narrower than "Location" could ever
    // render. Without a `min-w-0` floor, flex-shrink cannot compress the
    // button below its own min-content size, so its rendered width must
    // equal its natural (unconstrained) width, and the text must render
    // whole rather than ellipsized.
    expect(metrics.clientWidth).toBeGreaterThanOrEqual(
      metrics.naturalWidth - SLACK_PX,
    );
    expect(metrics.scrollWidth).toBeLessThanOrEqual(
      metrics.clientWidth + SLACK_PX,
    );
  });
});
