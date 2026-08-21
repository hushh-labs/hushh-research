import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import { awaitProductFont, productFontStyle } from "./fixtures/product-font";
import {
  DURATION_WHEEL_FRAME_CLASS,
  DURATION_WHEEL_ITEM_HEIGHT_PX,
} from "../components/one-location/redesign/duration-wheel-picker";
import {
  DURATION_CUSTOM_VISIBLE_ROWS,
  DURATION_CELL_CLASS,
  DURATION_CELL_OFF_CLASS,
  DURATION_CELL_ON_CLASS,
  DURATION_GRID_CLASS,
  SHARE_DURATION_LADDER,
} from "../components/one-location/redesign/duration-presets";

/**
 * The Share-location duration ladder, measured in a real browser.
 *
 * The sibling JSDOM tests prove the component emits the right values and
 * carries the right classes. They cannot prove what those classes DO, because
 * JSDOM performs no layout — and every failure this file guards against is a
 * pixel one:
 *
 *   - a 44pt tap target that is really 36px (`h-9` is what the surrounding
 *     chips use, and what the old "Until I stop" toggle was)
 *   - "Until I stop" clipped inside a compact iPhone cell at 320px
 *   - the compact grid reflowing to three rows on an iPhone SE because one
 *     label wrapped or a fifth choice slipped back in
 *   - the whole control creeping back toward the 306px the founder called
 *     "taking much space"
 *
 * Class strings are IMPORTED from the component, not hand-copied, so the
 * markup measured here cannot drift away from the markup that ships.
 *
 * Run with: npx playwright test e2e/one-location-duration-ladder.layout.spec.ts --project=chromium
 */

/** iPhone SE (1st gen) through iPhone Pro Max. iOS is where the users are. */
const WIDTHS = [320, 375, 390, 430] as const;

/**
 * Tablet and desktop, which the phone widths above cannot speak for: from `sm`
 * the ladder stops being a grid.
 */
const WIDE_WIDTHS = [768, 1024, 1440] as const;

/**
 * The widest a single duration chip may be on a desktop.
 *
 * A fixed grid inside the 880px Location shell stretched each cell to 258px,
 * and inside the wider Share card to 440px — short labels printed across slabs
 * half a screen wide, in the founder's words "not looking good". Content-sized
 * chips stay around the actual label width.
 */
const WIDE_MAX_CELL_WIDTH_PX = 170;

/**
 * The collapsed control on a desktop: label/hint row 20 + gap 10 + one 44px
 * row of chips = 74. Slack for sub-pixel line boxes. Two rows would be 126 and
 * fail — which is the point.
 */
const WIDE_COLLAPSED_MAX_HEIGHT_PX = 84;

/**
 * The collapsed control's budget, in CSS px:
 *   label/hint row 20 + gap 10 + row 44 + gap 8 + row 44
 * = 126. Four px of slack for sub-pixel line boxes.
 */
const COLLAPSED_MAX_HEIGHT_PX = 130;

/**
 * Custom open: the collapsed ladder + gap 8 + pt-1 4 + a 3-row wheel 120 = 310.
 * This state is the one that can push "Start sharing" back down the page, so it
 * gets its own ceiling. Shipping the Custom wheel at the default 5 rows would be
 * 390 and fail here.
 *
 * Was 366, for a 44px "Done" row plus its 8px gap. That button confirmed
 * nothing — the wheel emits on every settle, so the value was already chosen —
 * and it was 52px on the tallest state of the tallest control on a screen the
 * founder called too busy. The ceiling comes down with it, or the next 52px of
 * creep lands silently in the space it left.
 */
const EXPANDED_MAX_HEIGHT_PX = 314;

/** Derived from the component, never hand-copied: 3 rows x 40px = 120. */
const CUSTOM_WHEEL_HEIGHT_PX =
  DURATION_CUSTOM_VISIBLE_ROWS * DURATION_WHEEL_ITEM_HEIGHT_PX;

/** The longest string the hint can ever render — a >=12h share on a Sunday. */
const LONGEST_HINT = "Ends 11:59 PM Sun";

/** Compile just the utilities this fixture uses, with the real Tailwind. */
async function buildFixture(customOpen = false): Promise<string> {
  // Playwright runs from the webapp root (its config lives there).
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as { compile: (css: string, opts: unknown) => Promise<{ build: (c: string[]) => string }> };

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

  const harnessClasses =
    "p-4 space-y-2 space-y-2.5 flex items-baseline justify-between gap-3 " +
    "text-sm font-semibold shrink-0 text-right text-xs w-full col-span-3";
  const classes = `${DURATION_GRID_CLASS} ${DURATION_CELL_CLASS} ${DURATION_CELL_OFF_CLASS} ${DURATION_CELL_ON_CLASS} ${DURATION_WHEEL_FRAME_CLASS} ${harnessClasses}`;
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  const cell = (label: string, on: boolean, extra = "") =>
    `<button class="${DURATION_CELL_CLASS} ${on ? DURATION_CELL_ON_CLASS : DURATION_CELL_OFF_CLASS} ${extra}" data-cell>${label}</button>`;

  const gridCells = [
    ...SHARE_DURATION_LADDER.map((rung, i) => cell(rung.label, i === 0)),
    // Widest state the Custom cell can reach: an off-grid value near the
    // 24-hour ceiling.
    cell("23h 45m", false),
  ].join("");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duration-ladder-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>${productFontStyle()}</style></head><body style="margin:0">
<!-- The real nesting: the app shell's inline gutter, then the SectionCard's
     own p-4. Measuring a bare viewport would overstate the cell width by
     64px and hide exactly the clipping this file exists to catch. -->
<!-- The Location route is AppPageShell width="agent" — an 880px measure. On a
     desktop viewport the card is that wide, not the window, and measuring the
     bare window would report cells 500px wider than the ones that ship. -->
<div style="padding-left:16px;padding-right:16px;max-width:880px;margin:0 auto" data-gutter>
  <section class="p-4" data-card>
    <div class="space-y-2.5" data-control>
      <div class="flex items-baseline justify-between gap-3">
        <p class="text-sm font-semibold" data-label>How long</p>
        <p class="text-xs shrink-0 text-right" data-hint>${LONGEST_HINT}</p>
      </div>
      <div data-ladder class="space-y-2">
        <div class="${DURATION_GRID_CLASS}" data-grid>${gridCells}${cell(
          "Until I stop",
          false,
        )}</div>
        ${
          customOpen
            ? `<div class="space-y-2 pt-1">
                 <div class="${DURATION_WHEEL_FRAME_CLASS}" data-wheel style="height:${CUSTOM_WHEEL_HEIGHT_PX}px"></div>
               </div>`
            : ""
        }
      </div>
    </div>
  </section>
</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/**
 * The nearby Check-in sheet reuses these exact cell classes for its "Stay
 * visible for" pills. It used to render morphy <Button>s at size="default",
 * which are 50px tall with a 17px label — 6px and 2px more than this app's own
 * duration control, on a sheet the founder asked to make smaller. Measuring
 * them here, against the same constants, is what stops the two drifting again.
 */
test.describe("Check-in duration pills reuse the ladder cell", () => {
  for (const width of WIDTHS) {
    test(`are 44px, not 50px, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture(false));
      await awaitProductFont(page);

      const cells = await page.evaluate(() => {
        return [...document.querySelectorAll("[data-grid] > button")].map((el) => {
          const cs = getComputedStyle(el as HTMLElement);
          const box = el.getBoundingClientRect();
          return {
            height: Math.round(box.height * 100) / 100,
            minHeight: cs.minHeight,
            fontSize: cs.fontSize,
            scrollWidth: (el as HTMLElement).scrollWidth,
            clientWidth: (el as HTMLElement).clientWidth,
          };
        });
      });

      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        // The compact height this control settled on, and the one the check-in
        // sheet now shares. 50px is the morphy default it must not drift back to.
        expect(cell.height).toBeLessThanOrEqual(45);
        expect(cell.height).toBeGreaterThanOrEqual(43.5);
        expect(cell.fontSize).toBe("15px");
        // Still a real touch target.
        expect(parseFloat(cell.minHeight)).toBeGreaterThanOrEqual(44);
        // And the label still fits at the narrowest phone.
        expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);
      }
    });
  }
});

test.describe("One Location duration ladder layout", () => {
  for (const width of WIDTHS) {
    test(`fits, stays tappable and stays two rows at ${width}px`, async ({
      page,
    }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const cells = Array.from(
          document.querySelectorAll<HTMLElement>("[data-cell]"),
        ).map((node) => {
          const box = node.getBoundingClientRect();
          // Line boxes of the label's own text, not of the button. The
          // button is a 44px flex box whose scrollHeight says nothing about
          // whether the text inside it wrapped; a Range over its contents
          // reports one rect per rendered line.
          const range = document.createRange();
          range.selectNodeContents(node);
          const lineBoxes = range.getClientRects().length;
          return {
            text: node.textContent ?? "",
            height: box.height,
            width: box.width,
            top: Math.round(box.top),
            right: box.right,
            // A label that does not fit is not visibly cut off by default —
            // it silently overflows or wraps. Both show up here.
            clipped: node.scrollWidth > node.clientWidth + 1,
            lineBoxes,
          };
        });
        const grid = document.querySelector("[data-grid]")!.getBoundingClientRect();
        const control = document.querySelector("[data-control]")!.getBoundingClientRect();
        const card = document.querySelector("[data-card]")!.getBoundingClientRect();
        const label = document.querySelector("[data-label]")!.getBoundingClientRect();
        const hint = document.querySelector("[data-hint]")!.getBoundingClientRect();
        const untilStop = cells[cells.length - 1];
        const root = document.documentElement;
        return {
          cells,
          gridWidth: grid.width,
          controlHeight: control.height,
          cardRight: card.right,
          labelRight: label.right,
          hintLeft: hint.left,
          hintRight: hint.right,
          untilStopWidth: untilStop.width,
          pageOverflow:
            Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
        };
      });

      // L1 — Apple's 44pt minimum. The old toggle was 36px.
      for (const cell of measured.cells) {
        expect(
          cell.height,
          `"${cell.text}" is only ${cell.height}px tall`,
        ).toBeGreaterThanOrEqual(44);
      }

      // L2/L4 — no label may clip or wrap.
      for (const cell of measured.cells) {
        expect(cell.clipped, `"${cell.text}" is clipped`).toBe(false);
        expect(
          cell.lineBoxes,
          `"${cell.text}" rendered on ${cell.lineBoxes} lines`,
        ).toBe(1);
      }

      // L3 — the compact choices stay in exactly two rows. A wrapped label or
      // extra preset reflows them to three and the control silently grows 52px.
      const gridRows = new Set(measured.cells.map((c) => c.top));
      expect(gridRows.size).toBe(2);

      // L5 — nothing pushes the page sideways at any width.
      expect(measured.pageOverflow).toBeLessThanOrEqual(1);
      for (const cell of measured.cells) {
        expect(cell.right).toBeLessThanOrEqual(measured.cardRight + 1);
      }

      // L6 — label and hint share one line without colliding, with the hint
      // at its longest.
      expect(measured.labelRight).toBeLessThan(measured.hintLeft);
      expect(measured.hintRight).toBeLessThanOrEqual(measured.cardRight + 1);

      // L7 — the budget. This is the founder's actual complaint, in a number.
      expect(measured.controlHeight).toBeLessThanOrEqual(COLLAPSED_MAX_HEIGHT_PX);

      // L9 — the open-ended rung stays a peer in the same 2x2 grid, not a
      // detached full-width bar.
      expect(measured.untilStopWidth).toBeLessThanOrEqual(
        measured.gridWidth / 2 + 1,
      );

      // L10 — no React/ARIA warnings from the new markup.
      expect(consoleErrors).toEqual([]);
    });

    test(`keeps the Custom panel inside its own budget at ${width}px`, async ({
      page,
    }) => {
      // The expanded state is what can push "Start sharing" further down the
      // page, so it is measured rather than assumed. Rendered as markup here,
      // not by clicking, because this fixture is CSS-only — the click path is
      // covered by the sibling JSDOM test ("does not mount the wheel until
      // Custom is tapped").
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture(true));
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const control = document.querySelector("[data-control]")!.getBoundingClientRect();
        const wheel = document.querySelector("[data-wheel]")!.getBoundingClientRect();
        const root = document.documentElement;
        return {
          controlHeight: control.height,
          wheelHeight: wheel.height,
          pageOverflow:
            Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
        };
      });

      // 3 rows x 40px. The default 5-row wheel is 200 and would blow the
      // budget below by 80px.
      expect(measured.wheelHeight).toBe(CUSTOM_WHEEL_HEIGHT_PX);
      expect(CUSTOM_WHEEL_HEIGHT_PX).toBeLessThanOrEqual(120);
      expect(measured.controlHeight).toBeLessThanOrEqual(EXPANDED_MAX_HEIGHT_PX);
      expect(measured.pageOverflow).toBeLessThanOrEqual(1);
    });
  }
});

/**
 * The desktop half of the same control.
 *
 * The founder's screenshots of "How long" came from a browser, not a phone:
 * three columns of 258–440px slabs, a full-width bar under them, and a 260px
 * wheel floating in the middle of the card when Custom was open. None of the
 * phone widths above can catch that — a stretched grid cell is only wrong once
 * there is width to stretch into.
 */
test.describe("One Location duration ladder on a desktop", () => {
  for (const width of WIDE_WIDTHS) {
    test(`is one row of chips, not a grid of slabs, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const cells = Array.from(
          document.querySelectorAll<HTMLElement>("[data-cell]"),
        ).map((node) => {
          const box = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          return {
            text: node.textContent ?? "",
            width: +box.width.toFixed(2),
            height: +box.height.toFixed(2),
            top: Math.round(box.top),
            clipped: node.scrollWidth > node.clientWidth + 1,
            lineBoxes: range.getClientRects().length,
          };
        });
        const control = document
          .querySelector("[data-control]")!
          .getBoundingClientRect();
        return { cells, controlHeight: +control.height.toFixed(2) };
      });

      // Every rung, including the open-ended one, on a single line.
      const rows = new Set(measured.cells.map((cell) => cell.top));
      expect(
        rows.size,
        `the ladder wrapped to ${rows.size} rows at ${width}px`,
      ).toBe(1);

      for (const cell of measured.cells) {
        expect(
          cell.width,
          `"${cell.text}" is ${cell.width}px wide — a slab, not a chip`,
        ).toBeLessThanOrEqual(WIDE_MAX_CELL_WIDTH_PX);
        // Still the same 44pt target and the same unwrapped label.
        expect(cell.height).toBeGreaterThanOrEqual(44);
        expect(cell.clipped, `"${cell.text}" is clipped`).toBe(false);
        expect(cell.lineBoxes).toBe(1);
      }

      expect(measured.controlHeight).toBeLessThanOrEqual(
        WIDE_COLLAPSED_MAX_HEIGHT_PX,
      );
    });

    test(`keeps the Custom wheel beside the ladder, not centred, at ${width}px`, async ({
      page,
    }) => {
      // `mx-auto` put a 260px wheel in the middle of a 790px card, with ~265px
      // of dead space on either side. It reads as a gap in the screen rather
      // than as part of the control that opened it.
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture(true));
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const ladder = document
          .querySelector("[data-grid]")!
          .getBoundingClientRect();
        const wheel = document
          .querySelector("[data-wheel]")!
          .getBoundingClientRect();
        return {
          ladderLeft: +ladder.left.toFixed(2),
          wheelLeft: +wheel.left.toFixed(2),
        };
      });

      expect(
        measured.wheelLeft,
        `the wheel starts ${measured.wheelLeft - measured.ladderLeft}px right of the ladder it belongs to`,
      ).toBeLessThanOrEqual(measured.ladderLeft + 1);
    });
  }
});
