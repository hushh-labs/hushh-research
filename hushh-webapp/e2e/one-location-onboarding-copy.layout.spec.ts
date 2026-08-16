import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { LOCATION_ONBOARDING_COPY } from "../components/one-location/onboarding/one-location-onboarding-copy";

/**
 * Does the onboarding copy still FIT on a phone?
 *
 * A jsdom test proves the words render. It cannot prove they fit: jsdom has no
 * layout engine, so every width it reports is 0. This spec measures the real
 * strings, in the real compiled CSS, in a real browser, at the four iPhone
 * widths that carry almost all of our users.
 *
 * The failure it guards is silent. Both feature-card title lines are
 * `whitespace-nowrap` (one-location-onboarding-flow.tsx TwoLineFeatureTitle),
 * and the lower two cards sit in a `grid-cols-2` that is roughly 165px wide on
 * a 375px screen. Copy that is too long does not wrap and does not ellipsize —
 * it runs past its card and is clipped by `overflow-hidden`. Nothing throws,
 * no test goes red, and the screenshot looks plausible unless you know the
 * sentence. That is how "At the venue, but / can't find each other?" shipped.
 *
 * The strings come from one-location-onboarding-copy.ts, the same module the
 * component renders, so a reword is measured here automatically instead of
 * silently drifting away from a hand-typed fixture.
 */

const IPHONE_WIDTHS = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 14", width: 390, height: 844 },
  { name: "iPhone 15 Pro", width: 393, height: 852 },
  { name: "iPhone 15 Pro Max", width: 430, height: 932 },
] as const;

/**
 * The shipped stylesheet. `out/` is the static export CI produces; `.next/` is
 * what a plain compile leaves behind. Tailwind emits the same CSS to both, and
 * accepting either means this spec runs on a machine that has no `.env.local`
 * (the export step needs Firebase keys, the CSS does not).
 */
function builtStylesheet(): string {
  const candidates = [
    path.join(process.cwd(), "out", "_next", "static", "css"),
    path.join(process.cwd(), ".next", "static", "css"),
  ];
  const cssDir = candidates.find((dir) => fs.existsSync(dir));
  if (!cssDir) {
    throw new Error(
      `No built CSS in ${candidates.join(" or ")}. Run \`npm run cap:build\` ` +
        "first — this spec deliberately measures the shipped stylesheet, not a fixture.",
    );
  }
  const files = fs
    .readdirSync(cssDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => path.join(cssDir, name));
  if (files.length === 0) throw new Error(`No stylesheet in ${cssDir}.`);
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

/**
 * The feature step, reproduced with the component's own class strings. Only the
 * geometry that constrains the text is kept: the page padding, the 700px cap,
 * the two-column lower grid, each card's copy column width and padding, and the
 * title/body type sizes. The map art and gradients are irrelevant to whether a
 * sentence fits, and dropping them keeps the fixture readable.
 */
const { features } = LOCATION_ONBOARDING_COPY;

function card(
  testid: string,
  copyColumnClass: string,
  titleClass: string,
  bodyClass: string,
  content: { tag: string; titleLines: readonly string[]; body: string },
): string {
  return `
    <article class="relative flex aspect-[1.72/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#f2f5f8] [container-type:inline-size]"
             data-testid="${testid}" data-one-use-case-card>
      <div class="relative z-20 ${copyColumnClass}" data-one-feature-copy>
        <span class="inline-flex rounded-full px-3 py-1 text-[11px] font-bold" data-one-use-case-tag>${content.tag}</span>
        <div class="font-bold leading-[1.13] tracking-[-0.015em] ${titleClass}" data-one-feature-title>
          ${content.titleLines
            .map(
              (line) =>
                `<span class="block whitespace-nowrap" data-one-feature-title-line>${line}</span>`,
            )
            .join("")}
        </div>
        <p class="${bodyClass}" data-one-feature-body>${content.body}</p>
      </div>
    </article>`;
}

const FEATURE_STEP = `
  <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pr-1" data-one-feature-scroll>
    <header class="mx-auto mt-3 w-full max-w-[700px] shrink-0" data-one-feature-header>
      <h1 class="ui-text-agent-title" data-one-feature-heading>${features.heading}</h1>
    </header>
    <div class="mx-auto mt-6 grid w-full max-w-[700px] shrink-0 gap-4" data-one-feature-grid>
      ${card(
        "location-use-case-trip",
        "w-[56%] px-5 pt-5",
        "font-[family-name:var(--font-app-display)] text-[21px]",
        "text-[15px] leading-[1.4]",
        features.share,
      )}
      <div class="grid grid-cols-2 items-start gap-4" data-one-feature-lower-grid>
        ${card(
          "location-use-case-checkin",
          "px-4 pt-4",
          "text-[19px]",
          "text-[14px] leading-[1.4]",
          features.checkIn,
        )}
        ${card(
          "location-use-case-sos",
          "px-4 pt-4",
          "text-[19px]",
          "text-[14px] leading-[1.4]",
          features.sos,
        )}
      </div>
    </div>
  </div>`;

const WELCOME_STEP = `
  <div class="shrink-0 text-center" data-one-welcome-step>
    <p class="text-[17px] font-semibold leading-[22px]">${LOCATION_ONBOARDING_COPY.welcome.eyebrow}</p>
    <h1 class="mx-auto mt-5 max-w-[410px] text-[28px] font-bold leading-[34px] tracking-[-0.015em]"
        data-one-welcome-heading>${LOCATION_ONBOARDING_COPY.welcome.heading}</h1>
  </div>`;

const PAGE = `
  <div data-one-feature-screen class="px-4">
    ${WELCOME_STEP}
    ${FEATURE_STEP}
  </div>`;

test.describe("One Location onboarding copy fits a phone", () => {
  for (const device of IPHONE_WIDTHS) {
    test(`no clipped or overflowing copy on ${device.name} (${device.width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      await page.setContent(`<body>${PAGE}</body>`);
      await page.addStyleTag({ content: builtStylesheet() });

      // 1. Every nowrap title line fits its card. scrollWidth > clientWidth is
      //    exactly the silent clip described above.
      const clipped = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-one-feature-title-line]"),
        )
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => ({
            text: el.textContent,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          })),
      );
      expect(clipped, "title lines that overflow their card").toEqual([]);

      // 2. No card's copy column spills past the card itself.
      const spilled = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-one-use-case-card]"))
          .flatMap((cardEl) => {
            const cardRight = cardEl.getBoundingClientRect().right;
            return Array.from(
              cardEl.querySelectorAll<HTMLElement>(
                "[data-one-feature-title-line], [data-one-feature-body], [data-one-use-case-tag]",
              ),
            )
              .filter((el) => el.getBoundingClientRect().right > cardRight + 1)
              .map((el) => ({
                card: cardEl.getAttribute("data-testid"),
                text: el.textContent?.trim(),
              }));
          }),
      );
      expect(spilled, "copy that spills outside its card").toEqual([]);

      // 3. The page itself never scrolls sideways.
      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(horizontalOverflow, "page scrolls horizontally").toBe(false);

      // 4. The welcome heading stays on the screen.
      const headingOverflows = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("[data-one-welcome-heading]");
        if (!el) throw new Error("welcome heading missing from fixture");
        const rect = el.getBoundingClientRect();
        return rect.left < 0 || rect.right > window.innerWidth;
      });
      expect(headingOverflows, "welcome heading runs off screen").toBe(false);
    });
  }

  test("the copy module is what the component renders", async () => {
    // Guards the one thing a fixture cannot: that these strings are still the
    // component's strings. If someone reverts to inline JSX text, this fails.
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "components/one-location/onboarding/one-location-onboarding-flow.tsx",
      ),
      "utf8",
    );
    expect(source).toContain("one-location-onboarding-copy");
    for (const literal of [
      features.heading,
      features.share.body,
      features.checkIn.body,
      features.sos.body,
      LOCATION_ONBOARDING_COPY.welcome.heading,
    ]) {
      expect(
        source.includes(`>${literal}<`),
        `"${literal}" is inlined in the component instead of imported`,
      ).toBe(false);
    }
  });
});
