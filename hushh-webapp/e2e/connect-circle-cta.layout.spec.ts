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
  CONNECT_SEARCH_INPUT_CLASSNAME,
  CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME,
  CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME,
  CONNECT_SEARCH_PLACEHOLDER,
} from "../app/connect/connect-search-layout";
import {
  CONNECT_CONNECTIONS_SUMMARY_CHEVRON_CLASSNAME,
  CONNECT_CONNECTIONS_SUMMARY_COUNT_CLASSNAME,
  CONNECT_CONNECTIONS_SUMMARY_TRAILING_CLASSNAME,
  CONNECT_DIRECTORY_MENU_CLASSNAME,
} from "../app/connect/connect-surface-layout";
import {
  CIRCLE_NAME_ACTION_CLASSNAME,
  CIRCLE_NAME_INPUT_CLASSNAME,
  CIRCLE_NAME_ROW_CLASSNAME,
  CIRCLE_NAME_ROW_HEIGHT_PX,
} from "../components/one-location/redesign/circles/circle-name-row-layout";
import { buttonVariants } from "../components/ui/button";
import { INPUT_CLASSNAME } from "../components/ui/input";
import { cn } from "../lib/utils";

/**
 * Three QA reports from one round of phone testing, measured in a real browser.
 *
 *   1. "Save CTA, not looking good" -- the Circle rename button.
 *   2. "remove neeche aa rha" -- the trailing control on a connection row
 *      dropping onto its own line.
 *   3. "text is long currently inside search bar" -- the Connect placeholder
 *      clipping to "Search people by nam" when the select action shared the
 *      same row.
 *
 * Every one of them is invisible to the JSDOM suite, which applies no CSS and
 * measures every element as 0x0. A `className.toContain(...)` assertion would
 * have passed on all three the entire time they were broken. So the sibling
 * JSDOM tests prove the components still render these class strings, and this
 * file proves what the strings do -- in the real Tailwind cascade, at the real
 * type, across the phone widths the product ships on.
 *
 * Both routes are behind sign-in, so reaching them would need a reviewer
 * fixture and a live backend. Instead this renders the real class strings,
 * imported from the modules the screens themselves import, exactly as the
 * ready-panel and save-location-sheet contracts already do.
 *
 * Run with: npm run test:layout-contracts
 */

/** Every common iPhone width, plus one tablet reference. `sm:` is 640px, so
 *  everything below that is what actually ships to the App Store. */
const PHONE_WIDTHS = [320, 360, 375, 390, 430] as const;
const WIDTHS = [...PHONE_WIDTHS, 768] as const;

/** The app's horizontal page padding at phone widths, as a conservative floor.
 *  Assuming LESS room than the screen really has can only make these stricter. */
const PAGE_PADDING_PX = 16;

/** Tailwind `sm:`. Below it, `stackTrailingOnMobile` is in force. */
const SM_BREAKPOINT_PX = 640;

/**
 * The real stylesheet, compiled once per worker.
 *
 * `globals.css` is used rather than a bare `@import "tailwindcss"` because the
 * type this measures is defined there, not in Tailwind: `ui-text-input-value`
 * sets the search field to 17px/22px Inter via `--type-input-value-*`. Compiling
 * without it would measure a 16px system font and quietly prove nothing about
 * the field that shipped.
 *
 * `@source` directives are stripped: they exist to widen the scanner across the
 * component tree for the real build, and here the candidate list is explicit.
 * Leaving them in would scan thousands of files for utilities already listed.
 */
async function buildStylesheet(candidates: string[]): Promise<string> {
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

  // The app's own @font-face rules cannot load over file:// and, sharing a
  // family name with the working one, stop it satisfying fonts.check.
  return stripAppFontFaces(compiler.build(candidates));
}

/**
 * Write a fixture directory and return its `file://` URL.
 *
 * The real Inter face is copied in and the stylesheet's absolute `/fonts/...`
 * URLs rewritten to point at it. Without that step the page silently falls back
 * to a system font, and every width measured here would be a measurement of the
 * wrong typeface -- which is the only thing the placeholder assertions are
 * actually about.
 */
async function buildFixture(name: string, body: string, candidates: string[]) {
  const webappRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  let css = await buildStylesheet(candidates);

  const fontSource = path.join(webappRoot, "public/fonts/Inter");
  if (fs.existsSync(fontSource)) {
    fs.cpSync(fontSource, path.join(dir, "fonts/Inter"), { recursive: true });
    css = css.replace(/url\(["']?\/fonts\//g, 'url("./fonts/');
  }

  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css"></head>
<body style="margin:0"><div style="padding:0 ${PAGE_PADDING_PX}px">${body}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/** Box geometry, as a human reads it off a screenshot. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** The selector is passed as an argument, never captured: `page.evaluate`
 *  ships the function's source to the browser, where a closure variable from
 *  this file would arrive undefined. */
function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`missing ${sel}`);
    const r = node.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  }, selector);
}

/** `document.fonts.ready` resolves to a FontFaceSet, which cannot cross the
 *  bridge -- await it and return nothing. */
const fontsReady = (page: Page) =>
  page.evaluate(() => document.fonts.ready.then(() => undefined));

// ---------------------------------------------------------------------------
// 1. The Circle name field and the control beside it
// ---------------------------------------------------------------------------

/**
 * The class attribute the button really carries.
 *
 * Composed through the component's own `buttonVariants` and `cn`, not by
 * concatenating strings, because tailwind-merge is the entire subject here. It
 * is what decides that `h-11` erases `h-[50px]` while leaving `min-h-[50px]`
 * standing -- and a fixture that skipped it would be measuring a class list the
 * app never renders, in whatever order Tailwind happened to emit.
 */
const circleActionClass = (className: string, size: "sm" | "default") =>
  cn(buttonVariants({ variant: "default", size, className }));

/** The Save button exactly as it shipped: `Button`'s `default` size under an
 *  `h-11` that could never reach its `min-h-[50px]`. */
const CIRCLE_ACTION_BEFORE = "h-11 shrink-0 rounded-xl px-4 font-semibold";

const CIRCLE_CANDIDATES = [
  ...circleActionClass(CIRCLE_NAME_ACTION_CLASSNAME, "sm").split(/\s+/),
  ...circleActionClass(CIRCLE_ACTION_BEFORE, "default").split(/\s+/),
  ...CIRCLE_NAME_INPUT_CLASSNAME.split(/\s+/),
  ...CIRCLE_NAME_ROW_CLASSNAME.split(/\s+/),
];

function circleRowBody(
  state: "save" | "edit",
  className: string = CIRCLE_NAME_ACTION_CLASSNAME,
  size: "sm" | "default" = "sm",
): string {
  const cls = circleActionClass(className, size);
  const action =
    state === "save"
      ? `<button data-testid="circle-name-action" class="${cls}">Save</button>`
      : `<button data-testid="circle-name-action" aria-label="Edit Circle name" class="${cls}">&#9998;</button>`;
  return `<div class="${CIRCLE_NAME_ROW_CLASSNAME}">
  <input data-testid="circle-name-input" class="${CIRCLE_NAME_INPUT_CLASSNAME}" value="Family" />
  ${action}
</div>`;
}

test.describe("Circle name row", () => {
  for (const width of WIDTHS) {
    test(`field and control are the same 44px box at ${width}px`, async ({
      page,
    }) => {
      const measured: Record<string, { input: Box; action: Box }> = {};

      for (const state of ["save", "edit"] as const) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(
          await buildFixture(
            "circle-name-row",
            circleRowBody(state),
            CIRCLE_CANDIDATES,
          ),
        );
        await fontsReady(page);

        measured[state] = {
          input: await boxOf(page, '[data-testid="circle-name-input"]'),
          action: await boxOf(page, '[data-testid="circle-name-action"]'),
        };
      }

      for (const state of ["save", "edit"] as const) {
        const { input, action } = measured[state];

        // The reported defect: Save took `Button`'s default size, whose
        // `min-h-[50px]` survives an `h-11` override, so it rendered 50px
        // against a 44px field and stood 3px proud on each edge.
        expect(
          Math.abs(action.height - CIRCLE_NAME_ROW_HEIGHT_PX),
          `${state}: control height`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(input.height - CIRCLE_NAME_ROW_HEIGHT_PX),
          `${state}: field height`,
        ).toBeLessThanOrEqual(0.5);

        // Same box, same line, flush on both edges.
        expect(
          Math.abs(action.top - input.top),
          `${state}: top`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(action.bottom - input.bottom),
          `${state}: bottom`,
        ).toBeLessThanOrEqual(0.5);

        // Nothing may push the page sideways.
        expect(action.right, `${state}: right edge`).toBeLessThanOrEqual(
          width - PAGE_PADDING_PX + 1,
        );
        expect(input.left, `${state}: left edge`).toBeGreaterThanOrEqual(
          PAGE_PADDING_PX - 1,
        );
      }

      // Typing the first character must not resize the field. Save is wider
      // than a pencil glyph, so before the shared width the input jumped by the
      // difference the moment the row became dirty, and back again on save.
      expect(
        Math.abs(measured.save.action.width - measured.edit.action.width),
        "control width is identical in both states",
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(measured.save.input.width - measured.edit.input.width),
        "field width is identical in both states",
      ).toBeLessThanOrEqual(0.5);
    });
  }

  test("the version QA photographed really was 6px too tall", async ({
    page,
  }) => {
    // Mutation check. Without this, the assertions above could be passing on a
    // rule that was never capable of failing.
    //
    // `h-11` on `Button`'s `default` size erases `h-[50px]` and leaves
    // `min-h-[50px]` untouched -- `h-` and `min-h-` are separate tailwind-merge
    // groups -- so the button resolved to a 50px minimum against a 44px field.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      await buildFixture(
        "circle-name-row-before",
        circleRowBody("save", CIRCLE_ACTION_BEFORE, "default"),
        CIRCLE_CANDIDATES,
      ),
    );
    await fontsReady(page);

    const input = await boxOf(page, '[data-testid="circle-name-input"]');
    const action = await boxOf(page, '[data-testid="circle-name-action"]');

    expect(
      Math.abs(input.height - CIRCLE_NAME_ROW_HEIGHT_PX),
    ).toBeLessThanOrEqual(0.5);
    expect(
      action.height,
      "the shipped Save button measured 50px",
    ).toBeGreaterThan(input.height + 4);
  });
});
// ---------------------------------------------------------------------------
// 2. The Connect search row
// ---------------------------------------------------------------------------

const SEARCH_CANDIDATES = [
  ...INPUT_CLASSNAME.split(/\s+/),
  ...CONNECT_SEARCH_INPUT_CLASSNAME.split(/\s+/),
  ...CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME.split(/\s+/),
  ...CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME.split(/\s+/),
  "block",
  "w-full",
  "relative",
  "inline-flex",
  "justify-center",
  "whitespace-nowrap",
  "min-h-9",
  "h-9",
  // The before-geometry the mutation check reproduces.
  "px-4",
  "rounded-full",
  "text-[15px]",
  "font-semibold",
  "leading-5",
  "h-10",
  "min-h-10",
  "shrink-0",
];

/** The row exactly as Connect builds it: one full-width search field. */
const searchRowBody = (empty: boolean) => `<div class="block w-full">
  <div class="relative">
    <input data-testid="connect-search" placeholder="${CONNECT_SEARCH_PLACEHOLDER}"
      class="${INPUT_CLASSNAME} ${CONNECT_SEARCH_INPUT_CLASSNAME} ${
        empty
          ? CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME
          : CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME
      }" />
  </div>
</div>`;

/**
 * How much room the placeholder actually has, and how much it needs.
 *
 * Width is measured by laying the string out in the field's own computed font
 * rather than estimated from a character count -- Inter is proportional, and a
 * per-character average is wrong by enough to make a fit assertion meaningless.
 */
function probePlaceholder(text: string) {
  const node = document.querySelector(
    '[data-testid="connect-search"]',
  ) as HTMLInputElement | null;
  if (!node) throw new Error("missing search field");

  const style = getComputedStyle(node);
  const available =
    node.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight);

  const ruler = document.createElement("span");
  ruler.textContent = text;
  ruler.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`;
  document.body.appendChild(ruler);
  const needed = ruler.getBoundingClientRect().width;
  ruler.remove();

  return { available, needed, fontSize: style.fontSize };
}

test.describe("Connect search row", () => {
  for (const width of PHONE_WIDTHS) {
    test(`placeholder is fully readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture(
          "connect-search",
          searchRowBody(true),
          SEARCH_CANDIDATES,
        ),
      );
      await fontsReady(page);

      // The fixture must be measuring the real 17px field type. If globals.css
      // ever stops reaching this page, every assertion below would pass against
      // a smaller fallback font and prove nothing.
      const current = await page.evaluate(
        probePlaceholder,
        CONNECT_SEARCH_PLACEHOLDER,
      );
      expect(current.fontSize, "field is at the app's real input type").toBe(
        "17px",
      );

      // Sub-pixel tolerance, matching the 0.5px this file already allows on every
      // other measured box. Text advance widths differ by a fraction between the
      // Linux CI webkit and macOS webkit for the same pinned font -- "Search people"
      // measures 116.0px locally and 116.15625px on the runner. 0.5px cannot mask a
      // real clip: the mutation check below is a placeholder eight characters longer.
      expect(
        current.needed,
        `"${CONNECT_SEARCH_PLACEHOLDER}" needs ${current.needed.toFixed(1)}px of ${current.available.toFixed(1)}px`,
      ).toBeLessThanOrEqual(current.available + 0.5);
    });
  }

  test("the clear-button gutter is only reserved once there is a query", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 844 });

    await page.goto(
      await buildFixture(
        "connect-search-empty",
        searchRowBody(true),
        SEARCH_CANDIDATES,
      ),
    );
    const empty = await page.evaluate(
      probePlaceholder,
      CONNECT_SEARCH_PLACEHOLDER,
    );

    await page.goto(
      await buildFixture(
        "connect-search-typed",
        searchRowBody(false),
        SEARCH_CANDIDATES,
      ),
    );
    const typed = await page.evaluate(
      probePlaceholder,
      CONNECT_SEARCH_PLACEHOLDER,
    );

    // An empty field has no clear button in it, so it should not be holding
    // 44px back from the only thing it is showing.
    expect(empty.available).toBeGreaterThan(typed.available);
  });

  for (const width of [320, 360, 375, 390, 430] as const) {
    test(`search owns the full content row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture(
          "connect-search-full-width",
          searchRowBody(true),
          SEARCH_CANDIDATES,
        ),
      );

      const field = await boxOf(page, '[data-testid="connect-search"]');
      expect(field.left).toBeGreaterThanOrEqual(0);
      expect(field.right).toBeLessThanOrEqual(width + 0.5);
      expect(field.width).toBeGreaterThanOrEqual(width - PAGE_PADDING_PX * 2);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The settings-row grid, and what `stackTrailingOnMobile` really does
// ---------------------------------------------------------------------------

const ROW_CANDIDATES = [
  "grid",
  "w-full",
  "grid-cols-1",
  "grid-cols-[minmax(0,1fr)_auto]",
  "sm:grid-cols-[minmax(0,1fr)_auto]",
  "items-center",
  "sm:items-center",
  "gap-x-3",
  "sm:gap-x-3",
  "gap-y-1",
  "sm:gap-y-0",
  "min-h-[56px]",
  "px-4",
  "py-2.5",
  "min-w-0",
  "flex-1",
  "truncate",
  "block",
  "flex",
  "justify-end",
  "justify-between",
  "w-full",
  "sm:w-auto",
  "sm:justify-end",
  "pt-1",
  "sm:pt-0",
  "shrink-0",
  "h-8",
  "min-h-8",
  "rounded-2xl",
  "px-2.5",
  "px-0",
  "w-[72px]",
  "min-w-[72px]",
  "min-w-[100px]",
  "text-[14px]",
  "font-semibold",
  "leading-[18px]",
  "inline-flex",
  "items-center",
  "justify-center",
  "whitespace-nowrap",
];

/**
 * `SettingsRow`'s two geometries, side by side.
 *
 * These mirror the grid and trailing classes in `components/app-ui/settings-ui.tsx`
 * for `shouldStackTrailing` true and false. The point is not to re-test that
 * component -- it is to establish, in a real browser, that the prop Connect's
 * connection list was passing genuinely puts the action on a second line at
 * phone widths. The sibling JSDOM test then proves Connect no longer passes it.
 */
const rowsBody = `
<div data-testid="stacked" class="grid w-full grid-cols-1 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-3 sm:gap-y-0 min-h-[56px] px-4 py-2.5">
  <div class="min-w-0 flex-1"><span data-testid="stacked-title" class="block min-w-0 truncate">Abdul Rashid</span></div>
  <div class="flex w-full min-w-0 justify-between pt-1 sm:w-auto sm:justify-end sm:pt-0">
    <button data-testid="stacked-action" class="inline-flex items-center justify-center whitespace-nowrap h-8 min-h-8 rounded-2xl px-2.5 text-[14px] font-semibold leading-[18px] shrink-0">Remove</button>
  </div>
</div>
<div data-testid="inline" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 min-h-[56px] px-4 py-2.5">
  <div class="min-w-0 flex-1"><span data-testid="inline-title" class="block min-w-0 truncate">Abdul Rashid</span></div>
  <div class="flex shrink-0 items-center justify-end">
    <button data-testid="inline-action" class="inline-flex items-center justify-center whitespace-nowrap h-8 min-h-8 rounded-2xl px-2.5 text-[14px] font-semibold leading-[18px] shrink-0">Remove</button>
  </div>
</div>
<div data-testid="cancel-row" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 min-h-[56px] px-4 py-2.5">
  <div class="min-w-0 flex-1"><span class="block min-w-0 truncate">Smirthika Dharmalingam</span></div>
  <div class="flex shrink-0 items-center justify-end">
    <button data-testid="cancel-action" class="inline-flex items-center justify-center whitespace-nowrap h-8 min-h-8 rounded-2xl text-[14px] font-semibold leading-[18px] shrink-0 w-[72px] px-0">Cancel</button>
  </div>
</div>
<div data-testid="connect-row" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 min-h-[56px] px-4 py-2.5">
  <div class="min-w-0 flex-1"><span class="block min-w-0 truncate">Smirthi</span></div>
  <div class="flex shrink-0 items-center justify-end">
    <button data-testid="connect-action" class="inline-flex items-center justify-center whitespace-nowrap h-8 min-h-8 rounded-2xl px-2.5 text-[14px] font-semibold leading-[18px] shrink-0 min-w-[72px]">Connect</button>
  </div>
</div>`;

test.describe("Connect list rows", () => {
  for (const width of PHONE_WIDTHS) {
    test(`a connection keeps its action on one line at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture("connect-rows", rowsBody, ROW_CANDIDATES),
      );
      await awaitProductFont(page);
      await fontsReady(page);

      expect(
        width,
        "this width is below sm: and therefore a phone",
      ).toBeLessThan(SM_BREAKPOINT_PX);

      const stackedTitle = await boxOf(page, '[data-testid="stacked-title"]');
      const stackedAction = await boxOf(page, '[data-testid="stacked-action"]');
      const inlineTitle = await boxOf(page, '[data-testid="inline-title"]');
      const inlineAction = await boxOf(page, '[data-testid="inline-action"]');

      // The bug, reproduced: with `stackTrailingOnMobile` the action starts
      // below the name's baseline -- a second line, on every iPhone.
      expect(
        stackedAction.top,
        "stackTrailingOnMobile genuinely stacks below sm:",
      ).toBeGreaterThanOrEqual(stackedTitle.bottom);

      // The geometry the list uses now: one line, action pinned right.
      expect(
        inlineAction.top,
        "the shipped row keeps the action beside the name",
      ).toBeLessThan(inlineTitle.bottom);
      expect(inlineAction.right).toBeGreaterThan(inlineTitle.right);
      expect(inlineAction.right).toBeLessThanOrEqual(
        width - PAGE_PADDING_PX + 1,
      );
    });
  }

  test("the request action is no wider than the Connect beside it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto(
      await buildFixture("connect-rows", rowsBody, ROW_CANDIDATES),
    );
    await awaitProductFont(page);
    await fontsReady(page);

    const cancel = await boxOf(page, '[data-testid="cancel-action"]');
    const connect = await boxOf(page, '[data-testid="connect-action"]');

    // "Cancel request" under a 100px floor made the least common row state the
    // widest control on the screen -- 116px against Connect's 72px.
    expect(Math.abs(cancel.width - 72)).toBeLessThanOrEqual(0.5);
    expect(cancel.width).toBeLessThanOrEqual(connect.width + 0.5);
    expect(cancel.height).toBeLessThanOrEqual(32.5);
  });
});

// ---------------------------------------------------------------------------
// 4. The My connections disclosure and directory menu
// ---------------------------------------------------------------------------

const DISCLOSURE_CARD_CLASSNAME =
  "relative isolate overflow-hidden rounded-[var(--app-card-radius-standard,24px)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)] ring-0";
const DISCLOSURE_ROW_SHELL_CLASSNAME =
  "group/settings-row relative isolate overflow-hidden bg-transparent [--settings-row-py:10px]";
const DISCLOSURE_TRIGGER_CLASSNAME =
  "relative isolate grid w-full appearance-none overflow-hidden border-0 bg-transparent px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-left min-h-[56px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[var(--settings-row-gap)]";
const DISCLOSURE_MAIN_CLASSNAME =
  "relative z-0 flex min-w-0 items-center gap-[var(--settings-row-gap)]";
const DISCLOSURE_ICON_CLASSNAME =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-[7px]";
const DISCLOSURE_TITLE_CLASSNAME = "ui-text-row-label min-w-0 flex-1 truncate";
const DISCLOSURE_TRAILING_WRAPPER_CLASSNAME =
  "relative z-0 flex max-w-full shrink-0 items-center justify-end self-center gap-2.5 pr-0.5 sm:pr-1";

const DISCLOSURE_CANDIDATES = [
  "mx-auto w-full max-w-[720px]",
  DISCLOSURE_CARD_CLASSNAME,
  DISCLOSURE_ROW_SHELL_CLASSNAME,
  DISCLOSURE_TRIGGER_CLASSNAME,
  DISCLOSURE_MAIN_CLASSNAME,
  DISCLOSURE_ICON_CLASSNAME,
  DISCLOSURE_TITLE_CLASSNAME,
  DISCLOSURE_TRAILING_WRAPPER_CLASSNAME,
  CONNECT_CONNECTIONS_SUMMARY_TRAILING_CLASSNAME,
  CONNECT_CONNECTIONS_SUMMARY_COUNT_CLASSNAME,
  CONNECT_CONNECTIONS_SUMMARY_CHEVRON_CLASSNAME,
].flatMap((className) => className.split(/\s+/));

const disclosureBody = `<section class="mx-auto w-full max-w-[720px]">
  <div class="${DISCLOSURE_CARD_CLASSNAME}">
    <div class="${DISCLOSURE_ROW_SHELL_CLASSNAME}">
      <button type="button" data-testid="connections-trigger" class="${DISCLOSURE_TRIGGER_CLASSNAME}">
        <span class="${DISCLOSURE_MAIN_CLASSNAME}">
          <span aria-hidden="true" class="${DISCLOSURE_ICON_CLASSNAME}">
            <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="6" r="3" /></svg>
          </span>
          <span data-testid="connections-title" class="${DISCLOSURE_TITLE_CLASSNAME}">My connections</span>
        </span>
        <span data-testid="connections-trailing" class="${DISCLOSURE_TRAILING_WRAPPER_CLASSNAME}">
          <span class="${CONNECT_CONNECTIONS_SUMMARY_TRAILING_CLASSNAME}">
            <span class="${CONNECT_CONNECTIONS_SUMMARY_COUNT_CLASSNAME}">9,999</span>
            <svg data-testid="connections-chevron" aria-hidden="true" class="${CONNECT_CONNECTIONS_SUMMARY_CHEVRON_CLASSNAME}" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
          </span>
        </span>
      </button>
    </div>
  </div>
</section>`;

test.describe("Connect disclosure row", () => {
  for (const width of [320, 768] as const) {
    test(`stays a full-width single row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture(
          "connect-connections-disclosure",
          disclosureBody,
          DISCLOSURE_CANDIDATES,
        ),
      );
      await awaitProductFont(page);
      await fontsReady(page);

      const trigger = await boxOf(page, '[data-testid="connections-trigger"]');
      const title = await boxOf(page, '[data-testid="connections-title"]');
      const trailing = await boxOf(
        page,
        '[data-testid="connections-trailing"]',
      );
      const chevron = await boxOf(page, '[data-testid="connections-chevron"]');

      expect(trigger.height, "touch target").toBeGreaterThanOrEqual(56);
      expect(trigger.left).toBeGreaterThanOrEqual(PAGE_PADDING_PX - 1);
      expect(trigger.right).toBeLessThanOrEqual(width - PAGE_PADDING_PX + 1);
      expect(
        title.right,
        "title does not collide with count",
      ).toBeLessThanOrEqual(trailing.left + 0.5);
      expect(title.top).toBeLessThan(trailing.bottom);
      expect(trailing.top).toBeLessThan(title.bottom);
      expect(chevron.right).toBeLessThanOrEqual(trigger.right);

      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(width);
    });
  }
});

test("Connect directory menu is opaque in light and dark themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    await buildFixture(
      "connect-directory-menu",
      `<div data-testid="directory-menu" class="${CONNECT_DIRECTORY_MENU_CLASSNAME}">People</div>`,
      CONNECT_DIRECTORY_MENU_CLASSNAME.split(/\s+/),
    ),
  );

  for (const dark of [false, true]) {
    await page.evaluate((enabled) => {
      document.documentElement.classList.toggle("dark", enabled);
    }, dark);

    const alpha = await page.getByTestId("directory-menu").evaluate((el) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = getComputedStyle(el).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });

    expect(alpha, dark ? "dark menu alpha" : "light menu alpha").toBe(255);
  }
});
