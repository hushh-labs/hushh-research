import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

const WEBAPP_ROOT = path.resolve(__dirname, "..");
const PROFILE_PANE_SOURCE = path.join(
  WEBAPP_ROOT,
  "components/app-ui/profile-pane.tsx",
);
const CLOSE_RIGHT = "max(1rem, env(safe-area-inset-right, 0px))";
const CLOSE_POSITION_CLASSNAME =
  "absolute top-[calc(1rem+env(safe-area-inset-top))] z-10";
const CLOSE_BUTTON_CLASSNAME =
  "inline-flex h-11 w-11 items-center justify-center rounded-full";
const HEADER_CLASSNAME =
  "shrink-0 border-b pb-4 pl-[max(var(--page-inline-gutter-standard),calc(1rem+env(safe-area-inset-left)))] pr-[max(5rem,calc(var(--page-inline-gutter-standard)+4rem))] pt-[calc(1rem+env(safe-area-inset-top))] text-left";
const SURFACE_CLASSNAME =
  "fixed inset-y-0 right-0 flex w-full max-w-none flex-col sm:w-[min(92vw,560px)] sm:max-w-[560px]";

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
  test("keeps the real feature-page Back inside its reserved band after production CSS optimization", async ({ page }) => {
    const { build } = await import("vite");
    const { Scanner } = await import("@tailwindcss/oxide");
    const { compile } = await import("tailwindcss");
    const { optimize } = await import("@tailwindcss/node");
    const scanner = new Scanner({});
    const candidates = new Set<string>();
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "native-feature-page-"));
    try {
      await build({
        configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
        resolve: { alias: [{ find: "@", replacement: WEBAPP_ROOT }] },
        define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
        plugins: [{
          name: "feature-page-layout-ports",
          transform(source, id) {
            // Only bridge side effects are replaced. The feature page, Radix
            // dialog, class merging and shell button are the product modules.
            if (id.endsWith("/native-chat-chrome.tsx")) return {
              code: 'import { createElement } from "react"; export function NativeChatChrome(p) { return createElement("div", { className:p.className, "data-native-chrome-slot":p.kind }, p.children); }', map: null,
            };
            if (id.endsWith("/lib/capacitor/native-navigation.ts")) return {
              code: 'export function useNativeNavigationOverlayRef(ref) { return ref; }', map: null,
            };
            if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
              for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
            }
          },
        }],
        build: { outDir: output, emptyOutDir: false, lib: {
          entry: path.join(WEBAPP_ROOT, "e2e/fixtures/native-feature-page.tsx"),
          name: "Fixture", formats: ["iife"], fileName: () => "fixture.js",
        } },
      });
      const compiler = await compile(fs.readFileSync(path.join(WEBAPP_ROOT, "app/globals.css"), "utf8")
        .replace(/^@source\s+[^;]+;\s*$/gm, ""), {
        base: path.join(WEBAPP_ROOT, "app"),
        loadStylesheet: async (id, base) => {
          const file = id === "tailwindcss" ? path.join(WEBAPP_ROOT, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css" ? path.join(WEBAPP_ROOT, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
          return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
        },
      });
      const css = stripAppFontFaces(optimize(compiler.build([...candidates]), { minify: true }).code);
      const script = fs.readFileSync(path.join(output, "fixture.js"), "utf8");
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        await page.setContent(`<style>${css}:root { --agent-chat-header-height:116px; --app-bottom-content-clearance:149px; --page-inline-gutter-standard:24px; }</style><div id="root"></div>`);
        await page.addScriptTag({ content: script });
        const back = page.locator('[data-native-chrome-slot="profile-back"]');
        await expect(back).toBeVisible();
        const bounds = await back.evaluate(node => node.getBoundingClientRect().toJSON());
        expect(bounds.x).toBeCloseTo(24, 0);
        expect(bounds.y).toBeCloseTo(124, 0);
        expect(bounds.width).toBe(44);
        expect(bounds.height).toBe(44);
        const title = page.locator('.native-feature-page-header [data-slot="dialog-title"]');
        // Real product header/CSS, synthetic text only. Long sub-route names
        // must wrap without changing the Back track or clipping essential text.
        for (const scale of [1, 2]) {
          await title.evaluate((node, scale) => {
            node.textContent = "Connected accounts and privacy preferences";
            document.documentElement.style.setProperty("--type-navigation-title-size", `${17 * scale}px`);
            document.documentElement.style.setProperty("--type-navigation-title-line", `${22 * scale}px`);
          }, scale);
          const geometry = await title.evaluate(node => {
            const header = node.closest("header")!;
            const back = header.querySelector('[data-native-chrome-slot="profile-back"]')!;
            const title = node.getBoundingClientRect(), control = back.getBoundingClientRect();
            return { width: node.clientWidth, scroll: node.scrollWidth, left: title.left, right: title.right,
              center: title.top + title.height / 2, backRight: control.right, backCenter: control.top + control.height / 2 };
          });
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
          expect(geometry.left - geometry.backRight).toBeCloseTo(8, 0);
          expect(geometry.right).toBeLessThanOrEqual(viewport.width - 24 + 1);
          expect(geometry.center).toBeCloseTo(geometry.backCenter, 0);
        }
        await title.evaluate(node => {
          node.textContent = "Preferences";
          document.documentElement.style.removeProperty("--type-navigation-title-size");
          document.documentElement.style.removeProperty("--type-navigation-title-line");
        });
        // Reproduce the shipped broken centering, not a markup snapshot.
        await page.locator(".native-feature-page").evaluate(node => {
          node.classList.remove("translate-x-0", "translate-y-0");
          node.classList.add("translate-x-[-50%]", "translate-y-[-50%]");
        });
        await expect.poll(() => back.evaluate(node => node.getBoundingClientRect().x)).toBeLessThan(0);
        const broken = await back.evaluate(node => node.getBoundingClientRect().toJSON());
        expect(broken.x).toBeLessThan(0);
        expect(broken.y).toBeLessThan(bounds.y);
      }
    } finally { fs.rmSync(output, { recursive: true, force: true }); }
  });

  test("keeps negotiated full-height drawers edge-to-edge before coverage acknowledgment", async ({ page }) => {
    const globals = fs.readFileSync(path.join(WEBAPP_ROOT, "app/globals.css"), "utf8");
    const start = globals.indexOf("/* Acknowledged native seats bound web overlays; panel motion stays React. */");
    const end = globals.indexOf("/* Opt-in stationary chrome:", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(`<style>
      :root { --native-overlay-top: 116px; --native-overlay-bottom: 149px; }
      section { position: fixed; inset: 0; }
      ${globals.slice(start, end)}
    </style>
    <section id="profile" data-testid="profile-pane" data-slot="sheet-content" data-sheet-side="right"></section>
    <section id="preview" data-profile-preview></section>
    <section id="history" data-agent-history-drawer data-slot="sheet-content" data-sheet-side="left"></section>`);
    for (const mode of [
      { classes: "native-reserved-chrome native-full-window-overlays", top: 0, height: 844 },
      { classes: "native-reserved-chrome", top: 116, height: 579 },
      { classes: "", top: 0, height: 844 },
    ]) {
      await page.evaluate(classes => { document.documentElement.className = classes; }, mode.classes);
      // No coverage attribute: initial sampling must already use authored
      // full-height geometry, while the separate admission gate stays closed.
      for (const family of ["profile", "preview", "history"]) {
        const bounds = await page.locator(`#${family}`).evaluate(node => node.getBoundingClientRect().toJSON());
        expect(bounds.y, `${mode.classes}:${family}`).toBeCloseTo(mode.top, 0);
        expect(bounds.height, `${mode.classes}:${family}`).toBeCloseTo(mode.height, 0);
      }
    }
  });

  test("keeps the right-safe-area declaration on the owning Close slot", () => {
    const source = fs.readFileSync(PROFILE_PANE_SOURCE, "utf8");
    const closeMarkup = source.match(/<NativeChatChrome\s+kind="close"[\s\S]*?<\/NativeChatChrome>/)?.[0];

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
        result.viewportWidth - 16,
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
