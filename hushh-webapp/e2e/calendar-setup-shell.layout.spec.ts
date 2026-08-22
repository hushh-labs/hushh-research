import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  CALENDAR_SETUP_REGION_CLASSNAME,
  CALENDAR_SETUP_SHELL_CLASSNAME,
} from "../components/calendar/calendar-agent-page-layout";

/**
 * One screenshot: the Calendar setup screen rendered as a blue "Connect
 * Calendar" button cutting through a ~2rem white sliver, on an otherwise empty
 * page. No card header, no title, no footer.
 *
 * The cause was the shell, not the card. It pinned itself with
 *
 *   fixed inset-x-0 top-[64px] bottom-[115px] ... justify-center overflow-hidden
 *
 * so its height came from the viewport, it could not scroll, and its children
 * kept the flex default `flex-shrink: 1`. On a viewport shorter than the card,
 * every child shrank until it fit and `overflow-hidden` cut what was left. The
 * button kept its `h-11` and so hung out of the collapsed card.
 *
 * None of that is visible to the JSDOM suite, which applies no CSS and measures
 * every element as 0x0 -- a className assertion passed for as long as the screen
 * was broken. So the sibling JSDOM test proves the component still renders these
 * class strings, and this file proves what the strings DO, at the viewport
 * heights the bug was reported on.
 *
 * The screen is behind sign-in and a setup journey, so this renders the real
 * class strings imported from the module the screen itself imports, exactly as
 * circle-member-row.layout.spec.ts does.
 *
 * Run with: npx playwright test e2e/calendar-setup-shell.layout.spec.ts
 */

/** The reported break was a short window. 320 is also a landscape phone. */
const VIEWPORT_HEIGHTS = [320, 420, 560, 800] as const;
const VIEWPORT_WIDTH = 960;
const PAGE_PADDING_PX = 16;

/** The shell as it shipped before this fix, kept so the test can show the delta. */
const REGRESSED_SHELL_CLASSNAME =
  "motion-step-enter fixed inset-x-0 top-[64px] bottom-[115px] z-10 m-auto flex w-full max-w-[720px] flex-col items-center justify-center overflow-hidden px-4";

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

  return stripAppFontFaces(compiler.build(candidates));
}

async function buildFixture(name: string, body: string, candidates: string[]) {
  const webappRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  let css = await buildStylesheet(candidates);

  const fontSource = path.join(webappRoot, "public/fonts/Inter");
  if (fs.existsSync(fontSource)) {
    fs.cpSync(fontSource, path.join(dir, "fonts/Inter"), { recursive: true });
    css = css.replace(/url\(["']?\/fonts\//g, 'url("./fonts/');
  }

  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css"></head>
<body style="margin:0">${body}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/**
 * The real screen's structure, trimmed to what decides the geometry: the shell,
 * the two measure-sharing regions, and a card whose header + body + button are
 * the tall thing that has to survive.
 */
function screenMarkup(shellClassName: string) {
  return `
<main class="app-page-shell ${shellClassName}" data-app-shell-width="reading" data-testid="shell">
  <div class="app-page-header-region w-full min-w-0 ${CALENDAR_SETUP_REGION_CLASSNAME} text-center">
    <h1 class="type-display" data-testid="page-title">Calendar</h1>
  </div>
  <div class="app-page-content-region w-full min-w-0 ${CALENDAR_SETUP_REGION_CLASSNAME}">
    <section class="overflow-hidden w-full shadow-md text-center rounded-[var(--app-card-radius)] border border-border bg-card" data-testid="card">
      <div class="pb-3 pt-5 flex flex-col items-center text-center space-y-0.5">
        <div class="flex size-11 items-center justify-center rounded-[12px] bg-primary/10 text-primary mb-2"></div>
        <div class="text-lg font-semibold tracking-tight">Connect Google Calendar</div>
        <div class="text-xs text-muted-foreground">One reads your schedule to help you plan.</div>
      </div>
      <div class="space-y-4 pt-0 px-4 pb-4">
        <div class="border-t border-border/60 pt-4 pb-1">
          <div class="flex flex-col items-center justify-center text-center space-y-3 w-full">
            <button class="w-full justify-center h-11 text-base font-semibold shadow-sm rounded-full bg-[var(--app-accent)] text-[var(--app-accent-fg)]" data-testid="connect">Connect Calendar</button>
            <p class="text-xs text-muted-foreground text-center">Private by default. Disconnect anytime.</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</main>`;
}

const CANDIDATES = [
  ...CALENDAR_SETUP_SHELL_CLASSNAME.split(/\s+/),
  "gap-4",
  ...REGRESSED_SHELL_CLASSNAME.split(/\s+/),
  ...CALENDAR_SETUP_REGION_CLASSNAME.split(/\s+/),
  "app-page-shell",
  "app-page-header-region",
  "app-page-content-region",
  "type-display",
  "overflow-hidden",
  "w-full",
  "min-w-0",
  "shadow-md",
  "text-center",
  "rounded-[var(--app-card-radius)]",
  "border",
  "border-border",
  "border-border/60",
  "border-t",
  "bg-card",
  "pb-3",
  "pt-5",
  "pt-0",
  "pt-4",
  "pt-1",
  "pb-1",
  "pb-4",
  "px-4",
  "flex",
  "flex-col",
  "items-center",
  "justify-center",
  "space-y-0.5",
  "space-y-3",
  "space-y-4",
  "size-11",
  "rounded-[12px]",
  "rounded-full",
  "bg-primary/10",
  "text-primary",
  "mb-2",
  "text-lg",
  "font-semibold",
  "tracking-tight",
  "text-xs",
  "text-muted-foreground",
  "text-base",
  "h-11",
  "bg-[var(--app-accent)]",
  "text-[var(--app-accent-fg)]",
];

async function boxes(page: Page) {
  return page.evaluate(() => {
    const read = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
    };
    return {
      shell: read("shell"),
      card: read("card"),
      connect: read("connect"),
      docScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
}

test.describe("Calendar setup shell", () => {
  for (const height of VIEWPORT_HEIGHTS) {
    test(`keeps the whole card on the page at ${VIEWPORT_WIDTH}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: VIEWPORT_WIDTH, height });
      const url = await buildFixture(
        "calendar-shell",
        `<div style="padding:0 ${PAGE_PADDING_PX}px">${screenMarkup(
          CALENDAR_SETUP_SHELL_CLASSNAME,
        )}</div>`,
        CANDIDATES,
      );
      await page.goto(url);
      await awaitProductFont(page);

      const m = await boxes(page);
      expect(m.card, "card must render").not.toBeNull();
      expect(m.connect, "connect button must render").not.toBeNull();

      // The card keeps its own height rather than being squeezed: a header,
      // a button and a helper line cannot fit in a sliver.
      expect(m.card!.height).toBeGreaterThan(140);

      // The button sits inside its card.
      expect(m.connect!.top).toBeGreaterThanOrEqual(m.card!.top - 1);
      expect(m.connect!.bottom).toBeLessThanOrEqual(m.card!.bottom + 1);

      // The invariant that actually broke: every part of the card must be
      // REACHABLE. In normal flow the shell grows with its content, so the card
      // never extends past it, and a viewport shorter than the page scrolls
      // far enough to reach the card's last pixel.
      //
      // Both comparisons carry a 1px tolerance because getBoundingClientRect
      // returns fractions while scrollHeight is an integer: a card ending at
      // 320.5 in a 320 viewport is not a clipped card, it is a rounded one, and
      // the first version of this assertion failed on exactly that.
      expect(m.card!.bottom).toBeLessThanOrEqual(m.shell!.bottom + 1);
      if (m.card!.bottom > m.viewportHeight + 1) {
        expect(m.docScrollHeight).toBeGreaterThanOrEqual(
          Math.floor(m.card!.bottom),
        );
      }
    });
  }

  test("centres the card when the screen has room for it", async ({ page }) => {
    // What "clean" means on a desktop-height screen, and what the first fix
    // gave away: the card sat at the very top of a tall empty page. `min-h` +
    // justify-center restores the composition without reintroducing the clip,
    // because a floor grows and a fixed height does not.
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 900 });
    const url = await buildFixture(
      "calendar-shell-tall",
      `<div style="padding:0 ${PAGE_PADDING_PX}px">${screenMarkup(
        CALENDAR_SETUP_SHELL_CLASSNAME,
      )}</div>`,
      CANDIDATES,
    );
    await page.goto(url);
    await awaitProductFont(page);

    const m = await boxes(page);
    const above = m.card!.top - m.shell!.top;
    const below = m.shell!.bottom - m.card!.bottom;

    // Not pinned to the top: there is real space above the card.
    expect(above).toBeGreaterThan(40);
    // And it is balanced. Generous tolerance -- the header sits above the card
    // inside the same centred stack, so the two gaps are close, not identical.
    expect(Math.abs(above - below)).toBeLessThan(120);
  });

  test("the shell it replaced collapsed the card on a short viewport", async ({
    page,
  }) => {
    // Guards the fix by proving the failure it fixes is real and reproducible.
    // If this ever stops collapsing, the regressed class string has drifted and
    // the tests above are no longer measuring the thing that broke.
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 320 });
    const url = await buildFixture(
      "calendar-shell-regressed",
      `<div style="padding:0 ${PAGE_PADDING_PX}px">${screenMarkup(
        REGRESSED_SHELL_CLASSNAME,
      )}</div>`,
      CANDIDATES,
    );
    await page.goto(url);
    await awaitProductFont(page);

    const m = await boxes(page);

    // The card does not shrink -- it keeps its height and the SHELL cuts it,
    // which is the part the first version of this test measured wrongly. The
    // symptom is unreachable content: the card runs past the shell's clipped
    // box, and because the shell is `fixed` the document does not scroll, so
    // there is no gesture that brings the rest back.
    const clippedByShell = m.card!.bottom > m.shell!.bottom + 1;
    const cannotScrollToIt = m.docScrollHeight <= m.viewportHeight;

    expect(
      clippedByShell,
      "the old fixed/overflow-hidden shell should cut the card off at 320px tall",
    ).toBe(true);
    expect(
      cannotScrollToIt,
      "and being `fixed`, it should leave no scroll to reach the cut-off part",
    ).toBe(true);
  });
});
