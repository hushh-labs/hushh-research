import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";
import { SECTION_TOC_RAIL_CLASSNAME } from "../components/app-ui/section-toc";

/**
 * Nothing a route paints may sit under the fixed top shell.
 *
 * The shell paints further down the screen than it reserves. The mask is solid
 * to `--top-shell-reserved-height` and then dissolves over `--top-fade-active`;
 * `--top-shell-mask-visible-height` is the sum, and it is the real bottom edge
 * of the header a person sees. Content that starts above that line is under the
 * header, whether or not it clears the reserved band.
 *
 * A fullscreen flow used to start its body at exactly the reserved height, so
 * every setup / claim / onboarding flow began 22px inside the dissolve. That is
 * invisible to a class assertion and invisible to JSDOM, which performs no
 * layout -- it only shows up as pixels, which is why this is a browser test.
 *
 * The offsets come from the real `resolveSignedInShellContentOffset`, and every
 * other token from the real `app/globals.css`, so neither can drift away from
 * what ships without failing here.
 *
 * Scope: routes with no contextual tab row, which is every flow route and the
 * common standard case. A tabbed route resolves a taller reserved height from
 * the same formula.
 *
 * Run with: npm run test:layout-contracts
 */

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440] as const;

type Mode = "standard" | "flow";

/** Compile the real stylesheet once per worker. */
async function buildStylesheet(candidates: string[]): Promise<string> {
  // Playwright runs from the webapp root (its config lives there).
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
  };

  // `@source` widens the scanner across the component tree for the real build.
  // Here the candidate list is explicit, so leaving them in would scan
  // thousands of files for utilities already named below.
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

  return compiler.build(candidates);
}

function inlineStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .map(([name, value]) => `${name}: ${String(value)};`)
    .join(" ");
}

/**
 * The shell as `app/providers.tsx` builds it: a fixed top bar whose mask is
 * `--top-shell-mask-visible-height` tall, and a scroll root that clears it
 * either with the standard spacer or with the fullscreen-flow shell's padding.
 */
function shellMarkup(mode: Mode): string {
  const offset = resolveSignedInShellContentOffset({
    shellVisible: true,
    routeLayoutMode: mode,
    localOffset: "0px",
  });

  const body =
    mode === "flow"
      ? `<main class="fullscreen-flow-shell" data-fullscreen-flow-shell="true">
           <p data-route-body>First line of the flow</p>
         </main>`
      : `<div data-app-shell-top-spacer="true" aria-hidden></div>
         <main class="app-page-shell" data-app-shell-width="standard">
           <p data-route-body>First line of the page</p>
         </main>`;

  // The derived geometry has to be re-declared here exactly as the route shell
  // declares it. Inheriting the `:root` definitions instead resolves the mask
  // against root's 8px fade rather than the shell's 22px, shortening the header
  // by 14px -- enough for a real clearance bug to pass. Flow routes never carry
  // contextual tabs.
  const shellStyle = inlineStyle({
    ...offset.style,
    ...resolveTopShellGeometryStyle({ hasTabs: false }),
  });

  return `<div data-app-shell-root="true" style="${shellStyle}">
      <div data-app-top-bar style="position: fixed; inset-inline: 0; top: 0; z-index: 50;">
        <div
          data-top-mask
          class="ambient-chrome-mask ambient-chrome-mask--top"
          style="height: var(--top-shell-mask-visible-height);"
        ></div>
      </div>
      <div data-app-scroll-root="true">
        ${body}
        <h2 data-section-header id="anchored-section">A jumped-to heading</h2>
        <aside class="${SECTION_TOC_RAIL_CLASSNAME}" data-toc-rail>Sections</aside>
      </div>
    </div>`;
}

const CANDIDATES = [
  "app-page-shell",
  "fullscreen-flow-shell",
  ...SECTION_TOC_RAIL_CLASSNAME.split(/\s+/),
];

/**
 * One shell per document, deliberately. Rendering both in one page put the
 * second one below the first in normal flow, where it cleared a viewport-fixed
 * header by hundreds of pixels and passed no matter what the offsets said.
 */
async function writeFixture(mode: Mode): Promise<string> {
  const css = await buildStylesheet(CANDIDATES);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-shell-top-clearance-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  /* The document primes the ambient mask on mount in the real app. Without the
     attribute the mask's wash resolves to 0%, which changes nothing this file
     measures (geometry, not colour) but keeps the fixture honest. */
  html { --top-chrome-collapse-px: 0px; }
  body { margin: 0; }
</style></head>
<body data-ambient-chrome-primed="true">${shellMarkup(mode)}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("app shell top clearance", () => {
  for (const mode of ["standard", "flow"] as const) {
    for (const width of WIDTHS) {
      test(`no ${mode} route content sits under the top shell at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(await writeFixture(mode));
        await page.evaluate(() => document.fonts.ready);

        const measured = await page.evaluate(() => {
          const mask = document.querySelector("[data-top-mask]")!;
          const body = document.querySelector("[data-route-body]")!;
          return {
            maskBottom: +mask.getBoundingClientRect().bottom.toFixed(2),
            bodyTop: +body.getBoundingClientRect().top.toFixed(2),
          };
        });

        // The bar is fixed to the viewport, so the mask's bottom is the
        // header's last visible pixel, and the scroll root starts at the
        // viewport top exactly as it does in the app.
        expect(
          measured.bodyTop,
          `${mode} route body starts at ${measured.bodyTop}px, under a header that paints to ${measured.maskBottom}px`,
        ).toBeGreaterThanOrEqual(measured.maskBottom);
      });
    }
  }

  test("a fullscreen flow clears the header's fade band, not only its reserved height", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await writeFixture("flow"));
    await page.evaluate(() => document.fonts.ready);

    const measured = await page.evaluate(() => {
      const px = (name: string) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;visibility:hidden;height:var(${name});`;
        document.querySelector("[data-app-shell-root]")!.appendChild(probe);
        const height = +probe.getBoundingClientRect().height.toFixed(2);
        probe.remove();
        return height;
      };
      const shell = document.querySelector(".fullscreen-flow-shell")!;
      return {
        reserved: px("--top-shell-reserved-height"),
        fade: px("--top-fade-active"),
        visible: px("--top-shell-mask-visible-height"),
        padTop: parseFloat(getComputedStyle(shell).paddingTop),
      };
    });

    // The regression this guards: padTop === reserved, leaving the fade band
    // painted over the first line.
    expect(measured.fade).toBeGreaterThan(0);
    expect(measured.visible).toBe(measured.reserved + measured.fade);
    expect(measured.padTop).toBeGreaterThan(measured.reserved);
    expect(measured.padTop).toBeGreaterThanOrEqual(measured.visible);
  });

  test("a jumped-to heading lands below the header, not inside its fade", async ({
    page,
  }) => {
    // scroll-margin-top decides where the browser parks a hash target. Reserving
    // only the solid part of the mask put every anchored heading 22px under the
    // header on every route that has anchors.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await writeFixture("standard"));
    await page.evaluate(() => document.fonts.ready);

    const measured = await page.evaluate(() => {
      const px = (name: string) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;visibility:hidden;height:var(${name});`;
        document.querySelector("[data-app-shell-root]")!.appendChild(probe);
        const height = +probe.getBoundingClientRect().height.toFixed(2);
        probe.remove();
        return height;
      };
      const heading = document.querySelector("[data-section-header]")!;
      return {
        visible: px("--top-shell-mask-visible-height"),
        reserved: px("--top-shell-reserved-height"),
        scrollMargin: parseFloat(
          getComputedStyle(heading).scrollMarginTop,
        ),
      };
    });

    expect(measured.scrollMargin).toBeGreaterThan(measured.reserved);
    expect(measured.scrollMargin).toBeGreaterThanOrEqual(measured.visible);
  });

  test("the desktop section rail pins below the header", async ({ page }) => {
    // lg: only -- the rail is display:none below 1024.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await writeFixture("standard"));
    await page.evaluate(() => document.fonts.ready);

    const measured = await page.evaluate(() => {
      const px = (name: string) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;visibility:hidden;height:var(${name});`;
        document.querySelector("[data-app-shell-root]")!.appendChild(probe);
        const height = +probe.getBoundingClientRect().height.toFixed(2);
        probe.remove();
        return height;
      };
      const rail = document.querySelector("[data-toc-rail]")!;
      const style = getComputedStyle(rail);
      return {
        visible: px("--top-shell-mask-visible-height"),
        reserved: px("--top-shell-reserved-height"),
        display: style.display,
        position: style.position,
        top: parseFloat(style.top),
      };
    });

    // If the rail stopped being a sticky lg: element this test would pass
    // vacuously, so assert the posture it is measuring.
    expect(measured.display).not.toBe("none");
    expect(measured.position).toBe("sticky");
    expect(measured.top).toBeGreaterThan(measured.reserved);
    expect(measured.top).toBeGreaterThanOrEqual(measured.visible);
  });
});
