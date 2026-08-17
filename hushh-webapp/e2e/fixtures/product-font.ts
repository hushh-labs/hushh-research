import fs from "node:fs";
import path from "node:path";

/**
 * The font the app actually ships, for fixtures that measure text.
 *
 * Every layout-contract fixture used to declare `-apple-system, system-ui,
 * sans-serif`, which resolves to whatever the machine happens to have: SF Pro
 * on a Mac, DejaVu Sans on an Ubuntu CI runner. The product ships neither — it
 * ships InterVariable (`app/globals.css`, `--font-family-product`).
 *
 * That went unnoticed for as long as these specs only ever ran on the author's
 * laptop. The first CI run of the pack failed 10 tests on font metrics alone:
 * `one-location-checkin-card` reported copy overlapping the artwork by 22px,
 * and the duration ladder wrapped to two rows at 768px. Both were artefacts of
 * a wider fallback face, not defects a person would ever see — and, worse, the
 * same divergence means a REAL overlap of a few px could pass on a Mac.
 *
 * A fixture that measures the wrong typeface is measuring a different app.
 *
 * The file is read from `public/fonts` and inlined as a data URI rather than
 * linked: fixtures are loaded over `file://`, where a relative font URL
 * resolves against the temporary directory and silently fails to load, leaving
 * the fallback in place with no error.
 */

let cachedCss: string | null = null;

/**
 * A `<style>` body: the real `@font-face` plus the family applied to `body`.
 * Drop it into any fixture that measures text width, wrapping or overlap.
 */
export function productFontStyle(): string {
  if (cachedCss) return cachedCss;

  // Playwright runs from the webapp root (its config lives there).
  const file = path.join(
    process.cwd(),
    "public/fonts/Inter/InterVariable.woff2",
  );
  const base64 = fs.readFileSync(file).toString("base64");

  cachedCss = `
@font-face {
  font-family: "InterVariable";
  src: url("data:font/woff2;base64,${base64}") format("woff2");
  /* block, not the app's swap: a fixture that starts measuring during the swap
     period measures the fallback face and reports numbers from a font the
     product does not use. */
  font-display: block;
  font-style: normal;
  font-weight: 100 900;
}
body {
  font-family: "InterVariable", "Inter", system-ui, sans-serif;
}
`;
  return cachedCss;
}

/**
 * Wait for the face to be usable before measuring.
 *
 * `font-display: block` keeps the fallback from being painted, but layout still
 * settles a frame later. Call this after `page.goto` and before any
 * `getBoundingClientRect`.
 */
export const AWAIT_PRODUCT_FONT = `document.fonts.ready.then(() => true)`;
