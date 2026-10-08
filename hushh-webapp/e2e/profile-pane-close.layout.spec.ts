import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

const WEBAPP_ROOT = path.resolve(__dirname, "..");
const PROFILE_PANE_SOURCE = path.join(
  WEBAPP_ROOT,
  "components/app-ui/profile-pane.tsx",
);
const GLOBAL_CSS_SOURCE = path.join(WEBAPP_ROOT, "app/globals.css");
const CLOSE_RIGHT = "20px";
const CLOSE_POSITION_CLASSNAME =
  "absolute top-5 z-10";
const CLOSE_BUTTON_CLASSNAME =
  "inline-flex h-11 w-11 items-center justify-center rounded-full";
const HEADER_CLASSNAME =
  "shrink-0 border-b pb-4 pl-[max(var(--page-inline-gutter-standard),calc(1rem+env(safe-area-inset-left)))] pr-[max(5rem,calc(var(--page-inline-gutter-standard)+4rem))] pt-[calc(1rem+env(safe-area-inset-top))] text-left";
const SURFACE_CLASSNAME =
  "fixed inset-y-0 right-0 flex w-full max-w-none flex-col sm:w-[min(92vw,430px)] sm:max-w-[430px]";

async function buildFixtureStylesheet(): Promise<string> {
  const { compile } = (await import(
    path.join(WEBAPP_ROOT, "node_modules/tailwindcss/dist/lib.mjs"),
  )) as {
    compile: (
      css: string,
      options: unknown,
    ) => Promise<{ build: (candidates: string[]) => string }>;
  };
  const compiler = await compile('@import "tailwindcss";', {
    base: path.join(WEBAPP_ROOT, "node_modules"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(WEBAPP_ROOT, "node_modules/tailwindcss/index.css")
          : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });

  return compiler.build(
    [
      SURFACE_CLASSNAME,
      HEADER_CLASSNAME,
      CLOSE_POSITION_CLASSNAME,
      CLOSE_BUTTON_CLASSNAME,
      "flex min-w-0 items-center gap-2",
      "-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
      "truncate text-xl font-semibold",
      "mt-1 text-base",
    ]
      .join(" ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

async function writeFixture(nested: boolean): Promise<string> {
  const css = await buildFixtureStylesheet();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-pane-close-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  :root { --page-inline-gutter-standard: 24px; }
  body { margin: 0; background: #f2f2f7; }
  [data-testid="profile-pane"] { background: white; }
</style></head><body>
<section class="${SURFACE_CLASSNAME}" data-testid="profile-pane">
  <header class="${HEADER_CLASSNAME}" data-testid="profile-header">
    <div class="flex min-w-0 items-center gap-2">
      ${
        nested
          ? '<button class="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full" data-testid="profile-back" aria-label="Back in Profile">←</button>'
          : ""
      }
      <h2 class="truncate text-xl font-semibold" data-testid="profile-title">${nested ? "Your account" : "Profile"}</h2>
    </div>
    <p class="mt-1 text-base" data-testid="profile-description">${nested ? "Profile settings" : "Your account, preferences, and privacy controls."}</p>
  </header>
  <button
    aria-label="Close Profile"
    class="${CLOSE_POSITION_CLASSNAME} ${CLOSE_BUTTON_CLASSNAME}"
    data-testid="profile-close"
    style="right: ${CLOSE_RIGHT};"
  >×</button>
</section>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

async function measure(
  page: import("@playwright/test").Page,
): Promise<{
  viewportWidth: number;
  close: DOMRect;
  title: DOMRect;
  description: DOMRect;
  back: DOMRect | null;
  closePosition: string;
  inlineRight: string;
}> {
  return page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().toJSON();
    const close = document.querySelector<HTMLElement>(
      '[data-testid="profile-close"]',
    )!;
    const back = document.querySelector('[data-testid="profile-back"]');
    return {
      viewportWidth: window.innerWidth,
      close: rect('[data-testid="profile-close"]'),
      title: rect('[data-testid="profile-title"]'),
      description: rect('[data-testid="profile-description"]'),
      back: back ? back.getBoundingClientRect().toJSON() : null,
      closePosition: getComputedStyle(close).position,
      inlineRight: close.style.right,
    };
  });
}

test.describe("Profile pane custom close layout", () => {
  test("keeps the liquid-glass card inset and curved across viewport sizes", async ({
    page,
  }) => {
    const css = fs.readFileSync(GLOBAL_CSS_SOURCE, "utf8");
    const start = css.indexOf('/*\n * Profile pane: a bounded liquid-glass card');
    const end = css.indexOf('html:has(.profile-home-screen)', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    await page.setContent(`<!doctype html><html><head><style>
      *, *::before, *::after { box-sizing: border-box; }
      body { margin: 0; }
      .profile-pane-sheet { position: fixed; top: 0; right: 0; bottom: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
      .profile-pane-scroll-root { overflow-y: auto; min-height: 0; flex: 1; }
      ${css.slice(start, end)}
    </style></head><body>
      <section class="profile-pane-sheet" data-slot="sheet-content">
        <header class="profile-pane-header">Profile</header>
        <button class="profile-pane-close" style="position:absolute;right:20px">Close</button>
        <div class="profile-pane-scroll-root"><div style="height: 1200px">Settings</div></div>
      </section>
    </body></html>`);

    for (const size of [
      { width: 390, height: 844, gutter: 12, cardHeight: 820 },
      { width: 1280, height: 900, gutter: 18, cardHeight: 820 },
      { width: 844, height: 390, gutter: 18, cardHeight: 354 },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const geometry = await page.locator(".profile-pane-sheet").evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        const scroll = panel.querySelector<HTMLElement>(".profile-pane-scroll-root")!;
        const close = panel.querySelector<HTMLElement>(".profile-pane-close")!;
        return {
          top: bounds.top,
          right: window.innerWidth - bounds.right,
          bottom: window.innerHeight - bounds.bottom,
          width: bounds.width,
          height: bounds.height,
          radius: getComputedStyle(panel).borderTopRightRadius,
          canScroll: scroll.scrollHeight > scroll.clientHeight,
          closeRightGap: bounds.right - close.getBoundingClientRect().right,
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(size.gutter - 1);
      expect(geometry.right).toBeCloseTo(size.gutter, 0);
      expect(geometry.bottom).toBeGreaterThanOrEqual(size.gutter - 1);
      expect(geometry.width).toBeLessThanOrEqual(430);
      expect(geometry.height).toBeCloseTo(size.cardHeight, 0);
      expect(geometry.radius).toBe("25px");
      expect(geometry.canScroll).toBe(true);
      expect(geometry.closeRightGap).toBeCloseTo(21, 0);
    }
  });

  test("keeps the close button inset inside the card", () => {
    const source = fs.readFileSync(PROFILE_PANE_SOURCE, "utf8");
    const closeMarkup = source.match(/<SheetClose[\s\S]*?<\/SheetClose>/)?.[0];

    expect(closeMarkup).toBeDefined();
    expect(closeMarkup).toContain(
      `style={{ right: "${CLOSE_RIGHT}" }}`,
    );
    expect(closeMarkup).toContain(CLOSE_POSITION_CLASSNAME);
    expect(closeMarkup).not.toContain("right-[max(");
    expect(closeMarkup).not.toMatch(/(?:^|["\s])(?:left|inset)(?:-|["\s])/);
  });

  for (const layout of [
    { name: "phone portrait", width: 390, height: 844, nested: false },
    { name: "phone landscape", width: 844, height: 390, nested: true },
    { name: "desktop", width: 1280, height: 900, nested: true },
  ] as const) {
    test(`keeps ${layout.name} title, description, and controls separate`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.goto(await writeFixture(layout.nested));
      await awaitProductFont(page);

      const result = await measure(page);

      expect(result.closePosition).toBe("absolute");
      expect(result.inlineRight).toBe(CLOSE_RIGHT);
      expect(result.close.width).toBeGreaterThanOrEqual(44);
      expect(result.close.height).toBeGreaterThanOrEqual(44);
      expect(result.close.x + result.close.width).toBeCloseTo(
        result.viewportWidth - 20,
        0,
      );
      expect(result.title.x + result.title.width).toBeLessThanOrEqual(
        result.close.x,
      );
      expect(
        result.description.x + result.description.width,
      ).toBeLessThanOrEqual(result.close.x);

      if (layout.nested) {
        expect(result.back).not.toBeNull();
        expect(result.back!.x + result.back!.width).toBeLessThanOrEqual(
          result.title.x,
        );
      } else {
        expect(result.back).toBeNull();
      }
    });
  }
});
