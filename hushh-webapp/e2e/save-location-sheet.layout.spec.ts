import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  ADDRESS_LABEL_ROW_CLASSNAME,
  DOOR_DETAILS_TOGGLE_CLASSNAME,
  REQUIRED_BADGE_CLASSNAME,
  SHEET_BODY_CLASSNAME,
  SHEET_DETAILS_SHELL_CLASSNAME,
  SHEET_FOOTER_CLASSNAME,
  SHEET_HEADER_CLASSNAME,
  SHEET_INDICATOR_SLOT_CLASSNAME,
  SHEET_LAYOUT_WIDTHS,
  STEP_DOT_MIN_CONTRAST,
  STEP_DOT_REACHED_CLASSNAME,
  STEP_DOT_UPCOMING_CLASSNAME,
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
  // #5396 — the step rail, built from the component's own exported strings.
  const dotSlot = SHEET_INDICATOR_SLOT_CLASSNAME;
  const dotTab =
    "relative flex h-[18px] w-11 items-center justify-center after:h-11 after:w-11";
  const dotPill = "block h-[5px] rounded-full";
  const dotActive = "w-[24px]";
  const dotSmall = "w-[7px]";

  /**
   * Split from its margin on purpose. This fixture writes raw class strings
   * with no `cn()` behind them, so `"... mb-1.5 ... mb-0"` would leave BOTH
   * rules standing and the stylesheet order would decide -- which is not what
   * the component does. It composes the Address label with `cn(...)`, and
   * tailwind-merge drops the margin outright.
   */
  const label = "block text-[13px] font-semibold leading-[18px]";

  const classes = [
    shell,
    SHEET_DETAILS_SHELL_CLASSNAME,
    SHEET_HEADER_CLASSNAME,
    SHEET_BODY_CLASSNAME,
    SHEET_FOOTER_CLASSNAME,
    ADDRESS_LABEL_ROW_CLASSNAME,
    REQUIRED_BADGE_CLASSNAME,
    DOOR_DETAILS_TOGGLE_CLASSNAME,
    row,
    button,
    title,
    field,
    label,
    primary,
    secondary,
    dotSlot,
    dotTab,
    dotPill,
    dotActive,
    dotSmall,
    STEP_DOT_REACHED_CLASSNAME,
    STEP_DOT_UPCOMING_CLASSNAME,
    "mt-1 space-y-3.5 mb-1.5 mb-0 block",
  ].join(" ");
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  // The Address row: the one label on this sheet that shares its line with
  // something else, so the one that a narrow phone can break.
  const addressRow =
    `<div class="${ADDRESS_LABEL_ROW_CLASSNAME}">` +
    `<label class="${label}" data-testid="address-label">Address</label>` +
    `<span class="${REQUIRED_BADGE_CLASSNAME}" data-testid="address-required-badge">Required</span>` +
    `</div>` +
    `<input class="${field}" data-testid="sheet-field" value="Kartavya Path, New Delhi, Delhi 110001, India">`;

  // The progressive-disclosure row. A control, so it owes 44px.
  const doorDetails =
    `<button class="${DOOR_DETAILS_TOGGLE_CLASSNAME}" data-testid="door-details-toggle">` +
    `<span class="text-[15px] font-semibold leading-5" data-testid="door-details-label">More door details</span>` +
    `<span aria-hidden>v</span>` +
    `</button>`;

  // Enough fields to overflow every width under test, so the body genuinely
  // has to scroll -- a footer only bleeds when there is something behind it.
  const fields =
    addressRow +
    Array.from(
      { length: 8 },
      (_, i) =>
        `<div><label class="${label} mb-1.5">Field ${i + 1}</label>` +
        `<input class="${field}" data-testid="sheet-field" value="Value ${i + 1}"></div>`,
    ).join("") +
    doorDetails;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "save-location-sheet-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>:root{--app-separator:#e5e5ea;--app-card-surface-default-solid:#fff;--app-neutral-fill-strong:rgba(120,120,128,0.2);--app-accent:#007aff}</style>
</head><body style="margin:0;background:#111">
<div class="${shell} ${SHEET_DETAILS_SHELL_CLASSNAME}" data-testid="save-location-modal">
  <header class="${SHEET_HEADER_CLASSNAME}" data-testid="sheet-header">
    <div class="${dotSlot}" data-testid="sheet-indicator">
      <div class="flex items-center justify-center gap-1">
        <button class="${dotTab}" data-testid="step-dot-completed" data-step-state="completed"><span class="${dotPill} ${dotSmall} ${STEP_DOT_REACHED_CLASSNAME}" data-testid="step-pill-completed"></span></button>
        <button class="${dotTab}" data-testid="step-dot-active" data-step-state="active"><span class="${dotPill} ${dotActive} ${STEP_DOT_REACHED_CLASSNAME}" data-testid="step-pill-active"></span></button>
        <button class="${dotTab}" data-testid="step-dot-upcoming" data-step-state="upcoming"><span class="${dotPill} ${dotSmall} ${STEP_DOT_UPCOMING_CLASSNAME}" data-testid="step-pill-upcoming"></span></button>
      </div>
    </div>
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

    test(`keeps the Required badge whole beside the Address label at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const body = await boxOf(page, "sheet-body");
      const label = await boxOf(page, "address-label");
      const badge = await boxOf(page, "address-required-badge");

      // One line, in order, not stacked and not overlapping. Measured on the
      // centres, because the row centre-aligns two boxes of different heights
      // -- their top edges are not meant to agree.
      expect(
        Math.abs(label.y + label.height / 2 - (badge.y + badge.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(Math.round(label.x + label.width)).toBeLessThanOrEqual(
        Math.round(badge.x),
      );
      // And still inside the sheet, rather than pushed off its right edge.
      expect(Math.round(badge.x + badge.width)).toBeLessThanOrEqual(
        Math.round(body.x + body.width),
      );

      // Neither word is clipped. The badge is the field's only visible
      // statement that it is mandatory; a "Requir…" is not one.
      const clipped = await page.evaluate(() =>
        ["address-label", "address-required-badge"]
          .map((id) => document.querySelector(`[data-testid="${id}"]`)!)
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.getAttribute("data-testid")),
      );
      expect(clipped).toEqual([]);
    });

    test(`gives the door-details row a real 44px at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const body = await boxOf(page, "sheet-body");
      const toggle = await boxOf(page, "door-details-toggle");

      expect(toggle.height).toBeGreaterThanOrEqual(44);
      expect(Math.round(toggle.x + toggle.width)).toBeLessThanOrEqual(
        Math.round(body.x + body.width),
      );

      const labelClipped = await page
        .getByTestId("door-details-label")
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(labelClipped).toBe(false);
    });
  }

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

  /*
   * #5396. The sibling JSDOM tests prove the component emits these class
   * strings and the right per-step state. They cannot prove a colour: JSDOM
   * performs no layout and resolves no cascade, and the failing value was a
   * ratio, not a class name.
   *
   * Both readings go through a canvas rather than a regex on the computed
   * string. Tailwind alpha utilities resolve to `color-mix(in oklab, ...)`,
   * so a test pattern-matching `rgba(...)` passes the very translucent value
   * it was written to reject -- the exact trap the footer test above records.
   */
  const SHEET_SURFACES = [
    { theme: "light", surface: "#ffffff" },
    { theme: "dark", surface: "#2c2c2e" },
  ] as const;

  for (const { theme, surface } of SHEET_SURFACES) {
    test(`keeps every step dot readable on the ${theme} sheet`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);
      await page.evaluate((value) => {
        document.documentElement.style.setProperty(
          "--app-card-surface-default-solid",
          value,
        );
        document.documentElement.style.setProperty("--app-accent", "#007aff");
      }, surface);

      const measure = async (testId: string) =>
        page.getByTestId(testId).evaluate((el) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          ctx.clearRect(0, 0, 1, 1);
          // Seeded transparent: a colour the canvas cannot parse leaves alpha
          // at 0 and fails loudly instead of reading as an opaque black.
          ctx.fillStyle = "rgba(0, 0, 0, 0)";
          ctx.fillStyle = getComputedStyle(el).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return { r, g, b, a };
        });

      const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const [lr, lg, lb] = [r, g, b].map((raw) => {
          const c = raw / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      };
      const ratioAgainstSheet = (pixel: {
        r: number;
        g: number;
        b: number;
      }) => {
        const sheet = {
          r: Number.parseInt(surface.slice(1, 3), 16),
          g: Number.parseInt(surface.slice(3, 5), 16),
          b: Number.parseInt(surface.slice(5, 7), 16),
        };
        const [high, low] = [luminance(pixel), luminance(sheet)].sort(
          (x, y) => y - x,
        );
        return (high + 0.05) / (low + 0.05);
      };

      for (const state of ["completed", "active", "upcoming"] as const) {
        const pixel = await measure(`step-pill-${state}`);
        // Fully opaque: the old fill was a 20%/36% alpha that composited
        // almost into the sheet, which is what made it invisible.
        expect(pixel.a, `${theme}/${state} dot must be opaque`).toBe(255);
        const ratio = ratioAgainstSheet(pixel);
        expect(
          `${theme}/${state} ${ratio.toFixed(2)}:1`,
          `${theme}/${state} must clear ${STEP_DOT_MIN_CONTRAST}:1 on ${surface}`,
        ).toBe(
          `${theme}/${state} ${Math.max(ratio, STEP_DOT_MIN_CONTRAST).toFixed(2)}:1`,
        );
      }

      // Reached and not-reached must also differ from EACH OTHER, or the
      // rail communicates nothing however visible each dot is on its own.
      const completed = await measure("step-pill-completed");
      const upcoming = await measure("step-pill-upcoming");
      expect(
        `${completed.r},${completed.g},${completed.b}`,
      ).not.toBe(`${upcoming.r},${upcoming.g},${upcoming.b}`);
    });
  }

  test("renders the step rail at one height in the pinned header", async ({
    page,
  }) => {
    // The rail used to be 44px tall at the bottom of one pane and 18px tall
    // at the top of another, so it moved and resized between two steps.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await buildFixture());
    await awaitProductFont(page);

    const header = await boxOf(page, "sheet-header");
    const indicator = await boxOf(page, "sheet-indicator");
    expect(indicator.height).toBe(18);
    expect(indicator.y).toBeGreaterThanOrEqual(header.y);
    expect(indicator.y + indicator.height).toBeLessThanOrEqual(
      header.y + header.height,
    );

    // Every tab keeps a real, laid-out 44px of horizontal separation, so an
    // edge tap cannot land on the neighbouring step.
    const boxes = await Promise.all(
      (["completed", "active", "upcoming"] as const).map((state) =>
        boxOf(page, `step-dot-${state}`),
      ),
    );
    for (const box of boxes) expect(box.width).toBe(44);
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i].x).toBeGreaterThanOrEqual(
        boxes[i - 1].x + boxes[i - 1].width,
      );
    }
  });
});
