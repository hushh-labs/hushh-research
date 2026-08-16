import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Tab titles are product-owned copy and may never render as an ellipsis.
 *
 * This exists because a review that looked right was wrong. Adding a third tab
 * to Connect left "Around you" 77px of the 80px it needs on a 375px screen, so
 * it shipped as "Around yo…" -- and nothing said so: jsdom does no layout, a
 * type check cannot see a width, and the page had no horizontal scrollbar to
 * notice. The only thing that catches this class of bug is measuring the
 * rendered text against the box it was given.
 *
 * Deliberately server-free. It measures the REAL built stylesheet against the
 * REAL class strings the shared primitive emits, so it needs no dev server, no
 * sign-in and no fixtures -- which is what makes it cheap enough to run on
 * every change rather than at release time. It does need `npm run build` to
 * have produced a stylesheet; it fails loudly rather than skipping if not,
 * because a check that quietly does nothing is worse than no check.
 *
 * Screenshots are not evidence here. The assertion is scrollWidth against
 * clientWidth, which is a number, and the failure message names the tab, the
 * width, and by how much it overflowed.
 */

/** Widths a phone actually is. 320 is the narrowest the product supports. */
const WIDTHS = [320, 360, 375, 390, 430, 768, 1280] as const;

/**
 * Every tab strip in the app, by the labels it renders.
 *
 * Listed here rather than discovered, because discovery needs a running app and
 * the point of this spec is that it does not. A new strip that is not listed is
 * simply unchecked -- so add to this when adding tabs.
 */
const TAB_STRIPS: ReadonlyArray<{ surface: string; labels: string[] }> = [
  { surface: "connect", labels: ["People", "RIAs", "Around you"] },
  { surface: "connect/around-you", labels: ["Advisors", "Insurance", "Places"] },
];

/** The class strings SegmentedTabs emits, read from the component itself. */
function readSegmentedTabsClasses(): { option: string; label: string } {
  const source = readFileSync(
    join(process.cwd(), "lib/morphy-ux/ui/segmented-tabs.tsx"),
    "utf8",
  );
  const option = source.match(/"(press-scale relative isolate flex[^"]+)"/)?.[1];
  const label = source.match(/"(ui-text-form-label relative[^"]+)"/)?.[1];
  if (!option || !label) {
    throw new Error(
      "Could not read the SegmentedTabs class strings. The component changed shape; update this spec rather than deleting it.",
    );
  }
  return { option, label };
}

/** The largest built stylesheet, which is the one carrying the app's utilities. */
function readBuiltStylesheet(): string {
  const dir = join(process.cwd(), ".next/static/chunks");
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".css"));
  } catch {
    throw new Error(
      `No built stylesheet at ${dir}. Run \`npm run build\` first — this spec measures the real CSS, not a copy of it.`,
    );
  }
  const largest = entries
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (!largest) {
    throw new Error(`No .css files in ${dir}. Run \`npm run build\` first.`);
  }
  return readFileSync(largest, "utf8");
}

// The scoped compact padding both three-tab strips pass to SegmentedTabs.
// Three tabs do not fit at the stock 16px option padding, so measuring without
// this would measure a strip nobody ships. Kept as one constant because both
// call sites pass the same string; if they ever diverge, this spec should grow
// a per-strip override rather than quietly measure the wrong one.
const COMPACT_STRIP_OVERRIDE =
  "[&>button]:px-1 min-[360px]:[&>button]:px-3 sm:[&>button]:px-4.5";

test.describe("Tab titles never truncate", () => {
  for (const strip of TAB_STRIPS) {
    for (const width of WIDTHS) {
      test(`${strip.surface} @ ${width}px`, async ({ page }) => {
        const css = readBuiltStylesheet();
        const { option, label } = readSegmentedTabsClasses();
        const override = COMPACT_STRIP_OVERRIDE;

        await page.setViewportSize({ width, height: 800 });
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body>
             <main style="padding:0 16px">
               <div class="relative grid w-full rounded-full p-1 border bg-[color:var(--app-card-surface-compact)] ${override}"
                    style="--segmented-mobile-cols:${strip.labels.length};--segmented-desktop-cols:${strip.labels.length};
                           grid-template-columns:repeat(${strip.labels.length},minmax(0,1fr))">
                 ${strip.labels
                   .map(
                     (text, index) =>
                       `<button class="${option}" data-state="${index === 0 ? "active" : "inactive"}">
                          <span data-ui-contract="required-title" data-ui-truncation="forbid"
                                data-ui-id="segmented-tab-${index}" class="${label}">${text}</span>
                        </button>`,
                   )
                   .join("")}
               </div>
             </main>
           </body></html>`,
          { waitUntil: "load" },
        );

        const measured = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-ui-contract="required-title"][data-ui-truncation="forbid"]',
            ),
          ].map((el) => ({
            text: el.textContent ?? "",
            needs: el.scrollWidth,
            has: el.clientWidth,
          })),
        );

        expect(
          measured.length,
          "the strip rendered no titles to measure",
        ).toBe(strip.labels.length);

        const clipped = measured.filter((m) => m.needs > m.has);
        expect(
          clipped,
          clipped
            .map(
              (m) =>
                `"${m.text}" needs ${m.needs}px but has ${m.has}px at ${width}px — it renders as an ellipsis`,
            )
            .join("; "),
        ).toEqual([]);

        // A strip that fits by pushing the page sideways has not fitted.
        const overflow = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          win: window.innerWidth,
        }));
        expect(
          overflow.doc,
          `the page scrolls horizontally at ${width}px (${overflow.doc} > ${overflow.win})`,
        ).toBeLessThanOrEqual(overflow.win);
      });
    }
  }
});
