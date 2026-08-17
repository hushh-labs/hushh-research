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
 * Remove the app's own `@font-face` rules from a compiled `globals.css`.
 *
 * They point at `/fonts/Inter/InterVariable.woff2`, an absolute path that a
 * fixture loaded over `file://` resolves against the filesystem root. It never
 * resolves, and it fails silently.
 *
 * That matters beyond one dead request: those broken faces register under the
 * SAME family as the working one this module inlines, and a family with an
 * unloadable face in it does not satisfy `document.fonts.check`. The fixture
 * then quietly renders in the machine's fallback while three "InterVariable"
 * faces sit in `document.fonts` looking like success.
 *
 * Call this on any stylesheet built from `app/globals.css`.
 */
export function stripAppFontFaces(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*url\([^)]*\/fonts\/[^)]*\)[^}]*\}/g, "");
}

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
 * Wait for the face, then PROVE it is the one being used.
 *
 * `document.fonts.ready` resolves whether or not the face loaded, so awaiting
 * it alone is not evidence — a fixture whose `@font-face` failed sails past it
 * and measures the machine's fallback, which is the exact failure this module
 * exists to remove. `fonts.check` is the assertion that closes it.
 *
 * The cost of not having this: the live-share countdown contract went red on a
 * CI runner with a 3.7px drift, which is the proportional-vs-tabular figure
 * difference exactly. Whether the font was missing or the digits were was
 * unanswerable from the failure message.
 *
 * Call after `page.goto` and before any `getBoundingClientRect`.
 */
export async function awaitProductFont(page: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}): Promise<void> {
  const state = await page.evaluate(async () => {
    await document.fonts.ready;
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;visibility:hidden;font:400 16px InterVariable";
    probe.textContent = "0123456789";
    document.body.appendChild(probe);
    const usedFamily = getComputedStyle(document.body).fontFamily;
    probe.remove();
    return {
      loaded: document.fonts.check('16px "InterVariable"'),
      faces: [...document.fonts].map((f) => f.family),
      usedFamily,
    };
  });

  if (!state.loaded) {
    throw new Error(
      `The product font never loaded, so this fixture would measure the machine's fallback instead. ` +
        `Registered faces: ${JSON.stringify(state.faces)}. body font-family: ${state.usedFamily}`,
    );
  }
}
