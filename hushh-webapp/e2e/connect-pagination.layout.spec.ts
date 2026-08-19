import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  CONNECT_PAGE_SIZE_TRIGGER_CLASSNAME,
  CONNECT_PAGER_BUTTON_CLASSNAME,
  CONNECT_PAGINATION_LEFT_CLASSNAME,
  CONNECT_PAGINATION_RIGHT_CLASSNAME,
  CONNECT_PAGINATION_ROW_CLASSNAME,
} from "../app/connect/connect-pagination-layout";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";

/**
 * "connect page par prev and next neeche shifted hain, per page wale ke sath
 * same line mein nahi" -- Prev/Next dropped below "Page N · Per page" on the
 * Connect people list.
 *
 * The footer's own row was `flex-col`, becoming `flex-row` only past
 * Tailwind's `sm:` (640px) breakpoint. Nothing in this app is ever rendered
 * above phone width, so `sm:` never fired and the row was `flex-col` on every
 * device it ships to -- the same class of bug as `sm:inline` staying hidden on
 * every iPhone, just on flex-direction instead of visibility.
 *
 * Invisible to the JSDOM suite, which applies no CSS and never resolves a
 * breakpoint. This measures the real class strings, imported from the module
 * the screen itself imports, in a real Chromium/WebKit viewport.
 *
 * Run with: npm run test:layout-contracts
 */

/** Every common iPhone width, plus one tablet reference -- `sm:` sits at
 *  640px, above every one of these. */
const PHONE_WIDTHS = [320, 360, 375, 390, 430] as const;
const WIDTHS = [...PHONE_WIDTHS, 768] as const;

/** The card's own horizontal inset (`px-3`), as a conservative floor. */
const CARD_PADDING_PX = 12;

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
            ? path.join(webappRoot, "node_modules/tw-animate-css/dist/tw-animate.css")
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

/** Write a fixture directory and return its `file://` URL. */
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
<body style="margin:0"><div style="padding:0 ${CARD_PADDING_PX}px">${body}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

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

const fontsReady = (page: Page) =>
  page.evaluate(() => document.fonts.ready.then(() => undefined));

/** Prev/Next exactly as `Button` (`variant="none" effect="fill" size="sm"`,
 *  which maps to the stock `ghost`/`sm`) resolves them, through the same `cn`
 *  the component itself calls -- tailwind-merge, not string concatenation, is
 *  what actually decides `h-8` wins over `sm`'s own `h-9`. */
const PAGER_BUTTON_CLASSNAME = cn(
  buttonVariants({
    variant: "ghost",
    size: "sm",
    className: cn(CONNECT_PAGER_BUTTON_CLASSNAME, "min-w-[44px] px-3"),
  }),
);

/** A stand-in for the page-size `<Select>` trigger: same box, not the same
 *  Radix primitive -- the trigger's own internals are not this row's subject. */
const SELECT_STAND_IN_CLASSNAME = cn(
  "inline-flex w-fit items-center justify-center",
  CONNECT_PAGE_SIZE_TRIGGER_CLASSNAME,
);

/** The footer exactly as Connect builds it. */
function paginationFooterBody(rowClassName: string): string {
  return `<div class="${rowClassName}" data-testid="pagination-row">
  <div class="${CONNECT_PAGINATION_LEFT_CLASSNAME}" data-testid="pagination-left">
    <span class="whitespace-nowrap">Page 4</span>
    <span class="h-1 w-1 shrink-0 rounded-full"></span>
    <button class="${SELECT_STAND_IN_CLASSNAME}">8</button>
  </div>
  <div class="${CONNECT_PAGINATION_RIGHT_CLASSNAME}" data-testid="pagination-right">
    <button data-testid="pagination-prev" class="${PAGER_BUTTON_CLASSNAME}">Prev</button>
    <button data-testid="pagination-next" class="${PAGER_BUTTON_CLASSNAME}">Next</button>
  </div>
</div>`;
}

const CANDIDATES = [
  ...CONNECT_PAGINATION_ROW_CLASSNAME.split(/\s+/),
  ...CONNECT_PAGINATION_LEFT_CLASSNAME.split(/\s+/),
  ...CONNECT_PAGINATION_RIGHT_CLASSNAME.split(/\s+/),
  ...SELECT_STAND_IN_CLASSNAME.split(/\s+/),
  ...PAGER_BUTTON_CLASSNAME.split(/\s+/),
  "shrink-0",
  "rounded-full",
  "whitespace-nowrap",
  // The before-geometry the mutation check reproduces.
  "flex-col",
  "sm:flex-row",
  "sm:items-center",
  "sm:justify-between",
  "flex-wrap",
];

test.describe("Connect pagination footer", () => {
  for (const width of WIDTHS) {
    test(`Prev/Next share Page N's row, not a line below it, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture(
          "connect-pagination",
          paginationFooterBody(CONNECT_PAGINATION_ROW_CLASSNAME),
          CANDIDATES,
        ),
      );
      await fontsReady(page);

      const left = await boxOf(page, '[data-testid="pagination-left"]');
      const right = await boxOf(page, '[data-testid="pagination-right"]');

      // The reported defect: Prev/Next rendered on a second line, below
      // "Page N · Per page". Same row means the same top edge.
      expect(Math.abs(right.top - left.top), "same row").toBeLessThanOrEqual(0.5);

      // Nothing may push the row wider than the viewport.
      expect(right.right, "right edge stays on screen").toBeLessThanOrEqual(
        width - CARD_PADDING_PX + 1,
      );
      expect(left.left, "left edge stays on screen").toBeGreaterThanOrEqual(
        CARD_PADDING_PX - 1,
      );
    });
  }

  test("the shipped row really did wrap Prev/Next onto a second line", async ({
    page,
  }) => {
    // Mutation check. Without this, the assertion above could be passing on a
    // fixture too permissive to fail -- this reproduces the exact `flex-col
    // sm:flex-row` the row shipped with and shows it actually breaks at phone
    // width, which is the one width this screen ever renders at.
    const BEFORE_ROW_CLASSNAME =
      "flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between";

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      await buildFixture(
        "connect-pagination-before",
        paginationFooterBody(BEFORE_ROW_CLASSNAME),
        CANDIDATES,
      ),
    );
    await fontsReady(page);

    const left = await boxOf(page, '[data-testid="pagination-left"]');
    const right = await boxOf(page, '[data-testid="pagination-right"]');

    expect(
      right.top,
      "the shipped row measured Prev/Next on a lower line",
    ).toBeGreaterThan(left.bottom - 1);
  });
});
