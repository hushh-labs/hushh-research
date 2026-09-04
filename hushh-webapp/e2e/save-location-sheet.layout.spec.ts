import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  PICKER_MAP_HEIGHT_CLASSNAME,
  SHEET_BODY_CLASSNAME,
  SHEET_DETAILS_SHELL_CLASSNAME,
  SHEET_FOOTER_CLASSNAME,
  SHEET_FULL_BLEED_WIDTHS,
  SHEET_HEADER_CLASSNAME,
  SHEET_LAYOUT_WIDTHS,
  SHEET_SURFACE_CLASSNAME,
  SHEET_TAKEOVER_DETAILS_TOP_CLASSNAME,
  SHEET_TAKEOVER_SURFACE_CLASSNAME,
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
async function buildFixture({
  takeover = false,
}: { takeover?: boolean } = {}): Promise<string> {
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

  // The primitive's own `side="bottom"` positioning, verbatim from
  // components/ui/sheet.tsx, plus the surface contract this sheet adds on top.
  // Hand-writing a `max-w-[420px]` here is exactly what the fixture used to do,
  // which is why it measured a floating card and reported it as correct.
  //
  // The takeover lane drops the rounded top edge and the top border because
  // tailwind-merge removes them in the app: `rounded-none` and `border-0` from
  // `SHEET_TAKEOVER_SURFACE_CLASSNAME` land in the same merge groups. This
  // fixture concatenates raw strings, so leaving them in would measure a
  // cascade the app never renders.
  const sheetPositioning = takeover
    ? "fixed inset-x-0 bottom-[var(--kb-height,0px)] h-auto flex min-h-0 flex-col"
    : "fixed inset-x-0 bottom-[var(--kb-height,0px)] h-auto flex min-h-0 flex-col rounded-t-[24px] border-t";
  const shell = takeover
    ? `${sheetPositioning} ${SHEET_TAKEOVER_SURFACE_CLASSNAME} ${SHEET_TAKEOVER_DETAILS_TOP_CLASSNAME}`
    : `${sheetPositioning} ${SHEET_SURFACE_CLASSNAME}`;
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
    PICKER_MAP_HEIGHT_CLASSNAME,
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
<style>${productFontStyle()}</style>
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
    <div class="${PICKER_MAP_HEIGHT_CLASSNAME} w-full" data-testid="sheet-map"></div>
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
      await awaitProductFont(page);

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
      await awaitProductFont(page);

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
      await awaitProductFont(page);

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


  /**
   * THE FLOATING-PAD CONTRACT.
   *
   * The band that broke was 421-639px: wide enough to clear a 420px cap, still
   * narrow enough to be a bottom sheet. Nothing in the old matrix went past
   * 430, so a card centred in a 540px window with 60px of dead screen on each
   * side passed six widths of "layout is correct".
   *
   * Measured, not read off a class string: `max-w` is one of several ways to
   * end up narrower than the viewport, and only the rendered box knows.
   */
  for (const width of SHEET_FULL_BLEED_WIDTHS) {
    test(`spans the whole viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const sheet = await boxOf(page, "save-location-modal");

      // Attached to both edges: no strip of app showing beside a sheet.
      expect(Math.round(sheet.x)).toBe(0);
      expect(Math.round(sheet.width)).toBe(width);

      // And nothing inside it reaches past those edges.
      const overflow = await page.evaluate(
        () =>
          Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          ) - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test(`terminates at the bottom edge at ${width}px`, async ({ page }) => {
      // The home indicator belongs INSIDE the sheet's padding. An outer gap
      // puts a band of wallpaper under a surface that is meant to be attached
      // to the bottom of the screen.
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const sheet = await boxOf(page, "save-location-modal");
      const footer = await boxOf(page, "sheet-footer");

      expect(Math.round(sheet.y + sheet.height)).toBe(844);
      expect(Math.round(footer.y + footer.height)).toBe(844);
    });
  }

  /** The three devices the redesign has to hold, named rather than implied. */
  const DEVICES = [
    { name: "iPhone SE", width: 320, height: 568 },
    { name: "iPhone 15", width: 390, height: 844 },
    { name: "iPhone 15 Pro Max", width: 430, height: 932 },
  ] as const;

  for (const device of DEVICES) {
    test(`keeps both actions whole and on screen on ${device.name}`, async ({
      page,
    }) => {
      // The smallest supported screen is not allowed to become the neglected
      // one: the map used to take `min(56vh,420px)` -- 318 of an SE's 568
      // points -- and pushed Confirm and Skip below the fold on the one screen
      // whose whole job is "look at this, then press the button".
      await page.setViewportSize({ width: device.width, height: device.height });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      for (const testId of ["sheet-save", "sheet-skip"] as const) {
        const box = await boxOf(page, testId);
        expect(
          Math.round(box.y + box.height),
          `${testId} bottom on ${device.name}`,
        ).toBeLessThanOrEqual(device.height);
        expect(
          Math.round(box.x),
          `${testId} left on ${device.name}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          Math.round(box.x + box.width),
          `${testId} right on ${device.name}`,
        ).toBeLessThanOrEqual(device.width);
        // A real target, not a sliver squeezed by the shrinking viewport.
        expect(
          Math.round(box.height),
          `${testId} height on ${device.name}`,
        ).toBeGreaterThanOrEqual(44);
      }
    });

    test(`keeps the header and footer usable with the keyboard up on ${device.name}`, async ({
      page,
    }) => {
      // KeyboardInsetManager publishes the keyboard height as `--kb-height` on
      // <html>, and the sheet is pinned to `bottom-[var(--kb-height,0px)]`.
      // Lifting without ALSO shrinking is the bug: the surface rides up by the
      // full keyboard height and its top -- the step rail, the back button, the
      // title -- leaves the screen. The old `max-h-[min(92dvh,760px)]` did
      // exactly that.
      await page.setViewportSize({ width: device.width, height: device.height });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const keyboard = 300;
      await page.evaluate((height) => {
        document.documentElement.style.setProperty("--kb-height", `${height}px`);
      }, keyboard);

      const sheet = await boxOf(page, "save-location-modal");
      const header = await boxOf(page, "sheet-header");
      const footer = await boxOf(page, "sheet-footer");


      // Nothing above the top edge.
      expect(Math.round(sheet.y), `sheet top on ${device.name}`).toBeGreaterThanOrEqual(0);
      expect(Math.round(header.y), `header top on ${device.name}`).toBeGreaterThanOrEqual(0);

      // The whole surface sits in the band above the keyboard, so Save is
      // pressable rather than underneath it.
      expect(
        Math.round(sheet.y + sheet.height),
        `sheet bottom on ${device.name}`,
      ).toBeLessThanOrEqual(device.height - keyboard + 1);
      expect(
        Math.round(footer.y + footer.height),
        `footer bottom on ${device.name}`,
      ).toBeLessThanOrEqual(device.height - keyboard + 1);

      // And it is still the full width of the phone while lifted.
      expect(Math.round(sheet.x)).toBe(0);
      expect(Math.round(sheet.width)).toBe(device.width);
    });
  }

  test("sizes the map so a small phone still sees the buttons", async ({
    page,
  }) => {
    // The clamp measured in the engine that ships, at both ends of the range.
    await page.goto(await buildFixture());
    await awaitProductFont(page);

    for (const [height, lower, upper] of [
      [568, 160, 220],
      [844, 240, 320],
      [932, 280, 340],
    ] as const) {
      await page.setViewportSize({ width: 390, height });
      const mapHeight = await page
        .getByTestId("sheet-map")
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(Math.round(mapHeight), `map at ${height}px tall`).toBeGreaterThanOrEqual(
        lower,
      );
      expect(Math.round(mapHeight), `map at ${height}px tall`).toBeLessThanOrEqual(
        upper,
      );
    }
  });

  test("paints the footer on a fully opaque surface", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await buildFixture());
    await awaitProductFont(page);

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

/**
 * The same surface as an onboarding STEP.
 *
 * QA photographed the pin step with the app's back arrow, avatar and the
 * Now / People / Links strip sitting above it: "onboarding screen mein yeh nav
 * bar dikhna hi nahi chahiye". A bottom sheet capped at 92% of the screen can
 * never cover the top 8%, and that 8% is where the app's chrome lives.
 *
 * This is the half a class assertion cannot reach. The JSDOM sibling proves
 * the surface renders `max-h-none` and `top-0`; only a browser can prove that
 * the box those produce actually starts at y=0 -- and the first attempt did
 * NOT, because tailwind-merge could not parse the 92% cap and left both
 * classes standing.
 */
test.describe("Save-location surface as an onboarding takeover", () => {
  for (const width of SHEET_FULL_BLEED_WIDTHS) {
    test(`covers the whole screen at ${width}px`, async ({ page }) => {
      const height = 844;
      await page.setViewportSize({ width, height });
      await page.goto(await buildFixture({ takeover: true }));
      await awaitProductFont(page);

      const surface = await boxOf(page, "save-location-modal");

      // Nothing of the app is left showing above it.
      expect(surface.y, `top edge at ${width}px`).toBeLessThanOrEqual(0.5);
      expect(surface.height, `height at ${width}px`).toBeGreaterThanOrEqual(
        height - 0.5,
      );
      // Still full-bleed, as the bottom sheet already was.
      expect(surface.x).toBeLessThanOrEqual(0.5);
      expect(surface.width).toBeGreaterThanOrEqual(width - 0.5);
    });
  }

  test("the bottom sheet it replaces really did leave the top showing", async ({
    page,
  }) => {
    // Mutation check. Without it the assertions above could be passing on a
    // rule incapable of failing -- and this is the exact gap QA photographed.
    const height = 844;
    await page.setViewportSize({ width: 390, height });
    await page.goto(await buildFixture());
    await awaitProductFont(page);

    const surface = await boxOf(page, "save-location-modal");

    // 92% of 844 is 776, so ~68px of app chrome stayed visible above it.
    expect(
      surface.y,
      "the shipped sheet started well below the top of the screen",
    ).toBeGreaterThan(32);
    expect(surface.height).toBeLessThan(height);
  });
});
