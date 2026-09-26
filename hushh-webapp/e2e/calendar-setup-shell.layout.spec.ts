import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

/** Layout proof uses the production disconnected component and product CSS.
 * This is a geometry fixture, not authenticated application-flow verification. */
let presentation = "";
test.beforeAll(async () => {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  // Next's image optimizer is irrelevant to layout; preserve the actual img geometry.
  const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-image-"));
  const imageAdapter = path.join(adapterDir, "image.mjs");
  fs.writeFileSync(imageAdapter, `import { createRequire } from "node:module";
const { createElement } = createRequire(${JSON.stringify(path.join(process.cwd(), "package.json"))})("react");
export default function Image({ unoptimized, ...props }) { return createElement("img", props); }`);
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    root: process.cwd(),
    resolve: { alias: { "@": process.cwd(), "next/image": imageAdapter } },
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { CalendarConnectOnboarding } = await server.ssrLoadModule(
      "/components/calendar/calendar-connect-onboarding.tsx",
    );
    presentation = renderToStaticMarkup(createElement(CalendarConnectOnboarding, {
      onboarding: true, busy: false, skipping: false,
      onConnect: () => {}, onSkip: () => {},
    }));
  } finally {
    await server.close();
    fs.rmSync(adapterDir, { recursive: true, force: true });
  }
});

/** The reported break was a short window. 320 is also a landscape phone. */
const VIEWPORT_HEIGHTS = [320, 420, 560, 800] as const;
const VIEWPORT_WIDTH = 960;
const PAGE_PADDING_PX = 16;

/** The shell as it shipped before this fix, kept so the test can show the delta. */
const REGRESSED_SHELL_CLASSNAME =
  "motion-step-enter fixed inset-x-0 top-[64px] bottom-[115px] z-10 m-auto flex w-full max-w-[720px] flex-col items-center justify-center overflow-hidden px-4";

/**
 * The shell between that fix and this one: normal flow and a floor, but the
 * floor was measured against the viewport rather than against the space the
 * scroll root actually leaves. Kept so the test can show that delta too.
 */
const DOUBLE_RESERVED_SHELL_CLASSNAME =
  "motion-step-enter flex min-h-[calc(100dvh-var(--top-shell-reserved-height,4rem)-var(--app-bottom-inset,2rem))] w-full flex-col items-center justify-center gap-4 pb-[calc(var(--app-bottom-inset)+1rem)]";

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

  return stripAppFontFaces(compiler.build([...candidates, "mx-auto", "max-w-[720px]", ...Array.from(presentation.matchAll(/class="([^"]+)"/g)).flatMap((match) => match[1].split(/\s+/))]));
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

  fs.mkdirSync(path.join(dir, "icons/agents"), { recursive: true });
  fs.copyFileSync(path.join(webappRoot, "public/icons/agents/calendar.svg"), path.join(dir, "icons/agents/calendar.svg"));
  body = body.replaceAll('/icons/agents/calendar.svg', './icons/agents/calendar.svg');
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
<main class="app-page-shell mx-auto max-w-[720px] ${shellClassName}" data-app-shell-width="reading" data-testid="shell">
  <div class="app-page-content-region w-full min-w-0" data-testid="card">${presentation}</div>
</main>`;
}

/**
 * The page does not live in a bare document: `app/providers.tsx` puts it in a
 * scroll root that already reserves the chrome above and below it -- a spacer
 * of `--app-top-content-offset` before the page, and the root's own
 * `--app-bottom-content-clearance` of padding after it. This is that root,
 * trimmed to those two reserves, because they are what a viewport-derived
 * floor double-counts.
 */
function scrollRootMarkup(shellClassName: string) {
  return `
<div style="height:100vh;display:flex;flex-direction:column">
  <div class="flex-1 overflow-y-auto min-h-0 pb-[var(--app-bottom-content-clearance)]" data-testid="scroll-root">
    <div data-app-shell-top-spacer="true" aria-hidden></div>
    <div style="padding:0 ${PAGE_PADDING_PX}px">${screenMarkup(shellClassName)}</div>
  </div>
</div>`;
}

const CANDIDATES = [
  ...CALENDAR_SETUP_SHELL_CLASSNAME.split(/\s+/),
  "gap-4",
  ...REGRESSED_SHELL_CLASSNAME.split(/\s+/),
  ...DOUBLE_RESERVED_SHELL_CLASSNAME.split(/\s+/),
  "flex-1",
  "overflow-y-auto",
  "min-h-0",
  "pb-[var(--app-bottom-content-clearance)]",
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
      const el = document.querySelector(id === "connect" ? '[data-voice-control-id="open_calendar_connector"]' : `[data-testid="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
    };
    return {
      shell: read("shell"),
      card: read("card"),
      connect: read("connect"),
      // NOT documentElement alone. globals.css sets `html, body { height:
      // 100%; overflow-x: hidden }`, and CSS computes the unspecified axis of
      // an overflow pair to `auto` -- so body is a scroll container pinned to
      // the viewport, and the page's overflow scrolls INSIDE it.
      // `documentElement.scrollHeight` therefore reports the viewport height
      // forever while the real scroller grows, which read as "the card is
      // unreachable" for a card that scrolls perfectly well. Measured: a 324px
      // child in a 320px viewport gives documentElement 320 and body 324.
      docScrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ),
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

  test("centres the composition when the screen has room for it", async ({ page }) => {
    // What "clean" means on a desktop-height screen, and what the first fix
    // gave away: the card sat at the very top of a tall empty page. `min-h` +
    // justify-center restores the composition without reintroducing the clip,
    // because a floor grows and a fixed height does not.
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 1100 });
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

    const contentWidth = await page.locator("[data-calendar-connect-onboarding]").evaluate((el) => el.getBoundingClientRect().width);
    expect(contentWidth).toBeLessThanOrEqual(448);
    // Not pinned to the top: there is real space above the card.
    expect(above).toBeGreaterThan(40);
    // And it is balanced. Generous tolerance -- the header sits above the card
    // inside the same centred stack, so the two gaps are close, not identical.
    expect(Math.abs(above - below)).toBeLessThan(120);
  });

  test("leaves no dead scroll on a screen with room for the card", async ({
    page,
  }) => {
    // The reported symptom: a screen showing one card still scrolls, into a
    // band with nothing in it. The floor was `100dvh` minus the chrome, but
    // the page never gets `100dvh` -- the scroll root spends
    // `--app-top-content-offset` above it and `--app-bottom-content-clearance`
    // below it first. Subtracting the chrome again made the floor taller than
    // the space by exactly those two reserves.
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 1100 });

    const measure = async (shellClassName: string) => {
      const url = await buildFixture(
        "calendar-shell-scroll-root",
        scrollRootMarkup(shellClassName),
        CANDIDATES,
      );
      await page.goto(url);
      await awaitProductFont(page);
      return page.evaluate(() => {
        const root = document.querySelector(
          '[data-testid="scroll-root"]',
        ) as HTMLElement;
        return { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
      });
    };

    const fixed = await measure(CALENDAR_SETUP_SHELL_CLASSNAME);
    expect(
      fixed.scrollHeight,
      "the page must not be taller than the space it is given",
    ).toBeLessThanOrEqual(fixed.clientHeight + 1);

    // And the shell it replaced did overflow, so this test is measuring the
    // thing that was reported rather than an invariant that always held.
    const before = await measure(DOUBLE_RESERVED_SHELL_CLASSNAME);
    expect(
      before.scrollHeight,
      "the viewport-derived floor should overflow the same root",
    ).toBeGreaterThan(before.clientHeight + 1);
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

for (const theme of ["light", "dark"]) {
  for (const width of [320, 390, 720]) {
    test(`onboarding actions remain reachable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 420 });
      const url = await buildFixture("calendar-responsive", scrollRootMarkup(CALENDAR_SETUP_SHELL_CLASSNAME), CANDIDATES);
      await page.goto(url);
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "24px";
      }, theme);
      await awaitProductFont(page);
      const connect = page.getByRole("button", { name: "Connect" });
      const skip = page.getByRole("button", { name: "Not now" });
      await connect.scrollIntoViewIfNeeded();
      await expect(connect).toBeInViewport();
      expect((await connect.boundingBox())!.height).toBeGreaterThanOrEqual(56);
      await skip.scrollIntoViewIfNeeded();
      await expect(skip).toBeInViewport();
      expect((await skip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="scroll-root"]')!;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(1);
      expect(await page.getByRole("heading", { level: 2 }).count()).toBe(3);
    });
  }
}

test("slider knobs travel in opposite directions and respect reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 1100 });
  const url = await buildFixture("calendar-controls-motion", screenMarkup(CALENDAR_SETUP_SHELL_CLASSNAME), CANDIDATES);
  await page.goto(url);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "You’re in control" }) });
  const first = row.locator('[data-slider-knob="first"]');
  const second = row.locator('[data-slider-knob="second"]');
  const positions = async () => [(await first.boundingBox())!.x, (await second.boundingBox())!.x];
  const initial = await positions();
  await row.hover();
  await expect.poll(async () => (await positions())[0] - initial[0]).toBeGreaterThan(4);
  await expect.poll(async () => (await positions())[1] - initial[1]).toBeLessThan(-4);
  await page.mouse.move(0, 0);
  await expect.poll(async () => Math.abs((await positions())[0] - initial[0])).toBeLessThan(0.1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await row.hover();
  await expect.poll(async () => Math.abs((await positions())[0] - initial[0])).toBeLessThan(0.1);
  expect(Math.abs((await positions())[1] - initial[1])).toBeLessThan(0.1);
});

test("clock and eye keep distinct artwork and animate only their details", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 1100 });
  await page.goto(await buildFixture("calendar-detail-motion", screenMarkup(CALENDAR_SETUP_SHELL_CLASSNAME), CANDIDATES));
  const hands = page.locator('[data-clock-hands]');
  const pupil = page.locator('[data-eye-pupil]');
  const pupilX = (await pupil.boundingBox())!.x;
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "See what’s ahead" }) }).hover();
  await expect.poll(() => hands.evaluate(el => getComputedStyle(el).rotate)).toBe("360deg");
  expect((await pupil.boundingBox())!.x).toBeCloseTo(pupilX, 1);
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Review before confirming" }) }).hover();
  await expect.poll(async () => (await pupil.boundingBox())!.x - pupilX).toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => Math.abs((await pupil.boundingBox())!.x - pupilX)).toBeLessThan(0.1);
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "See what’s ahead" }) }).hover();
  expect(await hands.evaluate(el => getComputedStyle(el).rotate)).toBe("none");
});
