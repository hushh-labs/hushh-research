import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Feed's "Needs you" rows, measured in a real browser at phone widths.
 *
 * A row's description and its "Today - 3:04 AM" label share one flex line:
 *
 *   <span class="flex items-center gap-2">
 *     <span class="min-w-0 flex-1"><span class="min-w-0 truncate">…</span></span>
 *     <span class="shrink-0 …">Today - 3:04 AM</span>
 *   </span>
 *
 * `truncate` sits on an INLINE span, where `overflow` and `text-overflow` do
 * not apply — only its `white-space: nowrap` survives. The flex item that
 * could clip it carries `min-w-0 flex-1` and no `overflow-hidden`, so a long
 * description runs straight out of its track and paints over the timestamp.
 * The wider the trailing action buttons, the narrower the track, the worse it
 * gets — which is why the "Approve 4 hours more" row is the broken one and a
 * chevron-only row is not.
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
  const css = compiler.build([...used]);

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
  body { margin: 0; background: #000; font-family: -apple-system, system-ui, sans-serif; }
</style></head><body>
<div style="margin:0 auto;max-width:40rem">${markup}</div>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type Probe = {
  title: string;
  descText: string;
  /** The flex TRACK the description was given. */
  trackLeft: number;
  trackRight: number;
  /** The ink of the description text itself (inline span's own box). */
  inkLeft: number;
  inkRight: number;
  /** The timestamp box. */
  stampLeft: number;
  stampRight: number;
  stampText: string;
  /** How far the description ink runs past its own track. */
  spill: number;
  /** Horizontal intersection between the description ink and the stamp. */
  overlap: number;
  /** Does the description box actually clip? */
  descOverflowX: string;
  trailingWidth: number;
  titleHeight: number;
  rowHeight: number;
};

test.describe("Feed 'Needs you' row", () => {
  for (const width of WIDTHS) {
    test(`description never paints over the timestamp at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture());

      const rows = await page.evaluate(() => {
        const out: Probe[] = [];
        for (const row of document.querySelectorAll(
          '[data-testid="settings-row"]',
        )) {
          const title =
            row.querySelector('[data-slot="settings-row-title"]')?.textContent ??
            "";
          const desc = row.querySelector(
            '[data-slot="settings-row-description"]',
          );
          const line = desc?.firstElementChild as HTMLElement | null;
          const track = line?.children[0] as HTMLElement | null;
          const ink = track?.firstElementChild as HTMLElement | null;
          const stamp = line?.children[1] as HTMLElement | null;
          const trailing = (row.firstElementChild as HTMLElement | null)
            ?.lastElementChild as HTMLElement | null;

          const t = track?.getBoundingClientRect();
          // An inline span's own box is what the glyphs occupy.
          const i = ink?.getBoundingClientRect();
          const s = stamp?.getBoundingClientRect();
          const tr = trailing?.getBoundingClientRect();

          out.push({
            title,
            descText: ink?.textContent ?? "",
            trackLeft: t?.left ?? 0,
            trackRight: t?.right ?? 0,
            inkLeft: i?.left ?? 0,
            inkRight: i?.right ?? 0,
            stampLeft: s?.left ?? 0,
            stampRight: s?.right ?? 0,
            stampText: stamp?.textContent ?? "",
            spill: (i?.right ?? 0) - (t?.right ?? 0),
            overlap: Math.max(
              0,
              Math.min(i?.right ?? 0, s?.right ?? 0) -
                Math.max(i?.left ?? 0, s?.left ?? 0),
            ),
            descOverflowX: track
              ? getComputedStyle(track).overflowX
              : "",
            trailingWidth: tr?.width ?? 0,
            titleHeight:
              row
                .querySelector('[data-slot="settings-row-title"]')
                ?.getBoundingClientRect().height ?? 0,
            rowHeight: row.getBoundingClientRect().height,
          });
        }
        return out;
      });

      for (const row of rows) {
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
          row.descOverflowX,
          `${row.title}: description track does not clip (overflow-x: ${row.descOverflowX})`,
        ).not.toBe("visible");
        expect(
          row.trackRight,
          `${row.title}: description track reaches ${row.trackRight.toFixed(1)}px, timestamp starts at ${row.stampLeft.toFixed(1)}px`,
        ).toBeLessThanOrEqual(row.stampLeft + 0.5);
        // The timestamp is still on screen and still readable.
        expect(
          row.stampRight - row.stampLeft,
          `${row.title}: timestamp collapsed to ${(row.stampRight - row.stampLeft).toFixed(1)}px`,
        ).toBeGreaterThan(40);
        // The same collapse takes the title: at 320px the action buttons leave
        // the text column 0px wide and `[overflow-wrap:anywhere]` breaks
        // "JHUMMA KUMARI" into 12 one-character lines, 264px tall.
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
    });
  }
});
