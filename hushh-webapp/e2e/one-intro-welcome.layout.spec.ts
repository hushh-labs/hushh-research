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
 * The welcome screen ("/") is a single-screen composition: one message, one
 * action, and it must fit a phone without scrolling.
 *
 * It is mounted from its real stylesheet rather than navigated to, because the
 * layout-contract lane runs with no server (`playwright.config.ts` drops
 * `webServer` under CI, and every sibling spec mounts markup for the same
 * reason). What it loses by not navigating — the app shell's runtime-measured
 * bottom clearance — is declared explicitly below at the value the running app
 * publishes, exactly as `app-shell-bottom-clearance.layout.spec.ts` declares
 * its bottom-shell height and for the same reason: a `:root` fallback resolves
 * to a different number and a real bug would pass.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE, iPhone 12/13/14, iPhone 14 Pro Max. iOS is where the users are. */
const PHONES = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 14", width: 390, height: 844 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932 },
] as const;

/** Sub-pixel slack only. Not room for a hidden row. */
const SLACK_PX = 2;

/**
 * What the running app publishes on this route, measured at 390x844:
 * `--onboarding-agent-bar-clearance` is `safe-area-bottom + 0.75rem + 3rem` =
 * 60px, and the scroll root in `app/providers.tsx` takes the hidden-chrome
 * branch, `calc(that + 1.5rem)` = 84px. The shell subtracts it, so `main`
 * measures 760px inside an 844px viewport.
 */
const SCROLL_BOTTOM_PAD_PX = 84;
/** The Agent Bar pill itself: 44px tall, sitting 0.75rem above the safe area. */
const AGENT_BAR_HEIGHT_PX = 44;
const AGENT_BAR_BOTTOM_OFFSET_PX = 12;

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
            ? path.join(
                webappRoot,
                "node_modules/tw-animate-css/dist/tw-animate.css",
              )
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
  return stripAppFontFaces(compiler.build(candidates));
}

/**
 * The screen's real stylesheet. CSS Modules only rewrite class NAMES, so the
 * file's rules are used verbatim against literal class names here; `:global(x)`
 * is unwrapped because that syntax is a module-compiler construct, not CSS.
 */
function introModuleCss(): string {
  return fs
    .readFileSync(
      path.join(process.cwd(), "components/onboarding/IntroStep.module.css"),
      "utf8",
    )
    .replace(/:global\(([^)]*)\)/g, "$1");
}

/** The welcome as `IntroStep.tsx` renders it, inside the shell that wraps it. */
function welcomeMarkup(): string {
  return `<div
      data-app-shell-root="true"
      style="position: fixed; inset: 0; display: flex; flex-direction: column;
             --app-scroll-bottom-pad: ${SCROLL_BOTTOM_PAD_PX}px;"
    >
      <div
        data-app-scroll-root="true"
        style="flex: 1 1 0%; min-height: 0; overflow-y: auto; overflow-x: hidden;
               padding-bottom: var(--app-scroll-bottom-pad);"
      >
        <main class="shell">
          <div class="stage">
            <div class="brand"><span class="wordmark" data-wordmark>hussh</span></div>

            <div class="hero">
              <h1 class="title"><span class="oneMark">One</span></h1>
              <p class="tagline">Your personal assistant for everyday tasks.</p>
            </div>

            <div class="footer">
              <button type="button" class="cta" data-voice-control-id="onboarding_claim_one">
                <span style="position: relative; display: inline-flex; align-items: center; gap: 8px;">
                  Get started
                  <span aria-hidden>&rarr;</span>
                </span>
              </button>

              <p class="privacy">
                <svg class="privacyIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                You control what you share.
              </p>

              <nav aria-label="Explore Hussh" class="links">
                <a class="link" href="/research">Research</a>
                <a class="link" href="/blog">Blog</a>
                <a class="link" href="/developers">Developers</a>
              </nav>
            </div>
          </div>
        </main>
      </div>

      <div
        data-agent-bar
        style="position: fixed; inset-inline: 12px; bottom: ${AGENT_BAR_BOTTOM_OFFSET_PX}px;
               height: ${AGENT_BAR_HEIGHT_PX}px; display: flex; align-items: center;
               padding: 0 12px; border-radius: 999px; background: rgba(255,255,255,0.78);"
      ><span data-bar-label style="font-size: 13px;">Talk to One</span></div>
    </div>`;
}

async function writeFixture(): Promise<string> {
  const css = await buildStylesheet([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "one-intro-welcome-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html class="light"><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  body { margin: 0; }
  ${introModuleCss()}
  /* The wordmark is an SVG in the app; a 31px block stands in for its box so
     the vertical budget is measured against the real reserved height. */
  .wordmark { display: block; height: 31px; line-height: 31px; font-weight: 800; }
</style></head>
<body>${welcomeMarkup()}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

let fixtureUrl: string;

test.beforeAll(async () => {
  fixtureUrl = await writeFixture();
});

async function gotoWelcome(page: import("@playwright/test").Page) {
  await page.goto(fixtureUrl);
  await awaitProductFont(page);
  await expect(page.getByRole("heading", { name: "One" })).toBeVisible();
  // The entrance animations translate elements; measuring mid-flight reports
  // positions the user never sees.
  await page.waitForTimeout(1200);
}

for (const phone of PHONES) {
  test.describe(`welcome at ${phone.name} (${phone.width}x${phone.height})`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test("fits without vertical or horizontal scrolling", async ({ page }) => {
      await gotoWelcome(page);

      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        let worstY = 0;
        let worstX = 0;
        // The page scroll root is a nested element, not <html>, so check every
        // scrollable box — a nested scroller is exactly how a visible
        // scrollbar gets onto a screen that looks like it fits.
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>("*"),
        )) {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden")
            continue;
          const canScrollY =
            style.overflowY === "auto" || style.overflowY === "scroll";
          const canScrollX =
            style.overflowX === "auto" || style.overflowX === "scroll";
          if (canScrollY)
            worstY = Math.max(worstY, el.scrollHeight - el.clientHeight);
          if (canScrollX)
            worstX = Math.max(worstX, el.scrollWidth - el.clientWidth);
        }
        return {
          y: Math.max(worstY, de.scrollHeight - de.clientHeight),
          x: Math.max(worstX, de.scrollWidth - de.clientWidth),
        };
      });

      expect(overflow.y).toBeLessThanOrEqual(SLACK_PX);
      expect(overflow.x).toBeLessThanOrEqual(SLACK_PX);
    });

    test("shows the whole screen inside the viewport, nothing clipped", async ({
      page,
    }) => {
      await gotoWelcome(page);

      const parts = {
        wordmark: page.locator("[data-wordmark]"),
        one: page.getByRole("heading", { name: "One" }),
        supporting: page.getByText(
          "Your personal assistant for everyday tasks.",
        ),
        cta: page.getByRole("button", { name: /get started/i }),
        privacy: page.getByText("You control what you share."),
        research: page.getByRole("link", { name: "Research" }),
        blog: page.getByRole("link", { name: "Blog" }),
        developers: page.getByRole("link", { name: "Developers" }),
        talkToOne: page.locator("[data-bar-label]"),
      };

      for (const [name, locator] of Object.entries(parts)) {
        await expect(locator, `${name} is visible`).toBeVisible();
        const box = await locator.boundingBox();
        expect(box, `${name} has a box`).not.toBeNull();
        expect(box!.y, `${name} top is on screen`).toBeGreaterThanOrEqual(
          -SLACK_PX,
        );
        expect(
          box!.y + box!.height,
          `${name} bottom is on screen`,
        ).toBeLessThanOrEqual(phone.height + SLACK_PX);
        expect(box!.x, `${name} left is on screen`).toBeGreaterThanOrEqual(
          -SLACK_PX,
        );
        expect(
          box!.x + box!.width,
          `${name} right is on screen`,
        ).toBeLessThanOrEqual(phone.width + SLACK_PX);
      }
    });

    test("the bottom bar never covers the footer links or the button", async ({
      page,
    }) => {
      await gotoWelcome(page);

      // The bar element itself, not its label — a label sits inside a taller
      // pill, and measuring the label would permit the pill to overlap.
      const bar = await page.locator("[data-agent-bar]").boundingBox();
      const developers = await page
        .getByRole("link", { name: "Developers" })
        .boundingBox();
      const cta = await page
        .getByRole("button", { name: /get started/i })
        .boundingBox();

      expect(bar).not.toBeNull();
      expect(developers).not.toBeNull();
      expect(cta).not.toBeNull();

      expect(developers!.y + developers!.height).toBeLessThanOrEqual(
        bar!.y + SLACK_PX,
      );
      expect(cta!.y + cta!.height).toBeLessThanOrEqual(bar!.y + SLACK_PX);
    });

    test("no label wraps past its box or ellipsizes", async ({ page }) => {
      await gotoWelcome(page);

      const clipped = await page.evaluate(() => {
        const wanted = [
          "Your personal assistant for everyday tasks.",
          "You control what you share.",
          "Get started",
          "Research",
          "Blog",
          "Developers",
        ];
        const bad: string[] = [];
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>("*"),
        )) {
          const own = (el.textContent || "").replace(/\s+/g, " ").trim();
          // `Get started` shares its element with the arrow glyph, so match on
          // "starts with" rather than equality or the button is never checked.
          if (!wanted.some((w) => own === w || own === `${w} →`)) continue;
          if (el.scrollWidth > el.clientWidth + 1)
            bad.push(`${own}: horizontally clipped`);
          if (el.scrollHeight > el.clientHeight + 1)
            bad.push(`${own}: vertically clipped`);
        }
        return bad;
      });

      expect(clipped).toEqual([]);
    });

    test("every tappable target clears 44px", async ({ page }) => {
      await gotoWelcome(page);

      const cta = (await page
        .getByRole("button", { name: /get started/i })
        .boundingBox())!;
      expect(cta.height).toBeGreaterThanOrEqual(56 - SLACK_PX);

      for (const label of ["Research", "Blog", "Developers"]) {
        const box = (await page
          .getByRole("link", { name: label })
          .boundingBox())!;
        expect(box.height, `${label} touch target`).toBeGreaterThanOrEqual(
          44 - SLACK_PX,
        );
      }
    });
  });
}

test.describe("welcome composition", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Get started is a full-width 56px control", async ({ page }) => {
    await gotoWelcome(page);

    const box = (await page
      .getByRole("button", { name: /get started/i })
      .boundingBox())!;

    expect(box.height).toBeGreaterThanOrEqual(56 - SLACK_PX);
    // Full width inside the 24px screen padding on each side.
    expect(box.width).toBeGreaterThanOrEqual(390 - 48 - SLACK_PX);
  });

  test("exactly one heading and one button", async ({ page }) => {
    await gotoWelcome(page);

    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.locator("main button")).toHaveCount(1);
  });

  test("One is the single accent, and the accent is Apple blue", async ({
    page,
  }) => {
    await gotoWelcome(page);

    const colors = await page.evaluate(() => {
      const get = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      return {
        one: get(".oneMark").color,
        cta: get(".cta").backgroundColor,
        supporting: get(".tagline").color,
      };
    });

    expect(colors.one).toBe("rgb(0, 113, 227)");
    expect(colors.cta).toBe("rgb(0, 113, 227)");
    // The supporting line is near-black, not a second accent.
    expect(colors.supporting).toBe("rgb(29, 29, 31)");
  });
});
