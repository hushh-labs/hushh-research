import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  LIVE_SHARE_ACTION_CLASSNAME,
  LIVE_SHARE_CARD_CLASSNAME,
  LIVE_SHARE_CLOCK_CLASSNAME,
  LIVE_SHARE_CLOCK_ROW_CLASSNAME,
  LIVE_SHARE_FOOTER_CLASSNAME,
  LIVE_SHARE_FOOTER_ROW_CLASSNAME,
  LIVE_SHARE_HEADER_CLASSNAME,
  LIVE_SHARE_PROGRESS_FILL_CLASSNAME,
  LIVE_SHARE_PROGRESS_TRACK_CLASSNAME,
  LIVE_SHARE_TITLE_CLASSNAME,
} from "../components/one-location/redesign/live-share-card-layout";

/**
 * The live share status card, measured in a real browser.
 *
 * The sibling JSDOM test proves the card counts down, resyncs after an app
 * resume, and reports the right words. JSDOM performs no layout, so it cannot
 * prove the thing this file exists for: that a 34px countdown, a person's full
 * name, and a 44px Stop control all fit inside a 320px phone without clipping
 * anything or pushing the page sideways.
 *
 * The card only appears while a share is genuinely running, so reaching it
 * through the app needs a signed-in fixture with a live grant. Instead this
 * renders the card's own class strings, imported from the module the component
 * uses, in the real Tailwind cascade.
 *
 * Two deliberate differences from the app, both of which make this stricter,
 * not looser: the app's `ui-text-row-description` utility (13px) is a global
 * stylesheet rule that is absent here, so the supporting lines are measured at
 * the browser default of 16px; and the longest name below is longer than most
 * real ones.
 *
 * Run with: npx playwright test e2e/one-location-live-share.layout.spec.ts --project=chromium
 */

/** Compact widths the product supports, plus one wide reference. */
const WIDTHS = [320, 360, 375, 390, 430, 768] as const;

/** Minimum comfortable touch target for this touch-first product. */
const MIN_TOUCH_TARGET = 44;

/**
 * The clock is why the widths matter: `1h 00m` is the widest value a 24-hour
 * share produces, and the longest name is what a real address book contains.
 */
const CASES = [
  { id: "short", title: "Sharing with Rohan", clock: "47:05", footer: "Ends 9:04 PM" },
  {
    id: "long-name",
    title: "Sharing with Priyanka Venkataraman-Sundaram",
    clock: "1h 00m",
    footer: "Ends 11:30 PM",
  },
  {
    id: "open-ended",
    title: "Sharing with 12 people",
    clock: "23h 59m",
    footer: "Until you stop",
  },
] as const;

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

  const cardShell =
    "rounded-[24px] bg-white shadow-[0_4px_16px_rgba(0,0,0,0.06)]";
  const badge =
    "inline-flex min-w-0 items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em]";
  const classes = [
    cardShell,
    badge,
    LIVE_SHARE_CARD_CLASSNAME,
    LIVE_SHARE_HEADER_CLASSNAME,
    LIVE_SHARE_ACTION_CLASSNAME,
    LIVE_SHARE_TITLE_CLASSNAME,
    LIVE_SHARE_CLOCK_ROW_CLASSNAME,
    LIVE_SHARE_CLOCK_CLASSNAME,
    LIVE_SHARE_PROGRESS_TRACK_CLASSNAME,
    LIVE_SHARE_PROGRESS_FILL_CLASSNAME,
    LIVE_SHARE_FOOTER_CLASSNAME,
    LIVE_SHARE_FOOTER_ROW_CLASSNAME,
    "h-2 w-2 shrink-0 rounded-full inline-flex items-center justify-center",
  ].join(" ");
  const css = compiler.build(classes.split(/\s+/).filter(Boolean));

  const cards = CASES.map(
    (item) => `
  <section class="${cardShell} ${LIVE_SHARE_CARD_CLASSNAME}" data-testid="card-${item.id}">
    <div class="${LIVE_SHARE_HEADER_CLASSNAME}">
      <span class="${badge}"><span class="h-2 w-2 shrink-0 rounded-full"></span>Live</span>
      <button class="${LIVE_SHARE_ACTION_CLASSNAME} inline-flex items-center justify-center" data-testid="stop-${item.id}">Stop</button>
    </div>
    <p class="${LIVE_SHARE_TITLE_CLASSNAME}" data-testid="title-${item.id}">${item.title}</p>
    <p class="${LIVE_SHARE_CLOCK_ROW_CLASSNAME}">
      <span class="${LIVE_SHARE_CLOCK_CLASSNAME}" data-testid="clock-${item.id}">${item.clock}</span>
      <span data-testid="unit-${item.id}">left</span>
    </p>
    <div class="${LIVE_SHARE_PROGRESS_TRACK_CLASSNAME}" data-testid="track-${item.id}">
      <div class="${LIVE_SHARE_PROGRESS_FILL_CLASSNAME}" style="width:33%" data-testid="fill-${item.id}"></div>
    </div>
    <div class="${LIVE_SHARE_FOOTER_ROW_CLASSNAME}" data-testid="footer-row-${item.id}">
      <p class="${LIVE_SHARE_FOOTER_CLASSNAME}" data-testid="footer-${item.id}">${item.footer}</p>
      <button class="${LIVE_SHARE_ACTION_CLASSNAME} inline-flex items-center justify-center" data-testid="change-${item.id}">Change time</button>
    </div>
  </section>`,
  ).join("\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-share-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css"></head>
<body style="margin:0;background:#f2f2f7">
<div style="display:flex;flex-direction:column;gap:12px;padding:12px">
${cards}
</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type Probe = {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  right: number;
  left: number;
  height: number;
  textOverflow: string;
  lineClamp: string;
  fontVariant: string;
};

const PROBE = (node: Element): Probe => {
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return {
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    right: box.right,
    left: box.left,
    height: box.height,
    textOverflow: style.textOverflow,
    lineClamp: style.webkitLineClamp,
    fontVariant: style.fontVariantNumeric,
  };
};

test.describe("One Location live share card layout", () => {
  for (const width of WIDTHS) {
    test(`keeps every part of the live status readable at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());

      const documentOverflow = await page.evaluate(() => {
        const root = document.documentElement;
        return (
          Math.max(root.scrollWidth, document.body.scrollWidth) -
          root.clientWidth
        );
      });
      // A status card is not allowed to make the whole screen scroll sideways.
      expect(documentOverflow).toBeLessThanOrEqual(1);

      for (const item of CASES) {
        for (const part of ["title", "clock", "footer"] as const) {
          const probe = await page
            .getByTestId(`${part}-${item.id}`)
            .evaluate(PROBE);

          // Nothing here is user-generated filler: the name, the time left, and
          // the end time are the three facts the card exists to state. Wrapping
          // is fine; hiding any of them is not.
          expect(
            probe.scrollWidth,
            `${part}-${item.id} clipped horizontally at ${width}px`,
          ).toBeLessThanOrEqual(probe.clientWidth + 1);
          expect(
            probe.scrollHeight,
            `${part}-${item.id} clipped vertically at ${width}px`,
          ).toBeLessThanOrEqual(probe.clientHeight + 1);
          expect(probe.textOverflow).not.toBe("ellipsis");
          expect(probe.lineClamp).toBe("none");
          expect(probe.right).toBeLessThanOrEqual(width + 1);
          expect(probe.left).toBeGreaterThanOrEqual(-1);
        }

        // Fixed-width digits, or the card twitches once a second for an hour.
        const clock = await page.getByTestId(`clock-${item.id}`).evaluate(PROBE);
        expect(clock.fontVariant).toContain("tabular-nums");

        // Stopping a live share is a safety action; it keeps a full target.
        const stop = await page.getByTestId(`stop-${item.id}`).evaluate(PROBE);
        expect(stop.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
        expect(stop.right).toBeLessThanOrEqual(width + 1);

        // "Change time" shares the footer line with the end time. At 320px
        // that is the tight case: it either fits beside "Ends 11:30 PM" or
        // wraps under it, and either way it has to stay fully on screen, fully
        // tappable, and with its whole label — "Change" alone is a different
        // promise.
        const change = await page.getByTestId(`change-${item.id}`).evaluate(PROBE);
        expect(
          change.height,
          `change-${item.id} lost its touch target at ${width}px`,
        ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
        expect(change.right).toBeLessThanOrEqual(width + 1);
        expect(change.left).toBeGreaterThanOrEqual(-1);
        expect(change.textOverflow).not.toBe("ellipsis");
        expect(
          change.scrollWidth,
          `change-${item.id} clipped its label at ${width}px`,
        ).toBeLessThanOrEqual(change.clientWidth + 1);

        // And the end time it sits beside is not squeezed out by it.
        const footerRow = await page
          .getByTestId(`footer-row-${item.id}`)
          .evaluate(PROBE);
        expect(footerRow.scrollHeight).toBeLessThanOrEqual(
          footerRow.clientHeight + 1,
        );

        // The progress fill must stay inside its rounded track.
        const track = await page.getByTestId(`track-${item.id}`).evaluate(PROBE);
        const fill = await page.getByTestId(`fill-${item.id}`).evaluate(PROBE);
        expect(fill.right).toBeLessThanOrEqual(track.right + 1);
      }
    });
  }

  test("the countdown holds its width as the digits change", async ({ page }) => {
    // The regression this catches: proportional digits make `47:05` and `11:11`
    // different widths, so the whole row shuffles on every tick.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await buildFixture());

    const clock = page.getByTestId("clock-short");
    const widths: number[] = [];
    for (const value of ["47:05", "11:11", "00:00", "58:38"]) {
      await clock.evaluate((node, next) => {
        node.textContent = next;
      }, value);
      widths.push(await clock.evaluate((node) => node.getBoundingClientRect().width));
    }

    const spread = Math.max(...widths) - Math.min(...widths);
    expect(spread).toBeLessThanOrEqual(0.5);
  });
});
