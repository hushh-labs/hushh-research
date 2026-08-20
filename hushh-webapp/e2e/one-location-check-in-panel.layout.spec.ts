import { expect, test, type Page } from "@playwright/test";
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
  CHECK_IN_CATEGORY_ROW_CLASSNAME,
  CHECK_IN_PANEL_DESKTOP_WIDTH_REM,
  CHECK_IN_PLACE_DISTANCE_CLASSNAME,
  CHECK_IN_PLACE_META_CLASSNAME,
  CHECK_IN_PLACE_NAME_CLASSNAME,
  CHECK_IN_PLACE_ROW_CLASSNAME,
  CHECK_IN_PLACE_ROW_OFF_CLASSNAME,
  CHECK_IN_PLACE_ROW_ON_CLASSNAME,
  CHECK_OUT_BUTTON_VARIANT,
} from "../components/one-location/nearby-check-in/check-in-panel-layout";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";

/**
 * The nearby Check-In panel, measured in a real browser.
 *
 * The sibling JSDOM suite proves this panel renders the right words and calls
 * the right service methods. It cannot prove any of the four things this file
 * exists for, because JSDOM applies no CSS and measures every box as 0x0:
 *
 *   1. "Check out" is not painted destructive red. A `className` assertion
 *      cannot see that — every button in this system carries
 *      `aria-invalid:ring-destructive/20` in its base class, so a substring
 *      check passes on a red button. Only the computed background proves it.
 *   2. Eight category chips stay on ONE scrollable row at 320px. Wrapped to
 *      three rows they push the place list below the fold on an iPhone SE,
 *      and the list is the thing being chosen from.
 *   3. A long venue name gives up its own width instead of pushing the
 *      distance off the row, and the distance never wraps.
 *   4. The desktop rail leaves the map the majority of the viewport. Check-in
 *      is a question about the map; a panel that outgrows it inverts the
 *      screen.
 *
 * Every class string is IMPORTED from `check-in-panel-layout`, the module the
 * sheet itself imports, so this cannot drift into measuring a replica.
 *
 * Run with: npm run test:layout-contracts
 */

/** Every common iPhone width. `sm:` is 640px, so all of these ship. */
const PHONE_WIDTHS = [320, 360, 375, 390, 430] as const;

/** Where the bottom sheet becomes the desktop side rail (`md:` is 768px). */
const DESKTOP_WIDTHS = [768, 1024, 1440, 1920] as const;

/** The app's horizontal page padding at phone widths, as a conservative floor. */
const PAGE_PADDING_PX = 16;

/** iOS Human Interface Guidelines' minimum tap target. */
const MIN_TAP_TARGET_PX = 44;

/**
 * The chip height this product already ships across Location (`size="sm"` →
 * `min-h-9`). Asserted as a floor so a future compaction cannot shrink it
 * further; it is deliberately not raised here, because these chips are the
 * same control as the Location tab strip and changing their height is a
 * different change to a different set of screens.
 */
const MIN_CHIP_HEIGHT_PX = 36;

/**
 * How wide the whole eight-chip set is allowed to be, in CSS px.
 *
 * Viewport-independent on purpose: the set's width is a property of the
 * labels, not of the screen. The shipped one-word labels measure 632px; the
 * two multi-word ones they replaced measured 765px.
 */
const MAX_CATEGORY_SCROLL_EXTENT_PX = 660;

/**
 * How many chips must be reachable at each width without scrolling at all.
 *
 * Measured against the shipped labels inside the panel's own `p-5`, which is
 * why 320px asks for three and not four: 40px of panel padding is 40px of chip
 * row. A person who can see three choices and a fourth part-way in knows to
 * swipe; one who can see two does not.
 */
const MIN_VISIBLE_CHIPS: Record<number, number> = {
  320: 3,
  360: 4,
  375: 4,
  390: 4,
  430: 5,
};

/**
 * The most of a desktop viewport the panel may take.
 *
 * At 768px the 416px rail is already 54% — that is the narrowest desktop the
 * rail appears on and the map is genuinely squeezed there, so the ceiling is
 * set at the widest the rail may ever be in ABSOLUTE terms instead, and the
 * share is asserted only from 1024px up where "the map stays dominant" is a
 * meaningful claim.
 */
const MAX_PANEL_SHARE_FROM_1024 = 0.42;

const cachedStylesheets = new Map<string, string>();

/**
 * The real stylesheet, compiled once per candidate set per worker.
 *
 * `globals.css` rather than a bare `@import "tailwindcss"`: everything measured
 * here resolves through custom properties defined there — `--app-destructive`,
 * `--app-neutral-fill`, `--app-accent`, and `ui-text-button-label`, which sets
 * the button label to 17px. Compiling without it would measure a 16px system
 * font against colours that do not exist.
 */
async function buildStylesheet(candidates: string[]): Promise<string> {
  const key = candidates.join(" ");
  const cached = cachedStylesheets.get(key);
  if (cached) return cached;

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

  // `@source` widens the scanner across the component tree for the real build.
  // Here the candidate list is explicit, so leaving them in would scan
  // thousands of files for utilities already named.
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
  const css = stripAppFontFaces(compiler.build(candidates));
  cachedStylesheets.set(key, css);
  return css;
}

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
<body style="margin:0">${body}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/**
 * The class attribute a button really carries.
 *
 * Composed through the component's own `buttonVariants` and `cn`, never by
 * concatenating strings: tailwind-merge is what decides which of two competing
 * background utilities survives, and a fixture that skipped it would measure a
 * class list the app never renders.
 */
const buttonClass = (
  variant: "default" | "secondary" | "destructive",
  size: "sm" | "default",
  className = "",
) => cn(buttonVariants({ variant, size, className }));

/** Every utility the fixtures below use that is not already in an import. */
const HARNESS_CLASSES = [
  "flex flex-col gap-4 p-5 w-full min-w-0 min-h-0 flex-1",
  "items-center justify-between gap-3 shrink-0 rounded-full",
  "text-sm font-semibold text-xs text-muted-foreground",
  "block truncate min-w-0 flex-1 mt-3 space-y-2 overflow-y-auto",
  "h-4 w-4 border relative",
].join(" ");

const CATEGORY_LABELS = [
  "All",
  "Food",
  "Health",
  "Shops",
  "Hotels",
  "Education",
  "Outdoors",
  "Transit",
];

/** The longest realistic venue name plus the longest realistic category. */
const LONGEST_PLACE = {
  name: "Aetherius Highstreet Residential Tower Block E Clubhouse",
  meta: "Apartment Building",
  distance: "487 m",
};

function placeRow(
  name: string,
  meta: string,
  distance: string,
  selected: boolean,
) {
  return `<button data-place class="${cn(
    CHECK_IN_PLACE_ROW_CLASSNAME,
    selected ? CHECK_IN_PLACE_ROW_ON_CLASSNAME : CHECK_IN_PLACE_ROW_OFF_CLASSNAME,
  )}">
  <span data-pin class="h-4 w-4 shrink-0"></span>
  <span class="min-w-0 flex-1">
    <span data-place-name class="${CHECK_IN_PLACE_NAME_CLASSNAME}">${name}</span>
    <span data-place-meta class="${CHECK_IN_PLACE_META_CLASSNAME}">${meta}</span>
  </span>
  <span data-place-distance class="${CHECK_IN_PLACE_DISTANCE_CLASSNAME}">${distance}</span>
</button>`;
}

/** The pre-check-in panel: chips, place rows, the primary action. */
const setupBody = `
<div data-panel class="flex flex-col gap-4 p-5">
  <div data-chips class="${CHECK_IN_CATEGORY_ROW_CLASSNAME}" aria-label="Nearby place categories">
    ${CATEGORY_LABELS.map(
      (label, index) =>
        `<button data-chip class="${buttonClass(
          index === 0 ? "default" : "secondary",
          "sm",
          "shrink-0 rounded-full",
        )}">${label}</button>`,
    ).join("")}
  </div>
  <div data-places class="mt-3 space-y-2">
    ${placeRow(LONGEST_PLACE.name, LONGEST_PLACE.meta, LONGEST_PLACE.distance, true)}
    ${placeRow("Making Memories", "Gift Shop", "13 m", false)}
  </div>
  <button data-check-in class="${buttonClass(
    "default",
    "default",
    "h-12 min-h-12 w-full",
  )}">Check in</button>
</div>`;

/** The checked-in panel. Its only control is the one this file is named for. */
const activeBody = `
<div data-panel class="flex flex-col gap-4 p-5">
  <button data-check-out class="${buttonClass(
    // Imported, so reinstating variant="destructive" in the component fails
    // here rather than silently shipping.
    CHECK_OUT_BUTTON_VARIANT === "secondary" ? "secondary" : "destructive",
    "default",
    "w-full",
  )}">Check out</button>
  <button data-destructive-reference class="${buttonClass(
    "destructive",
    "default",
    "w-full",
  )}">Reference</button>
</div>`;

const CANDIDATES = [
  HARNESS_CLASSES,
  CHECK_IN_CATEGORY_ROW_CLASSNAME,
  CHECK_IN_PLACE_ROW_CLASSNAME,
  CHECK_IN_PLACE_ROW_OFF_CLASSNAME,
  CHECK_IN_PLACE_ROW_ON_CLASSNAME,
  CHECK_IN_PLACE_NAME_CLASSNAME,
  CHECK_IN_PLACE_META_CLASSNAME,
  CHECK_IN_PLACE_DISTANCE_CLASSNAME,
  buttonClass("default", "sm", "shrink-0 rounded-full"),
  buttonClass("secondary", "sm", "shrink-0 rounded-full"),
  buttonClass("default", "default", "h-12 min-h-12 w-full"),
  buttonClass("secondary", "default", "w-full"),
  buttonClass("destructive", "default", "w-full"),
]
  .join(" ")
  .split(/\s+/)
  .filter(Boolean);

const fontsReady = (page: Page) =>
  page.evaluate(() => document.fonts.ready.then(() => undefined));

async function openSetup(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(
    await buildFixture(
      "check-in-panel-setup",
      `<div style="width:${width - PAGE_PADDING_PX * 2}px;margin:0 auto">${setupBody}</div>`,
      CANDIDATES,
    ),
  );
  await awaitProductFont(page);
  await fontsReady(page);
}

// ---------------------------------------------------------------------------
// 1. Check out is a normal action, not a destructive one
// ---------------------------------------------------------------------------

test.describe("Check out is not painted as destruction", () => {
  test("renders the neutral fill, not the destructive one", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      await buildFixture("check-in-panel-active", activeBody, CANDIDATES),
    );
    await awaitProductFont(page);
    await fontsReady(page);

    const measured = await page.evaluate(() => {
      const read = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`missing ${selector}`);
        const cs = getComputedStyle(el as HTMLElement);
        return { background: cs.backgroundColor, color: cs.color };
      };
      const root = getComputedStyle(document.documentElement);
      return {
        checkOut: read("[data-check-out]"),
        destructive: read("[data-destructive-reference]"),
        neutralToken: root.getPropertyValue("--app-neutral-fill").trim(),
        destructiveToken: root.getPropertyValue("--app-destructive").trim(),
      };
    });

    // Both tokens must exist, or the comparison below proves nothing.
    expect(measured.neutralToken).not.toBe("");
    expect(measured.destructiveToken).not.toBe("");

    // The reference button IS red — this is the control that shows the
    // assertion can tell the two apart at all.
    expect(measured.destructive.background).not.toBe(
      measured.checkOut.background,
    );
    expect(measured.checkOut.background).not.toBe(
      measured.destructive.background,
    );

    // And it is not white-on-solid, the destructive foreground pairing.
    expect(measured.checkOut.color).not.toBe("rgb(255, 255, 255)");

    // The red channel of a destructive fill dominates; a neutral fill does not.
    const channels = (value: string) =>
      (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const [checkOutR, checkOutG, checkOutB] = channels(
      measured.checkOut.background,
    );
    expect(checkOutR - Math.max(checkOutG, checkOutB)).toBeLessThan(24);
  });
});

// ---------------------------------------------------------------------------
// 2. Eight category chips, one scrollable row, no clipping
// ---------------------------------------------------------------------------

test.describe("Category chips stay on one usable row", () => {
  for (const width of PHONE_WIDTHS) {
    test(`are one scrollable row at ${width}px`, async ({ page }) => {
      await openSetup(page, width);

      const chips = await page.evaluate(() =>
        [...document.querySelectorAll("[data-chip]")].map((el) => {
          const node = el as HTMLElement;
          const box = node.getBoundingClientRect();
          return {
            label: node.textContent?.trim() ?? "",
            top: Math.round(box.top * 100) / 100,
            height: Math.round(box.height * 100) / 100,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          };
        }),
      );

      expect(chips).toHaveLength(CATEGORY_LABELS.length);

      // One row: every chip shares a top edge. Only `flex-wrap` breaks this.
      expect(new Set(chips.map((chip) => chip.top)).size).toBe(1);

      for (const chip of chips) {
        // No label clipped inside its own chip.
        expect(
          chip.scrollWidth,
          `${chip.label} clips at ${width}px`,
        ).toBeLessThanOrEqual(chip.clientWidth + 1);
        expect(
          chip.height,
          `${chip.label} is under the shipped chip height`,
        ).toBeGreaterThanOrEqual(MIN_CHIP_HEIGHT_PX);
      }

      // The row itself scrolls rather than overflowing the panel.
      const row = await page.evaluate(() => {
        const node = document.querySelector("[data-chips]") as HTMLElement;
        const panel = document.querySelector("[data-panel]") as HTMLElement;
        const rowBox = node.getBoundingClientRect();
        return {
          overflowX: getComputedStyle(node).overflowX,
          right: rowBox.right,
          panelRight: panel.getBoundingClientRect().right,
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          // How many chips a person can reach without scrolling at all.
          fullyVisible: [...node.querySelectorAll("[data-chip]")].filter(
            (chip) => chip.getBoundingClientRect().right <= rowBox.right + 0.5,
          ).length,
        };
      });
      expect(["auto", "scroll"]).toContain(row.overflowX);
      expect(row.right).toBeLessThanOrEqual(row.panelRight + 1);

      // The two assertions that actually bind the labels.
      //
      // A flex row with `overflow-x-auto` never wraps, so "one row" above can
      // only ever catch someone adding `flex-wrap`. What a long label really
      // costs is REACH, and both numbers below were measured rather than
      // assumed. Shipped one-word labels: 632px of scroll extent, and 3/4/4/4/5
      // chips in view across the five widths. Restoring "Food & drink" and
      // "Shops & services": 765px, and 2/3/3/3/4 chips. Every one of the ten
      // numbers moves the wrong way, so this block fails at all five widths on
      // that mutation — verified.
      expect(
        row.scrollWidth,
        "the whole chip set got wider",
      ).toBeLessThanOrEqual(MAX_CATEGORY_SCROLL_EXTENT_PX);
      expect(
        row.fullyVisible,
        `only ${row.fullyVisible} chips reachable without scrolling at ${width}px`,
      ).toBeGreaterThanOrEqual(MIN_VISIBLE_CHIPS[width]);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. A long place name never costs the distance its column
// ---------------------------------------------------------------------------

test.describe("Place rows survive the longest venue name", () => {
  for (const width of PHONE_WIDTHS) {
    test(`keep the distance on the row at ${width}px`, async ({ page }) => {
      await openSetup(page, width);

      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("[data-place]")].map((el) => {
          const node = el as HTMLElement;
          const rowBox = node.getBoundingClientRect();
          const name = node.querySelector(
            "[data-place-name]",
          ) as HTMLElement;
          const meta = node.querySelector(
            "[data-place-meta]",
          ) as HTMLElement;
          const distance = node.querySelector(
            "[data-place-distance]",
          ) as HTMLElement;
          const distanceBox = distance.getBoundingClientRect();
          const nameBox = name.getBoundingClientRect();
          return {
            height: Math.round(rowBox.height * 100) / 100,
            right: rowBox.right,
            nameLines: Math.round(
              nameBox.height / parseFloat(getComputedStyle(name).lineHeight),
            ),
            nameOverflows: name.scrollWidth > name.clientWidth,
            nameEllipsis: getComputedStyle(name).textOverflow,
            metaLines: Math.round(
              meta.getBoundingClientRect().height /
                parseFloat(getComputedStyle(meta).lineHeight),
            ),
            distanceHeight: Math.round(distanceBox.height * 100) / 100,
            distanceLineHeight: parseFloat(
              getComputedStyle(distance).lineHeight,
            ),
            distanceRight: distanceBox.right,
            distanceWidth: distanceBox.width,
          };
        }),
      );

      for (const row of rows) {
        // The row is a tap target.
        expect(row.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
        // The name and its supporting line are one line each. A wrapped name
        // doubles every row and pushes the list below the fold.
        expect(row.nameLines).toBe(1);
        expect(row.metaLines).toBe(1);
        // When the name IS too long, it truncates rather than pushing.
        expect(row.nameEllipsis).toBe("ellipsis");
        // The distance keeps its own column, on one line, inside the row.
        expect(row.distanceWidth).toBeGreaterThan(0);
        expect(
          Math.round(row.distanceHeight / row.distanceLineHeight),
        ).toBe(1);
        expect(row.distanceRight).toBeLessThanOrEqual(row.right + 1);
      }
    });
  }

  for (const width of PHONE_WIDTHS) {
    test(`do not scroll the panel sideways at ${width}px`, async ({ page }) => {
      await openSetup(page, width);
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        panel: (() => {
          const node = document.querySelector("[data-panel]") as HTMLElement;
          return node.scrollWidth - node.clientWidth;
        })(),
      }));
      expect(overflow.body).toBeLessThanOrEqual(1);
      expect(overflow.panel).toBeLessThanOrEqual(1);
    });
  }

  test("keeps the primary action a full-width tap target at 320px", async ({
    page,
  }) => {
    await openSetup(page, 320);
    const cta = await page.evaluate(() => {
      const node = document.querySelector("[data-check-in]") as HTMLElement;
      const panel = document.querySelector("[data-panel]") as HTMLElement;
      const box = node.getBoundingClientRect();
      return {
        height: Math.round(box.height * 100) / 100,
        width: Math.round(box.width * 100) / 100,
        panelWidth: Math.round(
          panel.getBoundingClientRect().width * 100,
        ) / 100,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      };
    });
    expect(cta.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(cta.scrollWidth).toBeLessThanOrEqual(cta.clientWidth + 1);
    // Full width of the panel's content box (the panel carries p-5).
    expect(cta.width).toBeGreaterThan(cta.panelWidth - 45);
  });
});

// ---------------------------------------------------------------------------
// 4. The desktop rail leaves the map dominant
// ---------------------------------------------------------------------------

test.describe("The desktop rail does not outgrow the map", () => {
  for (const width of DESKTOP_WIDTHS) {
    test(`keeps the map the larger surface at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        await buildFixture(
          "check-in-panel-rail",
          `<div data-rail style="width:${CHECK_IN_PANEL_DESKTOP_WIDTH_REM}rem">${setupBody}</div>`,
          CANDIDATES,
        ),
      );
      await awaitProductFont(page);
      await fontsReady(page);

      const railWidth = await page.evaluate(
        () =>
          (document.querySelector("[data-rail]") as HTMLElement)
            .getBoundingClientRect().width,
      );

      // The rail is a fixed measure, not a share of the window: it must not
      // grow with the screen.
      expect(railWidth).toBeCloseTo(CHECK_IN_PANEL_DESKTOP_WIDTH_REM * 16, 0);

      if (width >= 1024) {
        expect(railWidth / width).toBeLessThan(MAX_PANEL_SHARE_FROM_1024);
      }
    });
  }
});
