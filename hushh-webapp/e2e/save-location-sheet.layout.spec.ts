import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  SHEET_BODY_CLASSNAME,
  SHEET_DETAILS_SHELL_CLASSNAME,
  SHEET_FOOTER_CLASSNAME,
  SHEET_HEADER_CLASSNAME,
  SHEET_LAYOUT_WIDTHS,
} from "../components/one-location/onboarding/save-location-sheet-layout";

/**
 * The address-details sheet, measured in a real browser.
 *
 * The sibling JSDOM test proves the component still renders these classes; it
 * cannot prove what they do, because JSDOM performs no layout. Both bugs this
 * guards against are invisible to a class assertion:
 *
 *  1. The title sat UNDER the corner buttons. They were `absolute left-4/
 *     right-4 top-4` -- 36px wide starting at 16px, so ending at 52px -- over
 *     a header padded to `px-9` (36px). 16px of overlap on each side, and the
 *     sheet being its own scroller meant the two drifted apart on any scroll.
 *  2. The last field showed THROUGH the primary button, because the footer was
 *     `sticky bottom-0` on a `/95` translucent background.
 *
 * Reproducing the real sheet would need the whole onboarding flow, a map key
 * and a signed-in fixture. Instead this renders the real class strings,
 * imported from the component's own module, in the real Tailwind cascade --
 * which is exactly the half a class assertion cannot reach: that these classes
 * produce three non-overlapping rows at every phone width.
 *
 * Run with: npm run test:layout-contracts
 */

/** Compile just the utilities this fixture uses, with the real Tailwind. */
async function buildFixture(): Promise<string> {
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

  const shell =
    "fixed left-1/2 bottom-0 w-full max-w-[420px] -translate-x-1/2 flex min-h-0 flex-col max-h-[min(92dvh,760px)] rounded-t-[24px] border";
  const row = "flex items-center gap-2";
  const button = "relative flex h-9 w-9 shrink-0 items-center justify-center";
  const title =
    "min-w-0 flex-1 truncate text-center text-[17px] font-semibold leading-[22px]";
  const field = "h-12 w-full rounded-[14px] border";
  const primary =
    "flex h-[52px] w-full items-center justify-center rounded-full";
  const secondary = "h-11 w-full rounded-full";

  const classes = [
    shell,
    SHEET_DETAILS_SHELL_CLASSNAME,
    SHEET_HEADER_CLASSNAME,
    SHEET_BODY_CLASSNAME,
    SHEET_FOOTER_CLASSNAME,
    row,
    button,
    title,
    field,
    primary,
    secondary,
    "mt-1 space-y-3.5 mb-1.5 block",
  ].join(" ");
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  // Enough fields to overflow every width under test, so the body genuinely
  // has to scroll -- a footer only bleeds when there is something behind it.
  const fields = Array.from(
    { length: 8 },
    (_, i) =>
      `<div><label class="mb-1.5 block">Field ${i + 1}</label>` +
      `<input class="${field}" data-testid="sheet-field" value="Value ${i + 1}"></div>`,
  ).join("");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "save-location-sheet-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>:root{--app-separator:#e5e5ea;--app-card-surface-default-solid:#fff}</style>
</head><body style="margin:0;background:#111">
<div class="${shell} ${SHEET_DETAILS_SHELL_CLASSNAME}" data-testid="save-location-modal">
  <header class="${SHEET_HEADER_CLASSNAME}" data-testid="sheet-header">
    <div class="${row} mt-1">
      <button class="${button}" data-testid="sheet-back">&#8592;</button>
      <h2 class="${title}" data-testid="sheet-title">Address details</h2>
      <button class="${button}" data-testid="sheet-close">&#10005;</button>
    </div>
  </header>
  <div class="${SHEET_BODY_CLASSNAME}" data-testid="sheet-body">
    <div class="space-y-3.5">${fields}</div>
  </div>
  <div class="${SHEET_FOOTER_CLASSNAME}" data-testid="sheet-footer">
    <button class="${primary}" data-testid="sheet-save">Save location</button>
    <button class="${secondary}" data-testid="sheet-skip">Skip for now</button>
  </div>
</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(
  page: import("@playwright/test").Page,
  testId: string,
): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} should be laid out`).not.toBeNull();
  return box!;
}

test.describe("Save-location address sheet layout", () => {
  for (const width of SHEET_LAYOUT_WIDTHS) {
    test(`keeps header, body and footer apart at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());

      const header = await boxOf(page, "sheet-header");
      const body = await boxOf(page, "sheet-body");
      const footer = await boxOf(page, "sheet-footer");

      // Three stacked rows, in order, touching but never overlapping.
      expect(Math.round(body.y)).toBeGreaterThanOrEqual(
        Math.round(header.y + header.height) - 1,
      );
      expect(Math.round(body.y + body.height)).toBeLessThanOrEqual(
        Math.round(footer.y) + 1,
      );
      expect(footer.height).toBeGreaterThan(0);
    });

    test(`never lets the corner buttons touch the title at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());

      const back = await boxOf(page, "sheet-back");
      const title = await boxOf(page, "sheet-title");
      const close = await boxOf(page, "sheet-close");

      expect(back.x + back.width).toBeLessThanOrEqual(title.x);
      expect(title.x + title.width).toBeLessThanOrEqual(close.x);
      // And the title still has room to be a title.
      expect(title.width).toBeGreaterThan(80);
    });

    test(`scrolls the body without moving the pinned rows at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());

      const headerBefore = await boxOf(page, "sheet-header");
      const footerBefore = await boxOf(page, "sheet-footer");

      const scrolled = await page.getByTestId("sheet-body").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return {
          top: el.scrollTop,
          overflow: el.scrollHeight - el.clientHeight,
        };
      });
      // The fixture must genuinely overflow, or this proves nothing.
      expect(scrolled.overflow).toBeGreaterThan(0);
      expect(scrolled.top).toBeGreaterThan(0);

      const headerAfter = await boxOf(page, "sheet-header");
      const footerAfter = await boxOf(page, "sheet-footer");
      expect(Math.round(headerAfter.y)).toBe(Math.round(headerBefore.y));
      expect(Math.round(footerAfter.y)).toBe(Math.round(footerBefore.y));

      // Scrolled to the bottom, the last field is still clear of the footer --
      // the old translucent sticky bar let it show through the button.
      const fields = page.getByTestId("sheet-field");
      const last = await fields.nth((await fields.count()) - 1).boundingBox();
      expect(last).not.toBeNull();
      expect(Math.round(last!.y + last!.height)).toBeLessThanOrEqual(
        Math.round(footerAfter.y) + 1,
      );
    });
  }

  test("paints the footer on a fully opaque surface", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await buildFixture());

    // Measured through a canvas rather than pattern-matched on the computed
    // string. Tailwind resolves `bg-…/95` to `oklab(… / 0.95)`, not to an
    // `rgba(…)` -- a regex looking for `rgba` passes that happily, which is
    // how the first version of this test failed to notice the very background
    // it was written to reject.
    const alpha = await page.getByTestId("sheet-footer").evaluate((el) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 1, 1);
      // Seed with fully transparent, so a colour the canvas cannot parse
      // leaves alpha at 0 and fails rather than silently reading as opaque.
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    });
    // Anything under 255 and the field behind it shows through the button.
    expect(alpha).toBe(255);
  });
});
