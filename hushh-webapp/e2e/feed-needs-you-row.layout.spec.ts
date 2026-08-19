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
 * The Feed's "Needs you" rows, measured in a real browser at phone widths.
 *
 * The timestamp lives on the TITLE line, beside the person's name, not on the
 * description line:
 *
 *   <span class="flex min-w-0 items-center gap-2">
 *     <span class="min-w-0 flex-1 truncate">Sharuk Khan Abdulrahman</span>
 *     <span class="shrink-0 …">3:11 AM</span>
 *   </span>
 *
 * It used to ride inside the description line instead, sharing a track whose
 * width was a function of whatever the action-button column left over — so a
 * long description could paint over it, and the timestamp's own position
 * technically depended on whether Decline/Accept rendered even once that
 * collision was fixed. Anchoring it to the name line instead makes its
 * position a function of the name's length only, never of `trailing`.
 *
 * `truncate` sits on an INLINE span, where `overflow` and `text-overflow` do
 * not apply — only its `white-space: nowrap` survives. The flex item that
 * could clip it carries `min-w-0 flex-1` and no `overflow-hidden`, so a long
 * name could in principle run out of its track and paint over the timestamp
 * the same way a description once did. Assert the same two facts here.
 *
 * The markup is the real rendered output of `FeedActionableRow` +
 * `SettingsRow`, captured from those components, so the classes under test are
 * the ones that ship.
 *
 * Run with: npx playwright test e2e/feed-needs-you-row.layout.spec.ts
 */

const WIDTHS = [320, 375, 390, 430, 1280] as const;

const ROW_MARKUP_PATH = path.join(
  process.cwd(),
  "e2e/fixtures/feed-needs-you-rows.html",
);

async function buildFixture(): Promise<string> {
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

  const markup = fs.readFileSync(ROW_MARKUP_PATH, "utf8");
  const used = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  // The app's own @font-face rules cannot load over file:// and, sharing a
  // family name with the working one, stop it satisfying fonts.check.
  const css = stripAppFontFaces(compiler.build([...used]));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-needs-you-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  /* The app shell's own tokens, which this fixture has no shell to inherit.
     Values copied from app/globals.css. */
  :root {
    --settings-row-gap: 12px; --settings-row-px: 16px; --settings-row-py: 11px;
    --settings-group-radius: 24px;
    --type-row-label-size: 17px; --type-row-label-line: 22px;
    --type-row-label-weight: 400; --type-row-label-tracking: normal;
    --type-row-description-size: 13px; --type-row-description-line: 18px;
    --type-row-description-weight: 400; --type-row-description-tracking: 0;
    --app-label: #f5f5f7; --app-tertiary-label: #8e8e93;
    --app-separator: #38383a; --foundation-hairline: #38383a;
    --font-app-body: -apple-system, system-ui, sans-serif;
  }
  :is(.ui-text-row-label) {
    font-size: var(--type-row-label-size) !important;
    font-weight: var(--type-row-label-weight) !important;
    line-height: var(--type-row-label-line) !important;
    letter-spacing: var(--type-row-label-tracking) !important;
    color: var(--app-label) !important;
  }
  :is(.ui-text-row-description) {
    font-size: var(--type-row-description-size) !important;
    font-weight: var(--type-row-description-weight) !important;
    line-height: var(--type-row-description-line) !important;
    letter-spacing: var(--type-row-description-tracking) !important;
    color: var(--app-tertiary-label) !important;
  }
  body { margin: 0; background: #000; }
${productFontStyle()}
</style></head><body>
<div style="margin:0 auto;max-width:40rem">${markup}</div>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type Probe = {
  title: string;
  descText: string;
  /** The flex TRACK the title's name span was given. */
  trackLeft: number;
  trackRight: number;
  /** The timestamp box, now on the title line. */
  stampLeft: number;
  stampRight: number;
  stampText: string;
  /** Does the title's name track actually clip? */
  titleOverflowX: string;
  titleHeight: number;
  rowHeight: number;
};

test.describe("Feed 'Needs you' row", () => {
  for (const width of WIDTHS) {
    test(`title never paints over the timestamp at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const rows = await page.evaluate(() => {
        const out: Probe[] = [];
        for (const row of document.querySelectorAll(
          '[data-testid="settings-row"]',
        )) {
          const titleEl = row.querySelector('[data-slot="settings-row-title"]');
          // A row with no timestamp (none in this fixture, but a chevron-only
          // consent row elsewhere in the app) renders the title as plain text
          // with no nested line/track/stamp — guard rather than assume.
          const line = titleEl?.firstElementChild as HTMLElement | null;
          const track = line?.children[0] as HTMLElement | null;
          const stamp = line?.children[1] as HTMLElement | null;

          const t = track?.getBoundingClientRect();
          const s = stamp?.getBoundingClientRect();

          const descEl = row.querySelector('[data-slot="settings-row-description"]');
          out.push({
            title: track?.textContent ?? titleEl?.textContent ?? "",
            descText: descEl?.textContent ?? "",
            trackLeft: t?.left ?? 0,
            trackRight: t?.right ?? 0,
            stampLeft: s?.left ?? 0,
            stampRight: s?.right ?? 0,
            stampText: stamp?.textContent ?? "",
            titleOverflowX: track ? getComputedStyle(track).overflowX : "",
            titleHeight: titleEl?.getBoundingClientRect().height ?? 0,
            rowHeight: row.getBoundingClientRect().height,
          });
        }
        return out;
      });

      for (const row of rows) {
        if (!row.stampText) continue; // rows with no timestamp have nothing to check here
        // THE CONTRACT, stated the way the browser actually enforces it.
        //
        // The first version of this asserted that the inner span's rect did not
        // intersect the timestamp's rect. That can never pass: `overflow:hidden`
        // clips PAINTING, not layout, so a clipped inline box still reports its
        // full unclipped width from getBoundingClientRect. It measured a box
        // nobody can see and would have kept failing against a fixed component.
        //
        // What actually keeps glyphs off the timestamp is two facts together:
        // the track clips, and the track ends before the timestamp begins.
        // Assert both.
        expect(
          row.titleOverflowX,
          `${row.title}: title track does not clip (overflow-x: ${row.titleOverflowX})`,
        ).not.toBe("visible");
        expect(
          row.trackRight,
          `${row.title}: title track reaches ${row.trackRight.toFixed(1)}px, timestamp starts at ${row.stampLeft.toFixed(1)}px`,
        ).toBeLessThanOrEqual(row.stampLeft + 0.5);
        // The timestamp is still on screen and still readable.
        expect(
          row.stampRight - row.stampLeft,
          `${row.title}: timestamp collapsed to ${(row.stampRight - row.stampLeft).toFixed(1)}px`,
        ).toBeGreaterThan(40);
        // At 320px, action buttons used to leave the text column 0px wide and
        // `[overflow-wrap:anywhere]` broke a long name into one-character
        // lines, tens of pixels tall per row.
        expect(
          row.titleHeight,
          `${row.title}: title wrapped to ${row.titleHeight}px`,
        ).toBeLessThanOrEqual(30);
        // A "Needs you" row is one or two lines of list, not a paragraph.
        expect(
          row.rowHeight,
          `${row.title}: row is ${row.rowHeight}px tall`,
        ).toBeLessThanOrEqual(120);
      }

      // THE REGRESSION PROOF, scoped to what a real circle-invite row can
      // actually hit: it always renders with its two actions from the
      // moment it's pending (never toggles from zero actions to two), so
      // the real claim is narrower than "with vs without actions entirely"
      // — it's "the CTAs rendering, whatever they say, must not move the
      // timestamp". Same title, same (stacked) layout mode, only the action
      // LABELS differ in width. Only meaningful below the `sm` breakpoint,
      // where an actions row actually stacks onto its own line (at ≥640px
      // the action column still borrows from the text column by design,
      // same as it always has — a separate, pre-existing SettingsRow
      // characteristic this fix does not change).
      if (width < 640) {
        const narrow = rows.find((r) => r.descText === "Narrow action labels.");
        const wide = rows.find((r) => r.descText === "Wide action labels.");
        expect(narrow, "consistency-narrow-actions row not found in fixture").toBeTruthy();
        expect(wide, "consistency-wide-actions row not found in fixture").toBeTruthy();
        if (narrow && wide) {
          expect(
            wide.stampLeft,
            `timestamp left moved from ${narrow.stampLeft.toFixed(1)}px (narrow actions) to ${wide.stampLeft.toFixed(1)}px (wide actions)`,
          ).toBeCloseTo(narrow.stampLeft, 0);
          expect(
            wide.stampRight,
            `timestamp right moved from ${narrow.stampRight.toFixed(1)}px (narrow actions) to ${wide.stampRight.toFixed(1)}px (wide actions)`,
          ).toBeCloseTo(narrow.stampRight, 0);
        }
      }
    });
  }
});
