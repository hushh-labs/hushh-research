import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import { LOCATION_ONBOARDING_COPY } from "../components/one-location/onboarding/one-location-onboarding-copy";

/**
 * Does the Location onboarding copy still FIT on a phone?
 *
 * The JSDOM suite proves the words render. It cannot prove they fit: jsdom
 * applies no CSS and measures every element as 0x0.
 *
 * The failure this guards is silent. Both lines of a feature-card title are
 * `whitespace-nowrap` (TwoLineFeatureTitle in one-location-onboarding-flow.tsx),
 * and the lower two cards sit in a `grid-cols-2` roughly 150px wide on a 375px
 * screen. Copy that is too long cannot wrap and cannot ellipsize — it runs past
 * its card and is cut off by `overflow-hidden`. Nothing throws, no console
 * warning appears, and no test goes red. That is how
 * "At the venue, but / can't find each other?" shipped clipped on every iPhone.
 *
 * The strings are imported from the module the component itself renders, so a
 * reword is measured here automatically instead of drifting away from a
 * hand-typed fixture — which is exactly what had happened to the fixture in
 * one-location-picker-layering.layout.spec.ts.
 *
 * The stylesheet/fixture/font machinery below follows
 * e2e/connect-circle-cta.layout.spec.ts. Compiling `app/globals.css` and
 * shipping the real Inter face is not ceremony: measuring a nowrap string in a
 * fallback system font measures the wrong typeface, which is the only thing
 * these assertions are about.
 *
 * Run with: npm run test:layout-contracts
 */

/**
 * Every currently-shipping iPhone width. All are below `sm:` (640px), so this
 * is what the App Store build actually renders.
 *
 * 320 and 360 are deliberately absent, and it is worth saying why rather than
 * leaving a reader to assume they were dropped to make this pass.
 *
 * This fixture is intentionally CONSERVATIVE — it asks for more room than the
 * device gives, in two known ways:
 *
 *   - it uses `gap-4` (16px) between the lower cards, where the component's own
 *     stylesheet narrows the gap to 12px below 431px, which makes the real
 *     cards WIDER than the ones measured here; and
 *   - it renders the share title at its base 21px, where the component drops it
 *     to 17px at `(max-width: 431px) and (max-height: 680px)` — the bucket a
 *     320x568 or 360x640 handset falls into.
 *
 * Conservative cuts one way: a PASS here is trustworthy, because the shipped
 * card has at least this much room. A FAIL at 320/360 would be this fixture
 * refusing to model type the component really does shrink, so asserting there
 * would be reporting a defect the device does not have.
 *
 * If those two rules are ever lifted out of the component's inline <style> into
 * a module, import them here and the narrow widths can come back.
 */
const PHONE_WIDTHS = [375, 390, 393, 430] as const;

/** The app's horizontal page padding at phone widths. */
const PAGE_PADDING_PX = 16;

/** Type the fixture must resolve to, or it is measuring the wrong font. */
const SHARE_TITLE_PX = 21;
const LOWER_TITLE_PX = 19;

const CANDIDATES = [
  "relative", "flex", "w-full", "flex-col", "overflow-hidden", "rounded-[26px]",
  "bg-[#f2f5f8]", "aspect-[1.72/1]", "z-20", "w-[56%]", "px-5", "pt-5", "px-4",
  "pt-4", "inline-flex", "rounded-full", "px-3", "py-1", "text-[11px]",
  "font-bold", "leading-[1.13]", "tracking-[-0.015em]", "text-[#111823]",
  "text-[21px]", "text-[19px]", "text-[15px]", "text-[14px]", "leading-[1.4]",
  "text-[#747b86]", "block", "whitespace-nowrap", "mx-auto", "mt-3", "mt-5",
  "mt-6", "w-full", "max-w-[700px]", "max-w-[410px]", "shrink-0", "grid",
  "gap-4", "grid-cols-2", "items-start", "text-center", "text-[17px]",
  "font-semibold", "leading-[22px]", "text-[28px]", "leading-[34px]",
  "min-h-0", "flex-1", "overflow-x-hidden", "overflow-y-auto", "pr-1",
  "font-[family-name:var(--font-app-display)]",
];

/**
 * The real stylesheet. `app/globals.css` rather than a bare
 * `@import "tailwindcss"` because the app's type tokens live there; compiling
 * without it silently measures a system-font fallback.
 */
async function buildStylesheet(candidates: string[]): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
  };

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

  return compiler.build(candidates);
}

/** Fixture dir with the real Inter face copied in and `/fonts/...` rewritten. */
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
<link rel="stylesheet" href="fixture.css"></head>
<body style="margin:0"><div style="padding:0 ${PAGE_PADDING_PX}px">${body}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/** `document.fonts.ready` resolves to a FontFaceSet, which cannot cross the
 *  bridge — await it and return nothing. */
const fontsReady = (page: Page) =>
  page.evaluate(() => document.fonts.ready.then(() => undefined));

const { features, welcome } = LOCATION_ONBOARDING_COPY;

function card(
  testid: string,
  copyColumnClass: string,
  titleClass: string,
  bodyClass: string,
  content: { tag: string; titleLines: readonly string[]; body: string },
): string {
  return `
    <article class="relative flex aspect-[1.72/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#f2f5f8]"
             data-testid="${testid}" data-one-use-case-card>
      <div class="relative z-20 ${copyColumnClass}" data-one-feature-copy>
        <span class="inline-flex rounded-full px-3 py-1 text-[11px] font-bold" data-one-use-case-tag>${content.tag}</span>
        <div class="font-bold leading-[1.13] tracking-[-0.015em] text-[#111823] ${titleClass}" data-one-feature-title>
          ${content.titleLines
            .map(
              (line) =>
                `<span class="block whitespace-nowrap" data-one-feature-title-line>${line}</span>`,
            )
            .join("")}
        </div>
        <p class="${bodyClass} leading-[1.4] text-[#747b86]" data-one-feature-body>${content.body}</p>
      </div>
    </article>`;
}

const BODY = `
  <div class="shrink-0 text-center">
    <p class="text-[17px] font-semibold leading-[22px]">${welcome.eyebrow}</p>
    <h1 class="mx-auto mt-5 max-w-[410px] text-[28px] font-bold leading-[34px] tracking-[-0.015em]"
        data-one-welcome-heading>${welcome.heading}</h1>
  </div>
  <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pr-1">
    <div class="mx-auto mt-3 w-full max-w-[700px] shrink-0">
      <h1 class="text-[28px] font-bold leading-[34px]" data-one-feature-heading>${features.heading}</h1>
    </div>
    <div class="mx-auto mt-6 grid w-full max-w-[700px] shrink-0 gap-4">
      ${card("location-use-case-trip", "w-[56%] px-5 pt-5",
             "font-[family-name:var(--font-app-display)] text-[21px]", "text-[15px]", features.share)}
      <div class="grid grid-cols-2 items-start gap-4">
        ${card("location-use-case-checkin", "px-4 pt-4", "text-[19px]", "text-[14px]", features.checkIn)}
        ${card("location-use-case-sos", "px-4 pt-4", "text-[19px]", "text-[14px]", features.sos)}
      </div>
    </div>
  </div>`;

test.describe("One Location onboarding copy fits a phone", () => {
  let url: string;

  test.beforeAll(async () => {
    url = await buildFixture("one-location-onboarding-copy", BODY, CANDIDATES);
  });

  for (const width of PHONE_WIDTHS) {
    test(`no clipped or overflowing copy at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(url);
      await fontsReady(page);

      // 0. Prove the right typeface and type scale actually applied. Without
      //    this, a fallback font makes every width below meaningless.
      const type = await page.evaluate(() => {
        const share = document.querySelector(
          '[data-testid="location-use-case-trip"] [data-one-feature-title]',
        )!;
        const lower = document.querySelector(
          '[data-testid="location-use-case-checkin"] [data-one-feature-title]',
        )!;
        return {
          share: parseFloat(getComputedStyle(share).fontSize),
          lower: parseFloat(getComputedStyle(lower).fontSize),
          family: getComputedStyle(lower).fontFamily,
        };
      });
      expect(type.share).toBe(SHARE_TITLE_PX);
      expect(type.lower).toBe(LOWER_TITLE_PX);
      expect(type.family.toLowerCase()).toContain("inter");

      // 1. Every nowrap title line fits its card. scrollWidth > clientWidth is
      //    exactly the silent clip described above.
      const clipped = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-one-feature-title-line]"),
        )
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => ({
            text: el.textContent,
            needs: el.scrollWidth,
            has: el.clientWidth,
          })),
      );
      expect(clipped, "title lines clipped by their card").toEqual([]);

      // 2. No copy spills past the card that contains it.
      const spilled = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-one-use-case-card]"),
        ).flatMap((cardEl) => {
          const right = cardEl.getBoundingClientRect().right;
          return Array.from(
            cardEl.querySelectorAll<HTMLElement>(
              "[data-one-feature-title-line], [data-one-feature-body], [data-one-use-case-tag]",
            ),
          )
            .filter((el) => el.getBoundingClientRect().right > right + 1)
            .map((el) => ({
              card: cardEl.getAttribute("data-testid"),
              text: el.textContent?.trim(),
            }));
        }),
      );
      expect(spilled, "copy spilling outside its card").toEqual([]);

      // 3. The page itself never scrolls sideways.
      const horizontal = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(horizontal, "page scrolls horizontally").toBe(false);

      // 4. Both headings stay on screen.
      const offscreen = await page.evaluate(() =>
        ["[data-one-welcome-heading]", "[data-one-feature-heading]"]
          .map((sel) => {
            const el = document.querySelector<HTMLElement>(sel);
            if (!el) throw new Error(`missing ${sel}`);
            const r = el.getBoundingClientRect();
            return r.left < -1 || r.right > window.innerWidth + 1 ? sel : null;
          })
          .filter(Boolean),
      );
      expect(offscreen, "heading runs off screen").toEqual([]);
    });
  }

  test("the copy module is what the component renders", () => {
    // Guards the one thing a fixture cannot: that these are still the
    // component's strings. Reverting to inline JSX text fails here.
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
      welcome.heading,
    ]) {
      expect(
        source.includes(`>${literal}<`),
        `"${literal}" is inlined in the component instead of imported`,
      ).toBe(false);
    }
  });
});
