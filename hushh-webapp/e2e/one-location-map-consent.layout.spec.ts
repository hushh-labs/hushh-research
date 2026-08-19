import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

/**
 * The renderer-consent card on Your Map, hit-tested in a real engine.
 *
 * Reported from UAT: the "Continue" button on `/one/location/map` did nothing.
 * The cause was state — `acceptRenderer` returned on a null owner token — and
 * that half is locked by unit tests. This file exists for the half a unit test
 * structurally cannot answer.
 *
 * jsdom performs no layout and no hit-testing, so a card can be perfectly
 * wired and still be untappable: a full-screen sibling at the same z-index but
 * later in the DOM paints over it, and the click lands on the sibling with no
 * error anywhere. That is not a hypothetical shape on this screen — the map's
 * own loading overlay is `absolute inset-0 z-20`, the disclosure card is also
 * `z-20`, and the ONLY thing separating them is DOM order. Swap those two JSX
 * blocks and every unit test still passes while the button becomes unreachable.
 *
 * So the contract measured here is: at every supported phone size, in both map
 * states, the point at the centre of that button belongs to that button.
 *
 * Every class string is READ OUT OF THE COMPONENT at test time rather than
 * copied, so the fixture cannot drift away from the screen it claims to
 * measure — including the DOM order of the two z-20 layers, which is asserted
 * against the source directly.
 *
 * Run: npx playwright test e2e/one-location-map-consent.layout.spec.ts
 */

const MAP_SOURCE_PATH = path.join(
  process.cwd(),
  "components/one-location/location-immersive-map.tsx",
);
const BUTTON_SOURCE_PATH = path.join(process.cwd(), "components/ui/button.tsx");

/** iPhone SE through 15 Pro Max, plus the narrowest width the product supports. */
const VIEWPORTS = [
  { name: "iPhone SE (1st gen)", w: 320, h: 568 },
  { name: "iPhone SE (2nd/3rd gen)", w: 375, h: 667 },
  { name: "iPhone 13 mini", w: 375, h: 812 },
  { name: "iPhone 15", w: 393, h: 852 },
  { name: "iPhone 15 Pro Max", w: 430, h: 932 },
  { name: "tablet", w: 768, h: 1024 },
] as const;

const SOURCE = fs.readFileSync(MAP_SOURCE_PATH, "utf8");

/**
 * The className string literal on the element carrying `data-testid={id}`.
 *
 * Anchors on the testid and walks BACK to the nearest `className="…"`, which is
 * how these elements are actually written — className first, testid second.
 */
function classNameForTestId(id: string): string {
  const at = SOURCE.indexOf(`data-testid="${id}"`);
  if (at < 0) throw new Error(`no element carries data-testid="${id}"`);
  const before = SOURCE.slice(0, at);
  const match = [...before.matchAll(/className="([^"]*)"/g)].pop();
  if (!match) throw new Error(`no className precedes data-testid="${id}"`);
  return match[1].replace(/\s+/g, " ").trim();
}

/** The accent fill the accept button carries, resolved from its own constant. */
function accentClassName(): string {
  const match = SOURCE.match(
    /const MAP_ACCENT_ACTIVE_CLASSNAME =\s*"([^"]*)"/,
  );
  if (!match) throw new Error("MAP_ACCENT_ACTIVE_CLASSNAME is gone");
  return match[1];
}

/** The shadcn button base + default variant + default size, from source. */
function buttonClassName(): string {
  const source = fs.readFileSync(BUTTON_SOURCE_PATH, "utf8");
  const base = source.match(/const buttonVariants = cva\(\s*"([^"]*)"/);
  const size = source.match(/default:\s*\n?\s*"(ui-text-button-label[^"]*)"/);
  if (!base || !size) throw new Error("button variants changed shape");
  return `${base[1]} ${size[1]}`;
}

/** The disclosure card's inline bottom offset, read from its own style prop. */
function disclosureBottom(): string {
  const match = SOURCE.match(/style=\{\{ bottom: "(max\([^"]*\))" \}\}/);
  if (!match) throw new Error("the disclosure card lost its bottom offset");
  return match[1];
}

async function buildFixture(options: {
  loadingOverlayMounted: boolean;
  label: string;
}): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
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

  // The native canvas is a custom element the plugin composites UNDER the
  // WebView. In the browser it is an ordinary full-bleed sibling, which is
  // exactly the layer being tested against.
  const mapCanvas = `<capacitor-google-map class="absolute inset-0 block h-full w-full"></capacitor-google-map>`;
  const loadingOverlay = options.loadingOverlayMounted
    ? `<div class="${classNameForTestId("one-location-map-loading")}" data-testid="one-location-map-loading"></div>`
    : "";
  const card = `
<section class="${classNameForTestId("one-location-map-disclosure")}" data-testid="one-location-map-disclosure" style="bottom: ${disclosureBottom()}">
  <h1 class="mt-3 text-xl font-semibold">Your Map</h1>
  <p class="mt-2 text-sm leading-6 text-muted-foreground">Private shares open only on this device. Google Maps gets only what it needs to draw them. Nearby Check-In is separate &mdash; it starts only when you do.</p>
  <button class="${buttonClassName()} mt-4 w-full ${accentClassName()}" data-testid="one-location-map-disclosure-accept">${options.label}</button>
</section>`;

  const html = `<div class="${classNameForTestId("one-location-map")}" data-testid="one-location-map">${mapCanvas}${loadingOverlay}${card}</div>`;

  const used = new Set<string>();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  const css = compiler.build([...used]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-consent-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  :root {
    --app-accent: #0a84ff; --app-accent-fg: #ffffff; --app-accent-hover: #0872df;
    --app-accent-deep: #0a5bb8; --app-accent-bright: #4aa8ff; --app-focus-ring: #0a84ff;
    --background: #ffffff; --foreground: #0b0b0c; --muted-foreground: #6b7280;
    --border: #d8dce2; --app-separator: #d8dce2;
  }
  html, body { margin: 0; height: 100%; background: #eef2f7; }
  .bg-background\\/95 { background-color: rgba(255,255,255,.95); }
  .text-muted-foreground { color: var(--muted-foreground); }
  .border-border\\/60 { border-color: var(--border); }
${productFontStyle()}
</style></head><body>${html}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("Your Map renderer-consent card is reachable", () => {
  test("the card is painted after the full-screen loading overlay, not before", () => {
    // The whole hit-test below rests on this one fact. Both layers are z-20, so
    // at equal z-index DOM order alone decides which one receives the tap.
    const overlayAt = SOURCE.indexOf('data-testid="one-location-map-loading"');
    const cardAt = SOURCE.indexOf('data-testid="one-location-map-disclosure"');
    expect(overlayAt).toBeGreaterThan(-1);
    expect(cardAt).toBeGreaterThan(overlayAt);
  });

  for (const { name, w, h } of VIEWPORTS) {
    for (const overlay of [false, true]) {
      for (const label of ["Continue", "Set a lock"]) {
        const state = overlay ? "while the map is still loading" : "once the map is drawn";
        test(`"${label}" is tappable on ${name} (${w}x${h}) ${state}`, async ({
          page,
        }) => {
          await page.setViewportSize({ width: w, height: h });
          await page.goto(
            await buildFixture({ loadingOverlayMounted: overlay, label }),
          );
          await awaitProductFont(page);

          const cta = page.getByTestId("one-location-map-disclosure-accept");
          const box = await cta.boundingBox();
          expect(box, "the accept button has no box at all").not.toBeNull();
          if (!box) return;

          // Inside the viewport. A control pushed past the fold is a control
          // nobody taps, and the card is anchored to the bottom edge.
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(h + 0.5);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(w + 0.5);

          // Apple's minimum, which this button clears by design (50px).
          expect(box.height).toBeGreaterThanOrEqual(44);

          // The label is one line and is not clipped by its own box.
          const clipped = await cta.evaluate(
            (el) => el.scrollWidth > el.clientWidth + 1,
          );
          expect(clipped, "the label is cut off").toBe(false);

          // THE contract: the point a finger lands on belongs to the button.
          const owner = await page.evaluate(
            ({ x, y }) => {
              const hit = document.elementFromPoint(x, y);
              if (!hit) return "nothing";
              const button = hit.closest(
                '[data-testid="one-location-map-disclosure-accept"]',
              );
              return button
                ? "the accept button"
                : `${hit.tagName.toLowerCase()}${
                    hit.getAttribute("data-testid")
                      ? `[${hit.getAttribute("data-testid")}]`
                      : ""
                  }`;
            },
            { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          );
          expect(owner).toBe("the accept button");

          // And a real click reaches it rather than something over it.
          // Playwright's own actionability check fails loudly if it does not.
          await cta.click({ timeout: 2_000 });
        });
      }
    }
  }
});
