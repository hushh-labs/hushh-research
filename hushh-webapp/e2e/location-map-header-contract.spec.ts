/**
 * Geometry contract for the Location map header.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A UNIT TEST
 * ----------------------------------------------
 * The header shipped with `grid-cols-[1fr_auto_1fr]`, which pads the narrow
 * outer column to match the wide one. On a 375px phone that spent ~95px on
 * empty space and squeezed the Check-in pill until its label was gone -- the
 * user saw the single letter "C". Every unit test passed the whole time,
 * because jsdom has no layout: it cannot tell you that a string overflowed its
 * box. Class-name assertions cannot either; they only prove the class we
 * *intended* is present.
 *
 * So this measures real boxes in a real engine. It needs no dev server, no
 * backend and no login -- the question is purely "does this markup, under this
 * stylesheet, fit at this width", and that is answerable from the compiled CSS
 * alone. That matters: the app's other e2e specs need REVIEWER_UID and a vault
 * passphrase, so they can never guard this.
 *
 * The class strings are IMPORTED from the module the component uses, never
 * re-typed here. A copied string would drift from the shipped one and the gate
 * would quietly start measuring nothing. (Relative path, not the `@/` alias:
 * Playwright's transform does not resolve tsconfig path aliases.)
 */
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

import {
  MAP_HEADER_ACTIONS_CELL_CLASSNAME,
  MAP_HEADER_CLASSNAME,
  MAP_HEADER_CLOSE_CELL_CLASSNAME,
  MAP_HEADER_STATUS_CELL_CLASSNAME,
  MAP_HEADER_SINGLE_ROW_MIN_WIDTH,
} from "../lib/one-location/map-header-layout";

/** Real device widths, smallest supported phone through desktop. */
const WIDTHS = [320, 360, 375, 390, 430, 768, 1280] as const;

/** Platform minimum for a touch target. */
const MIN_TOUCH_TARGET = 44;

const ICON_BUTTON =
  "relative isolate inline-flex touch-manipulation overflow-hidden rounded-full border shadow-lg backdrop-blur-md h-9 w-9 items-center justify-center pointer-events-auto !h-14 !w-14";
const PILL =
  "relative isolate inline-flex touch-manipulation overflow-hidden rounded-full border shadow-lg backdrop-blur-md h-9 min-w-0 max-w-full items-center justify-center gap-1.5 px-3.5 text-[14px] font-semibold sm:gap-2 sm:px-4 sm:text-base pointer-events-auto";
const SHARING_PILL =
  "pointer-events-auto flex min-w-0 shrink items-center gap-1.5 truncate rounded-full border bg-background/85 px-3 py-1.5 text-[12px] font-semibold shadow-lg backdrop-blur-md";

function headerMarkup(): string {
  return `
<div style="position:relative;height:100dvh;width:100%;overflow:hidden">
  <header id="hdr" class="${MAP_HEADER_CLASSNAME}">
    <div class="${MAP_HEADER_CLOSE_CELL_CLASSNAME}">
      <span class="relative inline-flex shrink-0 overflow-visible align-middle">
        <button id="close" class="${ICON_BUTTON}" aria-label="Back to Location">&#10005;</button>
      </span>
    </div>
    <div class="${MAP_HEADER_STATUS_CELL_CLASSNAME}">
      <button id="sharing" class="${SHARING_PILL}">
        <span style="height:6px;width:6px;flex-shrink:0;border-radius:9999px;background:#0071E3"></span>
        <span id="sharingLabel" class="truncate">Sharing with 2</span>
      </button>
    </div>
    <div class="${MAP_HEADER_ACTIONS_CELL_CLASSNAME}">
      <span class="relative inline-flex overflow-visible align-middle min-w-0 shrink">
        <button id="checkin" class="${PILL}" aria-label="Check in nearby">
          <span class="pointer-events-none relative z-10 inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 sm:gap-2">
            <span style="height:16px;width:16px;flex-shrink:0;display:inline-block;background:currentColor;border-radius:3px"></span>
            <span id="checkinLabel" class="truncate">Check in</span>
          </span>
        </button>
      </span>
      <span class="relative inline-flex shrink-0 overflow-visible align-middle">
        <button id="locate" class="${ICON_BUTTON}" aria-label="Show my location">&#9678;</button>
      </span>
    </div>
  </header>
</div>`;
}

/**
 * Compile the app's real Tailwind stylesheet for exactly this markup, once.
 *
 * Memoised and given a unique scratch path per process: Playwright runs these
 * widths in parallel workers, and a shared scratch file let one worker delete
 * the file another was still scanning -- Tailwind then emitted no utilities and
 * the buttons measured 12px wide. That is a harness bug that looks exactly like
 * a product bug, so it is worth not having.
 */
let compiledPage: Promise<string> | null = null;

function compilePage(): Promise<string> {
  compiledPage ??= (async () => {
    const markup = headerMarkup();
    const scan = path.join(
      tmpdir(),
      `hushh-header-contract-${process.pid}.html`,
    );
    writeFileSync(scan, markup);
    try {
      const { css } = await postcss([tailwind()]).process(
        `@import "tailwindcss" source(none);\n@source "${scan}";`,
        { from: path.join(process.cwd(), "app/globals.css") },
      );
      return `<!doctype html><meta charset="utf-8"><style>${css}</style><style>body{margin:0;font-family:-apple-system,system-ui,sans-serif}</style>${markup}`;
    } finally {
      rmSync(scan, { force: true });
    }
  })();
  return compiledPage;
}

test.describe("Location map header geometry contract", () => {
  for (const width of WIDTHS) {
    test(`keeps every control and label intact at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.setContent(await compilePage());

      const measured = await page.evaluate(() => {
        const byId = (id: string) => document.getElementById(id)!;
        const box = (id: string) => byId(id).getBoundingClientRect();
        const clipped = (id: string) => {
          const el = byId(id);
          return el.scrollWidth > el.clientWidth + 1;
        };
        const overlaps = (a: string, b: string) =>
          box(a).bottom > box(b).top && box(b).bottom > box(a).top;
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          checkInClipped: clipped("checkinLabel"),
          checkInText: byId("checkinLabel").textContent,
          sharingClipped: clipped("sharingLabel"),
          sharingText: byId("sharingLabel").textContent,
          closeSize: [box("close").width, box("close").height],
          locateSize: [box("locate").width, box("locate").height],
          closeLeft: box("close").left,
          locateRight: box("locate").right,
          sharingSharesRowWithClose: overlaps("sharing", "close"),
        };
      });

      // Contract A -- product-owned titles never truncate. "Check in" becoming
      // "C" is the exact defect this file exists for.
      expect(
        measured.checkInClipped,
        `"Check in" was clipped at ${width}px`,
      ).toBe(false);
      expect(measured.checkInText).toBe("Check in");
      expect(
        measured.sharingClipped,
        `"Sharing with 2" was clipped at ${width}px`,
      ).toBe(false);
      expect(measured.sharingText).toBe("Sharing with 2");

      // Contract D -- no accidental horizontal overflow.
      expect(measured.documentWidth).toBeLessThanOrEqual(
        measured.viewportWidth + 1,
      );

      // Contract H -- essential controls stay operable and on screen.
      for (const [name, size] of [
        ["close", measured.closeSize],
        ["locate", measured.locateSize],
      ] as const) {
        expect(size[0], `${name} width at ${width}px`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET,
        );
        expect(size[1], `${name} height at ${width}px`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET,
        );
      }
      expect(measured.closeLeft).toBeGreaterThanOrEqual(0);
      expect(measured.locateRight).toBeLessThanOrEqual(
        measured.viewportWidth + 1,
      );

      // The structural rule that buys the space: phones give Sharing its own
      // row; the desktop true-centre layout is unchanged.
      expect(
        measured.sharingSharesRowWithClose,
        `Sharing row placement at ${width}px`,
      ).toBe(width >= MAP_HEADER_SINGLE_ROW_MIN_WIDTH);
    });
  }
});
