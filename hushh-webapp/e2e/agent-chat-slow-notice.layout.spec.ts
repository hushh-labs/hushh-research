import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The slow-reply notice, measured in a real browser: one toast, top-anchored
 * under the status bar's safe area, never over the composer (a phone with the
 * keyboard up included), equal side insets, a 16 pt glyph that sits in the
 * same inset as the close control, and the complete message in two lines at
 * most. At phone and desktop widths, light and dark, then
 * again with the text widened (CI's Linux fonts set about 1.5px wider).
 * Set SLOW_NOTICE_SHOT_DIR to also capture one screenshot per state at 393.
 */
let script: string;
let css: string;

const STATES = ["slow", "waking", "connecting", "busy", "unavailable"] as const;
const HALF_PX = 0.5;
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-slow-notice-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      },
    }],
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/agent-chat-slow-notice.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function open(page: Page, width: number, height: number, dark: boolean) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: dark ? "dark" : "light" });
  await page.route("http://localhost/agent-chat-slow-notice", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${dark ? "dark" : ""}" style="--app-safe-area-top:${SAFE_TOP}px;--app-safe-area-bottom:${SAFE_BOTTOM}px"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/agent-chat-slow-notice");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await page.getByTestId("fixture-composer").waitFor();
}

async function showState(page: Page, state: (typeof STATES)[number]) {
  await page.evaluate((next) => window.slowNotice.show(next), state);
  const toast = page.getByTestId("agent-chat-slow-notice");
  await expect(toast).toHaveCount(1);
  await expect(toast.locator("[data-slow-notice-glyph]")).toHaveAttribute("data-slow-notice-glyph", state);
  // Settled: sonner measures, then places; wait for a stable box.
  await expect(async () => {
    const a = await toast.boundingBox();
    await page.waitForTimeout(50);
    const b = await toast.boundingBox();
    expect(a).toEqual(b);
  }).toPass();
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Geometry = {
  viewport: { width: number; height: number };
  scrollWidth: number;
  toastCount: number;
  toast: Box;
  composer: Box;
  icon: Box;
  close: Box;
  closeGlyph: Box;
  title: Box & { lines: number; clipped: boolean };
  liveRegion: string | null;
  topInset: number;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const box = (node: Element): { left: number; right: number; top: number; bottom: number; width: number; height: number } => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const text = (node: HTMLElement) => {
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
      return {
        ...box(node),
        lines: Math.round(node.scrollHeight / lineHeight),
        clipped: node.scrollHeight > node.clientHeight + 1,
      };
    };
    const toast = document.querySelector("[data-testid='agent-chat-slow-notice']")!;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:var(--top-inset,0px);height:0";
    document.body.appendChild(probe);
    const topInset = probe.getBoundingClientRect().top;
    probe.remove();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      toastCount: document.querySelectorAll("[data-sonner-toast]").length,
      toast: box(toast),
      composer: box(document.querySelector("[data-testid='fixture-composer']")!),
      icon: box(toast.querySelector("[data-icon] svg")!),
      close: box(toast.querySelector("[data-close-button]")!),
      closeGlyph: box(toast.querySelector("[data-close-button] svg")!),
      title: text(toast.querySelector("[data-title]") as HTMLElement),
      liveRegion: document.querySelector("section[aria-live]")?.getAttribute("aria-live") ?? null,
      topInset,
    };
  });
}

const centre = (b: Box) => b.top + b.height / 2;
const middle = (b: Box) => b.left + b.width / 2;

function assertGrid(g: Geometry, label: string) {
  expect.soft(g.toastCount, `${label}: one toast`).toBe(1);
  expect.soft(g.liveRegion, `${label}: announced politely`).toBe("polite");
  expect.soft(g.scrollWidth, `${label}: horizontal scroll`).toBeLessThanOrEqual(g.viewport.width + 1);

  // Placement: under the status bar's safe area, equal side insets, and well
  // clear of the composer (the keyboard-up viewport included).
  expect.soft(g.toast.top - g.topInset, `${label}: safe-area gap`).toBeCloseTo(12, 0);
  expect.soft(Math.abs(g.toast.left - (g.viewport.width - g.toast.right)), `${label}: side insets`).toBeLessThanOrEqual(HALF_PX);
  if (g.viewport.width < 600) expect.soft(g.toast.left, `${label}: 16 pt gutter`).toBeCloseTo(16, 0);
  expect.soft(g.composer.top - g.toast.bottom, `${label}: clear of the composer`).toBeGreaterThanOrEqual(8);

  // Mirror symmetry on the 8 pt grid: glyph and close control centred 24 pt
  // in from their edges, a 40 pt text column reserve on both sides.
  expect.soft(middle(g.icon) - g.toast.left, `${label}: glyph centre inset`).toBeCloseTo(24, 0);
  expect.soft(g.toast.right - middle(g.closeGlyph), `${label}: close centre inset`).toBeCloseTo(24, 0);
  expect.soft([g.icon.width, g.icon.height], `${label}: 16 pt glyph`).toEqual([16, 16]);
  expect.soft([g.close.width, g.close.height], `${label}: 32 pt close target`).toEqual([32, 32]);
  expect.soft(g.title.left - g.toast.left, `${label}: title left reserve`).toBeCloseTo(40, 0);
  expect.soft(g.toast.right - g.title.right, `${label}: title right reserve`).toBeCloseTo(40, 0);

  // Vertical rhythm: 16 pt above and below the text, glyph and close control
  // centred on it, and a height on the 4 pt grid.
  expect.soft(g.title.top - g.toast.top, `${label}: top padding`).toBeCloseTo(16, 0);
  expect.soft(g.toast.bottom - g.title.bottom, `${label}: bottom padding`).toBeCloseTo(16, 0);
  const textCentre = centre(g.title);
  for (const [name, part] of [["glyph", g.icon], ["close", g.close]] as const) {
    expect.soft(Math.abs(centre(part) - textCentre), `${label}: ${name} centred`).toBeLessThanOrEqual(HALF_PX);
  }
  expect.soft(Math.round(g.toast.height) % 4, `${label}: 4 pt height`).toBe(0);

  // The complete message fits in at most two lines.
  expect.soft(g.title.lines, `${label}: title lines`).toBeLessThanOrEqual(2);
  expect.soft(g.title.clipped, `${label}: title clipped`).toBe(false);
}

const VIEWPORTS = [
  { width: 393, height: 852 },
  // An iPhone with the keyboard up: the composer rises, the notice stays top.
  { width: 393, height: 480 },
  { width: 1440, height: 900 },
] as const;

for (const dark of [false, true])
  for (const viewport of VIEWPORTS)
    test(`slow notice sits on the grid at ${viewport.width}x${viewport.height} ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, viewport.width, viewport.height, dark);
      for (const state of STATES) {
        await showState(page, state);
        const label = `${viewport.width}x${viewport.height} ${dark ? "dark" : "light"} ${state}`;
        assertGrid(await measure(page), label);

        const shotDir = process.env.SLOW_NOTICE_SHOT_DIR;
        if (shotDir && viewport.width === 393 && viewport.height === 852) {
          fs.mkdirSync(shotDir, { recursive: true });
          await page.screenshot({
            path: path.join(shotDir, `slow-notice-${state}-393-${dark ? "dark" : "light"}.png`),
            animations: "disabled",
          });
        }
      }
      // Widened text (CI's Linux faces set wider): every state still fits whole.
      await page.addStyleTag({
        content: "[data-testid='agent-chat-slow-notice'] [data-title]{letter-spacing:0.3px}",
      });
      for (const state of STATES) {
        await showState(page, state);
        assertGrid(await measure(page), `${viewport.width}x${viewport.height} ${dark ? "dark" : "light"} ${state} widened`);
      }
      expect(errors).toEqual([]);
    });

test("one notice updates in place, closes by hand, and a dismissal holds for the turn", async ({ page }) => {
  await open(page, 393, 852, false);
  const toast = page.getByTestId("agent-chat-slow-notice");
  const turn = (script: string) => page.evaluate(script);

  await turn("window.slowNotice.controller.begin(); window.slowNotice.controller.signal({ kind: 'backend_strain', strain: 'unavailable' })");
  await expect(toast).toContainText("One is briefly unavailable");
  await turn("window.slowNotice.controller.signal({ kind: 'backend_strain', strain: 'busy' })");
  await expect(toast).toContainText("One is very busy right now");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);

  // Reduced motion: no transition, so nothing slides or bounces.
  const transition = await toast.evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(transition.split(",").every((value) => parseFloat(value) === 0)).toBe(true);

  await toast.getByRole("button", { name: "Close toast" }).click();
  await expect(toast).toHaveCount(0);
  expect(await turn("window.slowNotice.dismissals")).toBe(1);
  expect(await turn("window.slowNotice.controller.visibleState")).toBeNull();

  // The same news again in this turn stays dismissed.
  await turn("window.slowNotice.controller.signal({ kind: 'backend_strain', strain: 'busy' })");
  await page.waitForTimeout(300);
  await expect(toast).toHaveCount(0);

  // A new turn's first reply leaves nothing behind; a quiet clear, no second toast.
  await turn("window.slowNotice.controller.finish('failed'); window.slowNotice.controller.begin(); window.slowNotice.controller.signal({ kind: 'activity' }); window.slowNotice.controller.finish('answered')");
  await page.waitForTimeout(300);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});
