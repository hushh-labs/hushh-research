import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import { INPUT_CLASSNAME } from "../components/ui/input";

/**
 * The two stacked controls under "API endpoint" on Choose your AI, measured in
 * a real browser — and specifically in WebKit, because WebKit is the whole
 * reason this file exists.
 *
 * Reported: the transport picker and the key field under it do not share a
 * corner radius. The obvious fix is to hand the <select> the same classes the
 * <input> already uses. That fix is not enough, and a Chromium-only test would
 * have said it was.
 *
 * A native <select> defaults to `appearance: menulist`, and under that value
 * WebKit draws the control itself and IGNORES the author's border-radius and
 * padding. Measured here: with the input's classes but no `appearance-none`,
 * WebKit still computes ~5px against the input's 14px — the reported mismatch
 * survives, on the engine inside the iOS app, where most of our users are.
 * Chromium honours the author radius either way, so it reports the fix as
 * working. This spec pins the property that actually makes the two agree.
 *
 * The class strings are imported from the shipped module rather than copied, so
 * this cannot pass against a stale copy of them.
 *
 * Run: npx playwright test e2e/gemini-endpoint-fields.layout.spec.ts
 */

/** The exact classes the select carries in gemini-runtime-settings-card.tsx. */
const SELECT_CLASSNAME = `${INPUT_CLASSNAME} appearance-none bg-no-repeat pr-9`;

/** The same control WITHOUT appearance-none — the fix that looks right and is not. */
const SELECT_WITHOUT_APPEARANCE = `${INPUT_CLASSNAME} pr-9`;

const WIDTHS = [320, 360, 375, 390, 430] as const;

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

  const markup = `
    <label class="block space-y-1">API endpoint
      <select data-testid="endpoint-select" class="${SELECT_CLASSNAME}">
        <option>Google AI Studio</option>
        <option>Google Cloud Vertex API key</option>
      </select>
    </label>
    <input data-testid="key-input" class="${INPUT_CLASSNAME}"
           placeholder="Paste a Google AI Studio Gemini key" />
    <select data-testid="regression-select" class="${SELECT_WITHOUT_APPEARANCE}">
      <option>Google AI Studio</option>
    </select>`;

  const used = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  const css = compiler.build([...used]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-endpoint-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  /* The app shell's own tokens, which this fixture has no shell to inherit. */
  :root {
    --app-radius-md: 14px;
    --app-separator: rgba(60,60,67,.12);
    --app-secondary-surface: #f9f9fb;
    --app-accent: #087ff5;
    --app-focus-ring: rgba(8,127,245,.35);
  }
  body { margin: 0; }
${productFontStyle()}
  .stack { display: grid; gap: 8px; padding: 0 16px; }
</style></head><body><div class="stack">${markup}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type Probe = {
  radius: string;
  height: number;
  paddingLeft: string;
  appearance: string;
  right: number;
  left: number;
};

async function probe(page: import("@playwright/test").Page, testId: string): Promise<Probe> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      radius: cs.borderTopLeftRadius,
      height: box.height,
      paddingLeft: cs.paddingLeft,
      appearance: cs.appearance,
      right: box.right,
      left: box.left,
    };
  }, testId);
}

test.describe("Choose your AI — API endpoint fields", () => {
  for (const width of WIDTHS) {
    test(`the picker and the key field agree at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const select = await probe(page, "endpoint-select");
      const input = await probe(page, "key-input");

      // The reported defect, in one line: the two stacked controls under one
      // label must share a corner.
      expect(select.radius).toBe(input.radius);
      expect(parseFloat(select.radius)).toBeGreaterThan(8);

      // And the rest of the pairing, which was also off: 40px vs 44px tall,
      // and text inset 12px vs 14px.
      expect(Math.abs(select.height - input.height)).toBeLessThanOrEqual(0.5);
      expect(select.paddingLeft).toBe(input.paddingLeft);

      // Both stay on the page.
      expect(select.left).toBeGreaterThanOrEqual(-0.5);
      expect(select.right).toBeLessThanOrEqual(width + 0.5);
    });
  }

  test("appearance-none is load-bearing, not decoration", async ({
    page,
    browserName,
  }) => {
    // The mutation check, run as a test rather than by hand: the same control
    // without `appearance-none`. On WebKit it must NOT match the input, which
    // is what proves the property is doing the work. Chromium honours the
    // author radius regardless, so it can only be asserted as a no-worse case
    // there — recording exactly why a Chromium-only run cannot gate this.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await buildFixture());
    await awaitProductFont(page);

    const input = await probe(page, "key-input");
    const withoutAppearance = await probe(page, "regression-select");
    const fixed = await probe(page, "endpoint-select");

    expect(fixed.radius).toBe(input.radius);

    if (browserName === "webkit") {
      expect(withoutAppearance.appearance).not.toBe("none");
      expect(withoutAppearance.radius).not.toBe(input.radius);
      expect(parseFloat(withoutAppearance.radius)).toBeLessThan(
        parseFloat(input.radius),
      );
    }
  });
});
