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
const GLOBAL_CSS_SOURCE = path.join(WEBAPP_ROOT, "app/globals.css");
const CLOSE_RIGHT = "max(1rem, env(safe-area-inset-right, 0px))";
const CLOSE_POSITION_CLASSNAME =
  "profile-pane-close absolute top-[calc(1rem+env(safe-area-inset-top))] z-10";
const CLOSE_BUTTON_CLASSNAME =
  "inline-flex h-11 w-11 items-center justify-center rounded-full";
const HEADER_CLASSNAME =
  "shrink-0 border-b pb-4 pl-[max(var(--page-inline-gutter-standard),calc(1rem+env(safe-area-inset-left)))] pr-[max(5rem,calc(var(--page-inline-gutter-standard)+4rem))] pt-[calc(1rem+env(safe-area-inset-top))] text-left";
const SURFACE_CLASSNAME =
  "fixed inset-y-0 right-0 flex w-full max-w-none flex-col sm:w-[min(92vw,430px)] sm:max-w-[430px]";

test.describe("Profile deletion artwork", () => {
  let markup: string;
  let css: string;
  test.beforeAll(async () => {
    const { transform, Features } = await import("lightningcss");
    const account = transform({
      filename: "profile-your-account.module.css",
      code: Buffer.from(fs.readFileSync(path.join(WEBAPP_ROOT, "components/profile/profile-your-account.module.css"), "utf8")),
      cssModules: true,
      // Next lowers nesting into :is selectors. That changes specificity;
      // a minify-only fixture missed the black icon in the real pane.
      include: Features.Nesting,
    });
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: false, root: WEBAPP_ROOT,
      logLevel: "error", appType: "custom", resolve: { alias: { "@": WEBAPP_ROOT } },
      server: { middlewareMode: true, watch: null, hmr: false, ws: false }, oxc: { jsx: { runtime: "automatic" } } });
    try {
      const { createElement } = await import("react");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { SettingsGroup, SettingsRow } = await server.ssrLoadModule("/components/app-ui/settings-ui.tsx");
      const { PROFILE_ICONS } = await server.ssrLoadModule("/components/icons/profile-icons.ts");
      const { Trash2, TrashIcon } = await server.ssrLoadModule("/components/icons/index.ts");
      const { ProfilePaneDeleteIcon } = await server.ssrLoadModule("/components/profile/profile-pane-icons.tsx");
      const rows = renderToStaticMarkup(createElement(SettingsGroup, { title: "Account actions" },
        createElement(SettingsRow, { icon: PROFILE_ICONS.delete, iconTone: "capability", className: "profile-account-delete-row", title: "Delete account", tone: "destructive" }),
        ...[Trash2, TrashIcon, ProfilePaneDeleteIcon].map((icon, index) => createElement(SettingsRow, { key: index, icon, iconTone: "capability", title: `Delete example ${index}` })),
      ));
      markup = `<main class="profile-pane-scroll-root"><div class="app-page-shell"><div data-profile-stack-screen="panel:account"><div data-profile-stack-content="true"><div class="profile-account-content ${account.exports!.paneAccountContent.name}">${rows}</div></div></div></div></main>`;
    } finally { await server.close(); }
    const { compile } = await import("tailwindcss");
    const compiler = await compile(fs.readFileSync(GLOBAL_CSS_SOURCE, "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
      base: path.join(WEBAPP_ROOT, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(WEBAPP_ROOT, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(WEBAPP_ROOT, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    });
    css = stripAppFontFaces(compiler.build([])) + account.code.toString();
  });
  for (const dark of [false, true]) for (const width of [393, 1440]) {
    test(`keeps every trash red after Next nesting lowering at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 852 });
      await page.setContent(`<html class="${dark ? "dark" : ""}"><head><style>${css}</style></head><body>${markup}</body></html>`);
      const expected = dark ? "rgb(255, 69, 58)" : "rgb(255, 59, 48)";
      const glyphs = page.locator("svg[data-trash-icon]");
      await expect(glyphs).toHaveCount(4);
      for (const glyph of await glyphs.all()) await expect(glyph).toHaveCSS("color", expected);
      const row = page.locator(".profile-account-delete-row");
      const icon = row.locator("svg[data-trash-icon]");
      await expect(icon.locator("path").first()).toHaveCSS("stroke", expected);
      await expect(row.locator('[data-slot="settings-row-title"]')).toHaveCSS("color", expected);
      // Reproduce the prior winning neutral token, with the red marker still
      // present: this guard must detect the actual production cascade defect.
      await row.evaluate(node => (node as HTMLElement).style.setProperty("--account-icon", "var(--ios-account-label)"));
      await expect(icon).not.toHaveCSS("color", expected);
      await expect(row.locator('[data-slot="settings-row-title"]')).toHaveCSS("color", expected);
    });
  }
});

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

async function withNativeFeatureFixture(run: (fixture: { css: string; modules: string; script: string }) => Promise<void>) {
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
              code: 'import { createElement, useLayoutEffect } from "react"; export function NativeChatChrome(p) { useLayoutEffect(() => { p.onPresentationReady?.(); }, []); return createElement("div", { className:p.className, "data-native-chrome-slot":p.kind }, p.children); }', map: null,
            };
            if (id.endsWith("/use-native-content-pane.ts")) return {
              code: 'export function useNativeContentPane(node, owner, enabled) { return enabled ? { phase:"native", identity:{ documentId:"synthetic", ownerEpoch:"synthetic", generation:1, privacyGeneration:0 } } : { phase:"web" }; }', map: null,
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
      const modules = fs.existsSync(path.join(output, "fixture.css")) ? fs.readFileSync(path.join(output, "fixture.css"), "utf8") : "";
      await run({ css, modules, script });
    } finally { fs.rmSync(output, { recursive: true, force: true }); }
}

test.describe("Profile pane custom close layout", () => {
  test("keeps nested sheets above the real feature page with optimized product CSS", async ({ page }) => {
    await withNativeFeatureFixture(async ({ css, modules, script }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setContent(`<style>${modules}${css}</style><div id="root" data-pane="true" data-overlays="true"></div>`);
      await page.addScriptTag({ content: script });
      const options = page.getByRole("button", { name: "Photo options", exact: true });
      await options.click();
      const preview = page.getByRole("button", { name: "View photo", exact: true });
      const receivesTouch = () => preview.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return hit === node || !!hit && node.contains(hit);
      });
      await expect.poll(receivesTouch).toBe(true);
      // Actual shipped layering: the borrowed Dialog tier covers the nested
      // sheet, even though its button exists and is otherwise visible.
      const broken = await page.addStyleTag({ content: '.native-feature-page[data-slot="dialog-content"] { z-index:var(--z-dialog); }' });
      await expect.poll(receivesTouch).toBe(false);
      await broken.evaluate(node => node.remove());
      await preview.click();
      await expect(page.getByRole("dialog", { name: "Photo preview" })).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(options).toBeVisible();
      await options.click();
      await expect.poll(receivesTouch).toBe(true);
    });
  });

  test("keeps the real feature-page Back inside its reserved band after production CSS optimization", async ({ page }) => {
    await withNativeFeatureFixture(async ({ css, modules, script }) => {
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
            const page = header.closest(".native-feature-page")!.getBoundingClientRect();
            const body = header.parentElement!.querySelector(".native-feature-page-body")!.getBoundingClientRect();
            return { width: node.clientWidth, scroll: node.scrollWidth, left: title.left, right: title.right,
              center: title.top + title.height / 2, backRight: control.right, backCenter: control.top + control.height / 2,
              top: title.top, bottom: title.bottom, pageTop: page.top, pageBottom: page.bottom,
              bodyTop: body.top, bodyBottom: body.bottom, bodyHeight: body.height };
          });
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
          expect(geometry.left - geometry.backRight).toBeCloseTo(8, 0);
          expect(geometry.right).toBeLessThanOrEqual(viewport.width - 24 + 1);
          expect(geometry.center).toBeCloseTo(geometry.backCenter, 0);
          expect(geometry.top).toBeGreaterThanOrEqual(geometry.pageTop);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.pageBottom + 1);
          expect(geometry.bodyTop).toBeGreaterThanOrEqual(geometry.bottom);
          expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.pageBottom + 1);
          expect(geometry.bodyHeight).toBeGreaterThan(0);
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
      // The same product component/CSS must keep nested details in the full
      // pane, not return to the shorter reserved-band layout. Bridge acceptance
      // is covered by the focused lifecycle tests, not this geometry fixture.
      for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 1366 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(viewport);
        await page.setContent(`<style>${modules}${css}:root { --app-safe-area-top-effective:0px; }</style><div id="root" data-pane="true"></div>`);
        await page.addScriptTag({ content: script });
        const pane = page.locator('[data-native-feature-pane="profile"]');
        await expect(pane).toBeVisible();
        const bounds = await pane.boundingBox();
        expect(bounds!.y).toBe(0);
        expect(bounds!.height).toBeCloseTo(viewport.height, 0);
        expect(bounds!.width).toBeCloseTo(viewport.width < 640 ? viewport.width : 430, 0);
        const close = page.locator('[data-native-chrome-slot="close"]');
        await expect(close).toBeVisible();
        const back = page.locator('[data-native-chrome-slot="profile-back"]');
        const control = await close.boundingBox(), leading = await back.boundingBox();
        expect(control!.width).toBe(44);
        expect(control!.height).toBe(44);
        expect(control!.y).toBeCloseTo(leading!.y, 0);
        const content = await page.locator('[data-content-start]').boundingBox();
        expect(Math.abs(leading!.x - content!.x)).toBeLessThanOrEqual(0.5);
        const formerHeaderInset = await page.addStyleTag({ content:
          '.native-feature-page[data-content-inset="profile"] .native-feature-page-header { padding-inline:16px; }',
        });
        const brokenLeading = await back.boundingBox();
        expect(Math.abs(brokenLeading!.x - content!.x)).toBeGreaterThan(1);
        await formerHeaderInset.evaluate(node => node.remove());
        const glyphs = page.locator('[data-icon-tone="capability"] svg');
        expect(await glyphs.count()).toBe(2);
        for (const glyph of await glyphs.all()) {
          expect(await glyph.getAttribute("viewBox")).toBe("0 0 256 256");
          const glyphBounds = await glyph.boundingBox();
          expect(glyphBounds!.width).toBe(28);
          expect(glyphBounds!.height).toBe(28);
        }
        // The former pane/account rules shrank only nested glyphs, despite
        // their shared registry source. Exercise the real optimized cascade.
        const smallGlyphRule = await page.addStyleTag({ content:
          '.profile-pane-scroll-root [data-profile-stack-content="true"] [data-icon-tone="capability"] svg { width:24px !important; height:24px !important; }',
        });
        expect((await glyphs.first().boundingBox())!.width).toBe(24);
        await smallGlyphRule.evaluate(node => node.remove());
        expect((await glyphs.first().boundingBox())!.width).toBe(28);
        // A nested Profile pane inherits the shared modal backdrop. Only
        // bounded feature pages may suppress it; transparent details caused
        // the reported disappearance during the menu/content handoff.
        const scrim = page.locator('.native-feature-pane-overlay[data-slot="dialog-overlay"]');
        const material = () => scrim.evaluate(node => {
          const style = getComputedStyle(node);
          return { color: style.backgroundColor, filter: style.backdropFilter };
        });
        await expect(scrim).toBeVisible();
        const settled = await material();
        expect(settled.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(settled.filter).not.toBe("none");
        // Negative control: reinstate the former overbroad selector without
        // changing the component, geometry or native admission fixture.
        const brokenRule = await page.addStyleTag({ content:
          '.native-feature-page-overlay[data-slot="dialog-overlay"] { background:transparent; backdrop-filter:none; -webkit-backdrop-filter:none; animation:none; }',
        });
        expect(await scrim.evaluate(node => node.matches('.native-feature-page-overlay[data-slot="dialog-overlay"]'))).toBe(true);
        await expect.poll(async () => (await material()).color).toBe("rgba(0, 0, 0, 0)");
        await expect.poll(async () => (await material()).filter).toBe("none");
        await brokenRule.evaluate(node => node.remove());
        await expect.poll(material).toEqual(settled);
      }
    });
  });

  test("keeps the native Profile heading coherent with its active nested body", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await withNativeFeatureFixture(async ({ css, modules, script }) => {
      // Real navigator, normal clicks and optimized product CSS. Contrast the
      // screen heights and retain nonzero return scroll; do not delay effects
      // or fake animation frames to manufacture the original hard cut.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setContent(`<style>${modules}${css}</style><div id="root" data-pane="true" data-stack="true"></div>`);
      await page.addScriptTag({ content: script });
      const stack = page.locator('[data-profile-stack="true"]');
      const scroll = page.locator('[data-native-feature-scroll-root="true"]');
      await expect(stack).toBeVisible();
      await scroll.evaluate(node => { node.scrollTop = 180; });
      expect(await scroll.evaluate(node => node.scrollTop)).toBe(180);
      await page.evaluate(() => {
        const samples: { body: string; title: string }[] = [];
        (window as unknown as { profileSamples: typeof samples }).profileSamples = samples;
        const pane = document.querySelector('.native-feature-page')!;
        function record() {
          const active = pane.querySelector<HTMLElement>('[data-profile-stack-active="true"]');
          if (active) samples.push({ body: active.dataset.profileStackScreen!,
            title: pane.querySelector('[data-slot="dialog-title"]')?.textContent ?? "" });
        }
        // This observes committed public DOM metadata only. No geometry read
        // may manufacture a transition or infer a product action.
        new MutationObserver(record).observe(pane, { childList: true, characterData: true,
          subtree: true, attributes: true, attributeFilter: ["data-profile-stack-active"] });
        record();
      });
      await page.getByRole("button", { name: "Open Voice", exact: true }).click();
      await expect(page.locator('[data-profile-stack-screen="voice"][data-profile-stack-active="true"]')).toBeVisible();
      await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
      await expect(page.locator('.native-feature-page-header [data-slot="dialog-title"]')).toHaveText("Voice");
      await page.getByRole("button", { name: "Back in Profile", exact: true }).click();
      await expect(page.locator('[data-profile-stack-screen="preferences"][data-profile-stack-active="true"]')).toBeVisible();
      await expect.poll(() => scroll.evaluate(node => node.scrollTop),
        { message: "Nested Back must preserve the pre-layout outgoing scroll position" }).toBe(180);
      await expect(page.locator('.native-feature-page-header [data-slot="dialog-title"]')).toHaveText("Preferences");
      const samples = await page.evaluate(() => (window as unknown as {
        profileSamples: { body: string; title: string }[];
      }).profileSamples);
      expect(samples.some(sample => sample.body === "voice")).toBe(true);
      expect(samples.some(sample => sample.body === "preferences")).toBe(true);
      expect(samples.filter(sample => sample.title !== (sample.body === "voice" ? "Voice" : "Preferences")),
        "A nested request cannot reveal its new heading over the previous active body").toEqual([]);
    });
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
      ${globals.slice(start, end).replace(/env\(safe-area-inset-(top|bottom|left|right), 0px\)/g, (_, edge: string) => `${edge === "top" ? 20 : edge === "bottom" ? 28 : 12}px`)}
    </style>
    <section id="profile" class="profile-pane-sheet" data-testid="profile-pane" data-slot="sheet-content" data-sheet-side="right">
      <header class="profile-pane-header" data-slot="sheet-header"></header>
      <button class="profile-pane-close" data-native-chrome-slot="profile-close" style="position:absolute"></button>
    </section>
    <section id="preview" data-profile-preview></section>
    <section id="history" data-agent-history-drawer data-slot="sheet-content" data-sheet-side="left">
      <aside data-agent-history-sidebar="drawer" style="box-sizing:border-box;height:100%"><header data-agent-history-header></header></aside>
    </section>`);
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
      // Simulate nonzero material-safe insets in the owning CSS. Legacy native
      // reservations already include them; only full-window content adds them.
      const content = await page.evaluate(() => ({
        profileTop: parseFloat(getComputedStyle(document.querySelector(".profile-pane-header")!).paddingTop),
        closeTop: parseFloat(getComputedStyle(document.querySelector(".profile-pane-close")!).top),
        historyTop: parseFloat(getComputedStyle(document.querySelector("aside")!).paddingTop),
        historyBottom: parseFloat(getComputedStyle(document.querySelector("aside")!).paddingBottom),
      }));
      const legacy = mode.classes === "native-reserved-chrome";
      expect(content.profileTop).toBe(legacy ? 16 : 36);
      expect(content.closeTop).toBe(legacy ? 16 : 37);
      expect(content.historyTop).toBe(legacy ? 0 : 20);
      expect(content.historyBottom).toBe(legacy ? 0 : 28);
    }
  });

  test("keeps touch Profile full-height and the desktop card inset", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
    const css = fs.readFileSync(GLOBAL_CSS_SOURCE, "utf8");
    const start = css.indexOf('/*\n * Profile pane: a bounded liquid-glass card');
    const end = css.indexOf('html:has(.profile-home-screen', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mobileStart = css.indexOf("/* Profile is a full mobile surface");
    const mobileEnd = css.indexOf("/* Opt-in stationary chrome:", mobileStart);
    expect(mobileStart).toBeGreaterThan(end);
    const mobileRules = css.slice(mobileStart, mobileEnd);

    await page.setContent(`<!doctype html><html><head><style>
      *, *::before, *::after { box-sizing: border-box; }
      body { margin: 0; }
      .profile-pane-sheet { position: fixed; top: 0; right: 0; bottom: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
      .profile-pane-scroll-root { overflow-y: auto; min-height: 0; flex: 1; }
      ${css.slice(start, end)}
    </style><style id="mobile-profile-geometry">${mobileRules}</style></head><body>
      <section class="profile-pane-sheet" data-slot="sheet-content">
        <header class="profile-pane-header">Profile</header>
        <button class="profile-pane-close" style="position:absolute;right:20px">Close</button>
        <div class="profile-pane-scroll-root"><div style="height: 1200px">Settings</div></div>
      </section>
    </body></html>`);

    for (const size of [
      { width: 390, height: 844, gutter: 0, cardHeight: 844 },
      { width: 1280, height: 900, gutter: 18, cardHeight: 820 },
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
      expect(geometry.width).toBeCloseTo(size.gutter === 0 ? size.width : 430, 0);
      expect(geometry.height).toBeCloseTo(size.cardHeight, 0);
      expect(geometry.radius).toBe(size.gutter === 0 ? "0px" : "25px");
      expect(geometry.canScroll).toBe(true);
      expect(geometry.closeRightGap).toBeCloseTo(size.gutter === 0 ? 16 : 21, 0);
    }
    // Negative control: removing the mobile policy reproduces the actual
    // shortened, inset phone pane; the old recipe must not pass this contract.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#mobile-profile-geometry").evaluate(node => node.remove());
    const broken = await page.locator(".profile-pane-sheet").boundingBox();
    expect(broken?.height).toBeLessThan(844);
    expect(broken?.width).toBeLessThan(390);
    const touchContext = await browser.newContext({ hasTouch: true });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.setContent(await page.content());
      await touchPage.addStyleTag({ content: mobileRules });
      for (const size of [
        { width: 844, height: 390, gutter: 0 },
        { width: 1194, height: 834, gutter: 18 },
      ]) {
        await touchPage.setViewportSize(size);
        const bounds = await touchPage.locator(".profile-pane-sheet").boundingBox();
        expect(bounds?.y).toBeCloseTo(0, 0);
        expect(bounds?.height).toBeCloseTo(size.height, 0);
        expect(bounds?.width).toBeCloseTo(size.gutter === 0 ? size.width : 430, 0);
        expect(size.width - (bounds!.x + bounds!.width)).toBeCloseTo(size.gutter, 0);
      }
    } finally { await touchContext.close(); }
    } finally { await context.close(); }
  });

  test("keeps inner tabs centered and readable in the inset card", async ({ page }) => {
    const css = fs.readFileSync(GLOBAL_CSS_SOURCE, "utf8");
    const paneStart = css.indexOf('/*\n * Profile pane: a bounded liquid-glass card');
    const paneEnd = css.indexOf('html:has(.profile-home-screen', paneStart);
    const typeStart = css.indexOf('/* Base-layer important type rules');
    expect(paneStart).toBeGreaterThan(-1);
    expect(paneEnd).toBeGreaterThan(paneStart);
    expect(typeStart).toBeGreaterThan(paneEnd);

    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      *, *::before, *::after { box-sizing: border-box; }
      :root { --font-app-body: system-ui; --font-app-display: system-ui; --ios-account-label: #171a1f; --ios-account-secondary-label: #707780; --ios-account-accent: #007aff; }
      body { margin: 0; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
      .profile-pane-sheet { position: fixed; display: flex; flex-direction: column; }
      .profile-pane-scroll-root { min-height: 0; flex: 1; overflow-y: auto; }
      .app-page-shell { width: 100%; }
      ${css.slice(paneStart, paneEnd)}
      ${css.slice(typeStart)}
    </style></head><body>
      <section class="profile-pane-sheet" data-slot="sheet-content">
        <header class="profile-pane-header profile-pane-header--inner">
          <div><button type="button" aria-label="Back in Profile">←</button><h2 data-slot="sheet-title">Appearance &amp; preferences</h2></div>
          <p class="sr-only" data-slot="sheet-description">Profile settings</p>
        </header>
        <button class="profile-pane-close" style="position:absolute;right:20px" aria-label="Close Profile">×</button>
        <div class="profile-pane-scroll-root">
          <div class="app-page-shell profile-pane-page--inner">
            <div data-profile-stack-content="true">
              <section data-testid="settings-group"><div><span data-slot="settings-group-heading">Preferences</span></div>
                <div data-slot="settings-group-shell"><div data-row-layout="settings"><button type="button"><span data-slot="settings-row-title">Appearance</span><span data-slot="settings-row-description">Light, dark, or system.</span></button></div></div>
              </section>
            </div>
          </div>
        </div>
      </section>
    </body></html>`);

    for (const [width, inset] of [[320, 12], [1280, 28]] as const) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const pane = rect(".profile-pane-sheet");
        const title = rect('[data-slot="sheet-title"]');
        const back = rect('[aria-label="Back in Profile"]');
        const close = rect('[aria-label="Close Profile"]');
        const card = rect('[data-slot="settings-group-shell"]');
        const shell = getComputedStyle(document.querySelector('[data-slot="settings-group-shell"]')!);
        return {
          titleOffset: Math.abs((title.left + title.right) / 2 - (pane.left + pane.right) / 2),
          controlsSeparated: back.right <= title.left && title.right <= close.left,
          inset: card.left - pane.left - parseFloat(getComputedStyle(document.querySelector('.profile-pane-sheet')!).borderLeftWidth),
          radius: shell.borderTopLeftRadius,
          headingSize: getComputedStyle(document.querySelector('[data-slot="settings-group-heading"]')!).fontSize,
          titleSize: getComputedStyle(document.querySelector('[data-slot="settings-row-title"]')!).fontSize,
          descriptionSize: getComputedStyle(document.querySelector('[data-slot="settings-row-description"]')!).fontSize,
          overflows: document.querySelector('.profile-pane-scroll-root')!.scrollWidth > document.querySelector('.profile-pane-scroll-root')!.clientWidth,
        };
      });
      expect(geometry.titleOffset).toBeLessThanOrEqual(1);
      expect(geometry.controlsSeparated).toBe(true);
      expect(geometry.inset).toBeCloseTo(inset, 0);
      expect(geometry.radius).toBe("17px");
      expect(geometry.headingSize).toBe("10px");
      expect(geometry.titleSize).toBe("13px");
      expect(geometry.descriptionSize).toBe("12px");
      expect(geometry.overflows).toBe(false);
    }
  });

  test("keeps the close button inset inside the card", () => {
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
