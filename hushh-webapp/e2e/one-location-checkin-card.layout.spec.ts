import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

/**
 * Guard the One Location onboarding feature step.
 *
 * The feature step keeps the approved 1+2 onboarding composition with blended
 * map artwork and tightened copy. This protects against copy regressions,
 * horizontal overflow, clipped artwork, and app chrome covering Continue.
 */

const FLOW_SOURCE_PATH = path.join(
  process.cwd(),
  "components/one-location/onboarding/one-location-onboarding-flow.tsx",
);

const VIEWPORTS = [
  { w: 320, h: 568 },
  { w: 375, h: 667 },
  { w: 390, h: 844 },
  { w: 430, h: 932 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
] as const;

const STORY = `
<main data-testid="one-location-onboarding">
  <section data-one-feature-screen>
    <div data-one-feature-scroll>
      <header data-one-feature-header>
        <h1 data-one-feature-heading>Keep your people updated.</h1>
      </header>
      <div data-one-story-container>
        <article data-one-use-case-card data-one-feature-card="share">
          <div data-one-feature-copy>
            <h2 data-one-feature-title>Can’t explain where you are?</h2>
            <p data-one-feature-body>Share your live location with your Circle in one tap.</p>
          </div>
          <div data-one-use-case-art></div>
        </article>
        <div data-one-feature-lower-grid>
        <article data-one-use-case-card data-one-feature-card="checkin">
          <div data-one-feature-copy>
            <h2 data-one-feature-title>Stuck waiting in line?</h2>
            <p data-one-feature-body>Check in on the spot and notify your circle</p>
          </div>
          <div data-one-checkin-map-backdrop></div>
          <div data-one-use-case-art>
            <span data-one-checkin-destination><span data-one-checkin-illustration></span></span>
          </div>
        </article>
        <article data-one-use-case-card data-one-feature-card="sms">
          <div data-one-feature-copy>
            <h2 data-one-feature-title>Need help but can’t talk?</h2>
            <p data-one-feature-body>Send an SMS with your location in seconds.</p>
          </div>
          <div data-one-feature-art-region>
            <span data-one-sms-radar><span data-one-sms-radar-ring></span><span data-one-sms-radar-ring></span><span data-one-sms-core>SMS</span></span>
          </div>
        </article>
        </div>
      </div>
    </div>
    <div data-one-feature-cta><button>Continue</button></div>
  </section>
  <div data-app-bottom-shell>Talk to One</div>
</main>`;

function source(): string {
  return fs.readFileSync(FLOW_SOURCE_PATH, "utf8");
}

function featureStyleFromSource(): string {
  const appSource = source();
  return (
    [...appSource.matchAll(/<style>\{`([\s\S]*?)`\}<\/style>/g)]
      .map((match) => match[1])
      .find((style) => style.includes("[data-one-feature-card]")) ?? ""
  );
}

function buildHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${productFontStyle()}
html, body { margin: 0; min-height: 100%; font-family: InterVariable, Inter, system-ui, sans-serif; background: #f2f2f7; color: #111823; }
[data-one-feature-screen] { box-sizing: border-box; min-height: 100vh; display: flex; flex-direction: column; padding: 12px 16px max(12px, env(safe-area-inset-bottom)); }
[data-one-feature-scroll] { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; overflow-x: hidden; overflow-y: auto; }
[data-one-feature-header], [data-one-story-container], [data-one-feature-cta] { width: 100%; max-width: 430px; margin-left: auto; margin-right: auto; }
[data-one-feature-heading] { margin: 20px 0 0; font-size: 31px; line-height: 1.08; letter-spacing: -0.02em; }
[data-one-story-container] { margin-top: 20px; display: grid; gap: 12px; }
[data-one-feature-lower-grid] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
[data-one-use-case-card] { box-sizing: border-box; position: relative; overflow: hidden; border-radius: 22px; background: #fff; min-height: 160px; padding: 16px; }
[data-one-feature-copy] { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
[data-one-feature-title] { margin: 0; font-size: 17px; font-weight: 600; line-height: 22px; letter-spacing: -0.01em; }
[data-one-feature-body] { margin: 0; color: #6e737d; font-size: 15px; line-height: 20px; }
[data-one-use-case-art], [data-one-feature-art-region] { position: absolute; inset: auto 0 40px 0; height: 45%; }
[data-one-feature-card="sms"] [data-one-feature-art-region] { display: flex; align-items: center; justify-content: center; }
[data-one-sms-core] { display: flex; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 999px; background: #ff3b30; color: #fff; font-size: 13px; font-weight: 700; }
[data-one-feature-cta] { padding-top: 20px; }
[data-one-feature-cta] button { width: 100%; height: 52px; border: 0; border-radius: 999px; background: #007aff; color: white; font-size: 17px; font-weight: 700; }
[data-app-bottom-shell] { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); height: 44px; width: min(360px, calc(100vw - 32px)); border-radius: 999px; background: rgba(255,255,255,.9); }
html:has([data-testid="one-location-onboarding"]) [data-app-bottom-shell] { visibility: hidden; pointer-events: none; }
${featureStyleFromSource()}
</style></head><body>${STORY}</body></html>`;
}

test.describe("One Location onboarding feature story", () => {
  test("old hotel/front-desk check-in treatment is absent from source", () => {
    const appSource = source();

    expect(appSource).not.toContain("Dreading the");
    expect(appSource).not.toContain("check-in queue");
    expect(appSource).not.toContain("front desk");
    expect(appSource).not.toContain("Hotel Grand");
    expect(appSource).not.toContain("feature-checkin-house-transparent");
    expect(appSource).not.toContain("data-one-checkin-hotel");
  });

  test("the artwork is not positioned from the viewport", async ({ page }) => {
    for (const height of [667, 812, 844, 932]) {
      await page.setViewportSize({ width: 390, height });
      await page.setContent(buildHtml());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const artNodes = [...document.querySelectorAll("[data-one-use-case-art], [data-one-feature-art-region]")];
        return artNodes.every((artNode) => {
          const card = artNode.closest("[data-one-use-case-card]");
          if (!card) return false;
          const cardRect = card.getBoundingClientRect();
          const art = artNode.getBoundingClientRect();
          return art.top >= cardRect.top && art.bottom <= cardRect.bottom + 1;
        });
      });

      expect(measured).toBe(true);
    }
  });

  for (const { w, h } of VIEWPORTS) {
    test(`keeps the story readable at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(buildHtml());
      await awaitProductFont(page);

      await expect(page.locator("[data-one-story-container]")).toBeVisible();
      await expect(page.locator("[data-one-use-case-card]")).toHaveCount(3);
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

      const measured = await page.evaluate(() => {
        const doc = document.documentElement;
        const cta = document
          .querySelector("[data-one-feature-cta]")!
          .getBoundingClientRect();
        const cards = [...document.querySelectorAll("[data-one-use-case-card]")].map((card) =>
          card.getBoundingClientRect(),
        );
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          shellVisibility: getComputedStyle(document.querySelector("[data-app-bottom-shell]")!)
            .visibility,
          minCardHeight: Math.min(...cards.map((card) => card.height)),
          ctaBottom: cta.bottom,
          viewportHeight: window.innerHeight,
        };
      });

      expect(measured.horizontalOverflow).toBe(false);
      expect(measured.shellVisibility).toBe("hidden");
      expect(measured.minCardHeight).toBeGreaterThanOrEqual(w <= 340 ? 130 : 150);
      if (w >= 390 && h >= 844) {
        expect(measured.ctaBottom).toBeLessThanOrEqual(measured.viewportHeight);
      }
    });
  }
});
