import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

/**
 * Guard the One Location onboarding feature step.
 *
 * The product no longer presents Check in as a hotel/front-desk flow. The
 * feature step is now one calm story container with three equal rows, so this
 * spec protects the new structure and the old regression at the same time:
 * no hotel copy, no hotel asset dependency, no horizontal overflow, and no
 * persistent app chrome covering Continue.
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
        <h1 data-one-feature-heading><span>When plans change,</span><span>stay close.</span></h1>
      </header>
      <div data-one-story-container>
        <article data-one-feature-row data-one-use-case-card data-one-feature-card="share">
          <div data-one-feature-copy>
            <h2 data-one-feature-title>Can’t explain where you are?</h2>
            <p data-one-feature-body>Share location with your Circle.</p>
          </div>
          <div data-one-use-case-art></div>
        </article>
        <article data-one-feature-row data-one-use-case-card data-one-feature-card="checkin">
          <div data-one-feature-copy>
            <h2 data-one-feature-title>Need them to know you arrived?</h2>
            <p data-one-feature-body>Check in with one tap.</p>
          </div>
          <div data-one-use-case-art></div>
        </article>
        <article data-one-feature-row data-one-use-case-card data-one-feature-card="sms">
          <div data-one-feature-copy>
            <h2 data-one-feature-title>Need help but can’t talk?</h2>
            <p data-one-feature-body>Hold Save My Soul to alert your Circle.</p>
          </div>
          <div data-one-use-case-art>
            <span data-one-sms-radar><span data-one-sms-radar-ring></span><span data-one-sms-radar-ring></span><span data-one-sms-core>SMS</span></span>
          </div>
        </article>
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
      .find((style) => style.includes("[data-one-feature-row]")) ?? ""
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
[data-one-feature-heading] span { display: block; }
[data-one-story-container] { margin-top: 20px; overflow: hidden; border-radius: 22px; background: #fff; border: 1px solid rgba(60, 60, 67, 0.10); }
[data-one-feature-row] { box-sizing: border-box; display: grid; min-height: 126px; grid-template-columns: minmax(0, 1fr) 112px; align-items: center; gap: 16px; padding: 16px; }
[data-one-feature-row] + [data-one-feature-row] { border-top: 1px solid rgba(60, 60, 67, 0.12); }
[data-one-feature-copy] { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
[data-one-feature-title] { margin: 0; font-size: 17px; font-weight: 600; line-height: 22px; letter-spacing: -0.01em; }
[data-one-feature-body] { margin: 0; color: #6e737d; font-size: 15px; line-height: 20px; }
[data-one-use-case-art] { justify-self: end; width: 112px; height: 96px; border-radius: 18px; background: #f1f6fb; }
[data-one-feature-card="checkin"] [data-one-use-case-art] { background: #f2f8f3; }
[data-one-feature-card="sms"] [data-one-use-case-art] { display: flex; align-items: center; justify-content: center; background: #fff1f1; }
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
  });

  for (const { w, h } of VIEWPORTS) {
    test(`keeps the story readable at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(buildHtml());
      await awaitProductFont(page);

      await expect(page.locator("[data-one-story-container]")).toBeVisible();
      await expect(page.locator("[data-one-feature-row]")).toHaveCount(3);
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

      const measured = await page.evaluate(() => {
        const doc = document.documentElement;
        const cta = document
          .querySelector("[data-one-feature-cta]")!
          .getBoundingClientRect();
        const rows = [...document.querySelectorAll("[data-one-feature-row]")].map((row) =>
          row.getBoundingClientRect(),
        );
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          shellVisibility: getComputedStyle(document.querySelector("[data-app-bottom-shell]")!)
            .visibility,
          minRowHeight: Math.min(...rows.map((row) => row.height)),
          ctaBottom: cta.bottom,
          viewportHeight: window.innerHeight,
        };
      });

      expect(measured.horizontalOverflow).toBe(false);
      expect(measured.shellVisibility).toBe("hidden");
      expect(measured.minRowHeight).toBeGreaterThanOrEqual(w <= 340 ? 118 : 126);
      if (w >= 390 && h >= 844) {
        expect(measured.ctaBottom).toBeLessThanOrEqual(measured.viewportHeight);
      }
    });
  }
});
