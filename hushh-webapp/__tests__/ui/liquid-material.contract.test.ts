import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Liquid Glass material (founder decision, 2026-09-20) is one CSS
 * utility driven by the theme accent, worn by every filled interactive
 * primitive, and static: nothing in it may cost a frame on a phone.
 */
const webRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => fs.readFileSync(path.join(webRoot, relativePath), "utf8");

function block(css: string, selector: string) {
  const start = css.indexOf(selector);
  expect(start, `${selector} present`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("liquid glass material", () => {
  const css = read("app/globals.css");

  it("is static: no blur, no animation, no layer promotion, no transition of its own", () => {
    for (const selector of [".morphy-liquid {", ".morphy-liquid:active:not(:disabled) {", ".morphy-liquid-neutral {"]) {
      const rule = block(css, selector);
      expect(rule).not.toMatch(/backdrop-filter|filter:|animation|will-change|transition/);
    }
  });

  it("follows the theme: tokens exist for light and dark, and the halo takes the fill colour with the accent as fallback", () => {
    const root = css.slice(css.indexOf("--liquid-gloss:"), css.indexOf("--liquid-gloss:") + 800);
    expect(root).toContain("--liquid-rim:");
    expect(root).toContain("--liquid-depth:");
    expect(css.match(/--liquid-gloss:/g)?.length).toBeGreaterThanOrEqual(2);
    expect(block(css, ".morphy-liquid {")).toContain("var(--liquid-base, var(--app-accent))");
    // The material never fixes a colour of its own: an accent change (Molten
    // Gold) or a destructive fill flows through --app-accent / --liquid-base.
    expect(block(css, ".morphy-liquid {")).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(0, 122/);
  });

  it("leaves background-color to the variant so hover and pressed fills still apply", () => {
    expect(block(css, ".morphy-liquid {")).not.toMatch(/background-color|background:/);
  });

  it("is worn by the filled button primitives and the first-screen CTA", () => {
    const variants = read("lib/ui/button-variants.ts");
    expect(variants).toMatch(/default:\s*\n?\s*"morphy-liquid /);
    expect(variants).toMatch(/destructive:\s*\n?\s*"morphy-liquid \[--liquid-base:var\(--app-destructive\)\]/);
    expect(variants).toMatch(/secondary:\s*\n?\s*"morphy-liquid-neutral /);
    expect(variants).toMatch(/outline:\s*\n?\s*"morphy-liquid-neutral /);
    const morphy = read("lib/morphy-ux/utils.ts");
    expect(morphy).toContain('"morphy-liquid bg-[var(--app-accent)]');
    const intro = read("components/onboarding/IntroStep.tsx");
    expect(intro).toContain("morphy-liquid ${styles.cta}");
    const introCss = read("components/onboarding/IntroStep.module.css");
    expect(introCss).not.toContain("cta-material.png");
  });
});
