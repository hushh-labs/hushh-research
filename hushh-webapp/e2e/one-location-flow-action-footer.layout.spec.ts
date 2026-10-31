import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * The pinned action bar in a Location flow must clear whatever is under it.
 *
 * `STICKY_FLOW_ACTION_CLASSNAME` in `location-redesign-hub.tsx` pins Continue on
 * step 1 of the Share and Ask flows, and Send on step 2 of Ask. It sticks to
 * `bottom: 0` of `[data-app-scroll-root]` — and the app's fixed bottom chrome
 * (the tab bar plus the "Talk to One" bar) overlays that same edge. So the bar
 * has to reserve the chrome's height itself, and on iOS the on-screen keyboard
 * as well: the field a person just typed into is on this very screen.
 *
 * That reserve has been written twice and lost twice — #5698 added
 * `--kb-height`, `9d67a4f20` dropped it — because nothing failed when it went.
 * jsdom cannot catch it: it applies no CSS and measures every element as 0x0,
 * so `className.toContain("sticky")` passes against a bar sitting underneath
 * the navigation. This measures the rendered geometry instead.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE through the tablet width the issue asks for. */
const WIDTHS = [320, 375, 390, 430, 768] as const;

/**
 * What `AppBottomShell` publishes once it has measured itself: the Talk-to-One
 * bar and the tab bar. The exact number does not matter — every budget below is
 * expressed in terms of it.
 */
const BOTTOM_SHELL_HEIGHT_PX = 132;

/** A real iOS keyboard, as `KeyboardInsetManager` would publish it. */
const KEYBOARD_HEIGHT_PX = 291;

/** The breathing room the bar keeps above the chrome: its own `0.75rem`. */
const BAR_GAP_PX = 12;

/**
 * Sub-pixel line boxes only. A regression that drops the reserve lands a whole
 * chrome height outside this; one that adds a hidden bar to the keyboard
 * instead of taking the larger of the two lands the same distance the other
 * way.
 */
const SLACK_PX = 4;

const FLOW_ACTION_CLASSNAME =
  "sticky bottom-0 z-20 -mx-1 px-1 pb-[calc(max(var(--kb-height,0px)-var(--app-scroll-bottom-pad,0px),var(--app-safe-area-bottom-effective,0px))+0.75rem)] pt-3";

const BUTTON_CLASSNAME = "h-[52px] w-full rounded-2xl";

async function buildStylesheet(candidates: string[]): Promise<string> {
  const webappRoot = process.cwd();
  // `pathToFileURL`, not a bare path: the ESM loader rejects a Windows absolute
  // path as an unknown "c:" scheme, and this suite runs locally as well as in
  // CI.
  const { compile } = (await import(
    pathToFileURL(
      path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs"),
    ).href
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

  return stripAppFontFaces(compiler.build(candidates));
}

/**
 * The signed-in shell as `app/providers.tsx` builds it for a standard route.
 *
 * `--bottom-chrome-stack-height` and `--app-scroll-bottom-pad` are declared
 * here rather than left to their `:root` fallbacks, for the same reason the
 * sibling shell spec declares them: the fallbacks resolve to a different, much
 * smaller number, and a real bug would pass.
 */
function shellMarkup(): string {
  const shellStyle = [
    `--app-bottom-shell-height: ${BOTTOM_SHELL_HEIGHT_PX}px`,
    "--bottom-chrome-stack-height: var(--app-bottom-shell-height)",
    "--app-scroll-bottom-pad: var(--bottom-chrome-stack-height)",
    // What the navbar publishes once it has measured itself.
    // `--app-bottom-inset` composes this with the safe area, and is what the
    // bar reserves.
    `--app-bottom-fixed-ui: ${BOTTOM_SHELL_HEIGHT_PX}px`,
    "position: fixed",
    "inset: 0",
    "display: flex",
    "flex-direction: column",
  ].join("; ");

  return `<div data-app-shell-root="true" style="${shellStyle}">
      <div
        data-app-scroll-root="true"
        style="flex: 1 1 0%; min-height: 0; overflow-y: auto; padding-bottom: var(--app-scroll-bottom-pad);"
      >
        <div data-flow>
          <div data-roster style="height: 1600px; background: #ddd;">Roster</div>
          <div data-action-bar class="${FLOW_ACTION_CLASSNAME}">
            <button data-primary-action type="button" class="${BUTTON_CLASSNAME}" style="background: #0a84ff; color: #fff;">
              Continue
            </button>
          </div>
        </div>
      </div>
      <div
        data-bottom-chrome
        style="position: fixed; inset-inline: 0; bottom: 0; height: var(--bottom-chrome-stack-height); background: rgba(0,0,0,0.06);"
      ></div>
    </div>`;
}

async function writeFixture(): Promise<string> {
  const css = await buildStylesheet([
    ...FLOW_ACTION_CLASSNAME.split(" "),
    ...BUTTON_CLASSNAME.split(" "),
  ]);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "one-location-flow-action-footer-"),
  );
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>body { margin: 0; }</style></head>
<body data-ambient-chrome-primed="true">${shellMarkup()}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/** Where the action sits, relative to the chrome and the scrollport floor. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const action = document.querySelector<HTMLElement>(
      "[data-primary-action]",
    )!;
    const chrome = document.querySelector<HTMLElement>("[data-bottom-chrome]")!;
    const scrollRoot = document.querySelector<HTMLElement>(
      "[data-app-scroll-root]",
    )!;
    const roster = document.querySelector<HTMLElement>("[data-roster]")!;
    return {
      actionBottom: +action.getBoundingClientRect().bottom.toFixed(2),
      chromeTop: +chrome.getBoundingClientRect().top.toFixed(2),
      scrollportBottom: +scrollRoot.getBoundingClientRect().bottom.toFixed(2),
      // Pinned, not merely present: the bar has to be on screen while the
      // roster still runs off the bottom, or this measures a bar that simply
      // scrolled into view.
      rosterRunsOffScreen:
        roster.getBoundingClientRect().bottom > window.innerHeight,
    };
  });
}

test.describe("one location flow action footer", () => {
  for (const width of WIDTHS) {
    test(`the pinned action clears the bottom chrome at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const measured = await measure(page);

      expect(measured.rosterRunsOffScreen).toBe(true);
      // Above the chrome, not underneath it.
      expect(measured.actionBottom).toBeLessThanOrEqual(measured.chromeTop);
      // And not a whole bar's height too high: the gap is the bar's own
      // `0.75rem`, nothing more.
      expect(measured.chromeTop - measured.actionBottom).toBeLessThanOrEqual(
        BAR_GAP_PX + SLACK_PX,
      );
    });

    test(`the pinned action clears the on-screen keyboard at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      // What KeyboardInsetManager does on a real on-screen keyboard. globals.css
      // hides the whole bottom shell under `html.kb-open`, so the keyboard — not
      // the chrome — is what the bar has to clear here.
      await page.evaluate((keyboardHeight) => {
        document.documentElement.classList.add("kb-open");
        document.documentElement.style.setProperty(
          "--kb-height",
          `${keyboardHeight}px`,
        );
      }, KEYBOARD_HEIGHT_PX);

      const measured = await measure(page);
      const keyboardTop = measured.scrollportBottom - KEYBOARD_HEIGHT_PX;

      expect(measured.actionBottom).toBeLessThanOrEqual(keyboardTop);
      // The larger of the two, never their sum. Adding the hidden chrome to the
      // keyboard would strand the action a full bar's height above the field it
      // belongs to.
      expect(keyboardTop - measured.actionBottom).toBeLessThanOrEqual(
        BAR_GAP_PX + SLACK_PX,
      );
    });
  }
});
