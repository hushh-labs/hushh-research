import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

/**
 * The onboarding Check-in card, measured across viewport HEIGHTS.
 *
 * Reported from UAT: "iphone 14 pro ka baad responsiveness break ho rha, text
 * overlapping on img" — past iPhone 14 Pro the body line "Check in anywhere.
 * Your Circle knows you arrived." ran straight over the building artwork.
 *
 * The name of the bug is misleading and that is exactly why this file measures
 * what it measures. It is not a WIDTH bug. The card sizes itself from its own
 * width (`aspect-[0.68/1]`), but the artwork inside it was positioned by two
 * rules keyed to the VIEWPORT:
 *
 *   [data-one-checkin-art] { bottom: clamp(54px, calc(65vh - 486.6px), 120px); }
 *   @media (max-width: 365px) and (min-height: 681px) { ...a second clamp... }
 *
 * So the card's own geometry stayed constant while the art slid up inside it as
 * the viewport got taller, until it reached the copy. The reporter met it by
 * stepping from a 393x852 iPhone 14 Pro to a 430x932 14 Pro Max — taller, not
 * just wider — which is why a width-only sweep never caught it.
 *
 * The fix anchors the art in a percentage of its OWN region (`bottom-[48%]` of
 * `data-one-use-case-art`, itself `h-[47%]` of the card), which makes the
 * position independent of the viewport. This spec is the guard: it sweeps
 * heights, not just widths, and fails if the copy and the artwork ever touch.
 *
 * The card's `<style>` rules are READ OUT OF THE SOURCE FILE at test time
 * rather than copied here, so a reintroduced viewport clamp is caught rather
 * than shadowed by a stale duplicate.
 *
 * Run: npx playwright test e2e/one-location-checkin-card.layout.spec.ts
 */

const FLOW_SOURCE_PATH = path.join(
  process.cwd(),
  "components/one-location/onboarding/one-location-onboarding-flow.tsx",
);

/**
 * Every size the product supports, paired so that HEIGHT varies independently
 * of width. The 393->430 step and the 852->932 step are the reporter's own.
 */
const VIEWPORTS = [
  { w: 320, h: 568 },
  { w: 320, h: 900 },
  { w: 360, h: 780 },
  { w: 375, h: 812 },
  { w: 390, h: 844 },
  { w: 393, h: 852 },
  { w: 393, h: 932 },
  { w: 430, h: 932 },
  { w: 430, h: 1180 },
] as const;

/**
 * The card is rendered at a FIXED width on purpose.
 *
 * Its own geometry is width-driven and self-consistent (`aspect-[0.68/1]` plus
 * container-query typography), so re-deriving a width from each viewport would
 * only re-measure that. The defect is the other axis: the artwork was placed
 * from the VIEWPORT, so it slid up inside a card whose size had not changed.
 * Holding the card still and sweeping the viewport isolates exactly that.
 * 187px is the real card width on a 430px phone: (430 - 40 padding - 16 gap)/2.
 */
const CARD_WIDTH_PX = 187;

/** The card markup, mirroring CheckInFeatureCard's structure and classes. */
const CARD = `
<article class="relative flex aspect-[0.68/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#f4f6f8] [container-type:inline-size]"
         data-testid="location-use-case-checkin" data-one-use-case-card data-one-feature-card="checkin">
  <div class="relative z-20 px-4 pt-4" data-one-feature-copy>
    <span class="inline-flex rounded-full bg-[#dff4e7] px-3 py-1 text-[11px] font-bold text-[#27884f]" data-one-use-case-tag>Check in</span>
    <!-- TwoLineFeatureTitle's real structure: two BLOCK spans, each
         whitespace-nowrap, so the title is exactly two lines by construction.
         This used to be one paragraph with a br, which is not the same thing —
         a br only suggests a break, and the second half re-wrapped to a third
         line once the fixture stopped using the machine's fallback font and
         started using the InterVariable the product ships. That reported a 22px
         overlap with the artwork at every width, on a card that is fine. -->
    <div class="text-[19px] font-bold leading-[1.13] tracking-[-0.015em]" role="heading" aria-level="2" data-one-feature-title><span class="block whitespace-nowrap" data-one-feature-title-line>At the venue, but</span><span class="block whitespace-nowrap" data-one-feature-title-line>can&rsquo;t find each other?</span></div>
    <p class="text-[14px] leading-[1.4] text-[#747b86]" data-one-feature-body>Check in anywhere. Your Circle knows you arrived.</p>
  </div>
  <div class="absolute inset-x-0 bottom-0 h-[47%]" data-one-use-case-art aria-hidden="true">
    <span class="absolute bottom-[48%] left-1/2 w-[54%] -translate-x-1/2" data-one-checkin-art>
      <img data-one-checkin-hotel alt="" class="block w-full origin-bottom object-contain"
           src="/one-location/onboarding/feature-checkin-house-transparent.webp" />
    </span>
  </div>
</article>`;

/** The component's own <style> block, read from source so it cannot drift. */
function cardStyleFromSource(): string {
  const source = fs.readFileSync(FLOW_SOURCE_PATH, "utf8");
  const rules = [...source.matchAll(/\[data-one-checkin-[a-z]+\][^{}]*\{[^{}]*\}/g)].map(
    (m) => m[0],
  );
  return rules.join("\n");
}

async function buildFixture(): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (css: string, opts: unknown) => Promise<{ build: (c: string[]) => string }>;
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

  const used = new Set<string>();
  for (const match of CARD.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  const css = compiler.build([...used]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-card-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.copyFileSync(
    path.join(webappRoot, "public/one-location/onboarding/feature-checkin-house-transparent.webp"),
    path.join(dir, "feature-checkin-house-transparent.webp"),
  );
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  body { margin: 0; }
${productFontStyle()}
  /* Half the feature grid's width, which is what a card gets on this screen. */
  .grid { display: grid; grid-template-columns: ${CARD_WIDTH_PX}px; gap: 16px; padding: 16px; }
  ${cardStyleFromSource()}
</style></head><body><div class="grid">${CARD}<div></div></div></body></html>`,
  );
  // The image path in CARD is absolute; rewrite it to sit beside the fixture.
  const html = fs
    .readFileSync(path.join(dir, "fixture.html"), "utf8")
    .replace(
      "/one-location/onboarding/feature-checkin-house-transparent.webp",
      "feature-checkin-house-transparent.webp",
    );
  fs.writeFileSync(path.join(dir, "fixture.html"), html);
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("One Location onboarding — check-in card", () => {
  for (const { w, h } of VIEWPORTS) {
    test(`copy never touches the artwork at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(await buildFixture());
      await awaitProductFont(page);
      await page.waitForFunction(() => {
        const img = document.querySelector("[data-one-checkin-hotel]") as HTMLImageElement | null;
        return Boolean(img?.complete && img.naturalWidth > 0);
      });

      const measured = await page.evaluate(() => {
        const q = (sel: string) => document.querySelector(sel) as HTMLElement;
        const body = q("[data-one-feature-body]").getBoundingClientRect();
        const art = q("[data-one-checkin-hotel]").getBoundingClientRect();
        const card = q("[data-one-use-case-card]").getBoundingClientRect();
        const region = q("[data-one-use-case-art]").getBoundingClientRect();
        return {
          gap: art.top - body.bottom,
          artBottom: art.bottom,
          artTop: art.top,
          regionTop: region.top,
          regionBottom: region.bottom,
          cardBottom: card.bottom,
          cardTop: card.top,
        };
      });

      // THE REPORTED DEFECT: the body copy and the artwork must not overlap.
      //
      // -1px, not 0: this fixture hardcodes the card's type sizes, while the
      // real card shrinks them with container queries, so its copy block ends a
      // fraction lower here than it does in the app. The tolerance covers that
      // difference and nothing else — the defect being guarded was tens of
      // pixels of overlap, not a rounding edge.
      expect(measured.gap).toBeGreaterThan(-1);

      // The artwork stays inside its own region, so it can never climb into the
      // copy no matter how tall the viewport gets.
      expect(measured.artTop).toBeGreaterThanOrEqual(measured.regionTop - 0.5);
      expect(measured.artBottom).toBeLessThanOrEqual(measured.regionBottom + 0.5);

      // And inside the card, so nothing spills past the rounded corners.
      expect(measured.artBottom).toBeLessThanOrEqual(measured.cardBottom + 0.5);
      expect(measured.artTop).toBeGreaterThan(measured.cardTop);
    });
  }

  // The sharpest form of this test, and the one that does not depend on the
  // fixture reproducing the app's typography at all: hold the card still, change
  // ONLY the viewport height, and require the artwork not to move inside its own
  // region. That is precisely what the two `vh` clamps broke, and precisely what
  // anchoring the art in a percentage of its own region restores.
  for (const width of [320, 375, 430] as const) {
    test(`the artwork holds its place inside the card as the viewport grows at ${width}px`, async ({
      page,
    }) => {
      const url = await buildFixture();
      const offsets: number[] = [];

      for (const height of [560, 740, 932, 1180]) {
        await page.setViewportSize({ width, height });
        await page.goto(url);
        await awaitProductFont(page);
        await page.waitForFunction(() => {
          const img = document.querySelector(
            "[data-one-checkin-hotel]",
          ) as HTMLImageElement | null;
          return Boolean(img?.complete && img.naturalWidth > 0);
        });
        offsets.push(
          await page.evaluate(() => {
            const art = document
              .querySelector("[data-one-checkin-hotel]")!
              .getBoundingClientRect();
            const region = document
              .querySelector("[data-one-use-case-art]")!
              .getBoundingClientRect();
            // How far the art sits above the bottom of its own region.
            return Math.round((region.bottom - art.bottom) * 100) / 100;
          }),
        );
      }

      // Every height must produce the same offset. Before the fix these were
      // four different numbers, and the largest of them is what pushed the art
      // into the copy on the reporter's taller phone.
      expect(new Set(offsets).size).toBe(1);
    });
  }

  test("the artwork is not positioned from the viewport", async () => {
    // The mechanism, asserted directly. Both clamps read `vh`/`min-height`, so
    // the art moved when the viewport grew while the card did not. Anything
    // viewport-keyed on these selectors is the bug coming back, and a height
    // sweep alone would only catch it once someone picked the wrong height.
    const rules = cardStyleFromSource();
    expect(rules).not.toMatch(/vh\b/);
    expect(rules).not.toMatch(/min-height/);

    const source = fs.readFileSync(FLOW_SOURCE_PATH, "utf8");
    expect(source).not.toContain("clamp(54px, calc(65vh - 486.6px), 120px)");
    expect(source).not.toContain("@media (max-width: 365px) and (min-height: 681px)");
  });
});
