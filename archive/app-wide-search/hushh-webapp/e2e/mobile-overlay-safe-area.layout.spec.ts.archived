import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let paletteClass: string;
let resultsClass: string;
let formClass: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const source = fs.readFileSync(path.join(root, "components/kai/kai-command-palette.tsx"), "utf8");
  paletteClass = source.match(/data-search-surface="ios-mobile"\s+className="([^"]+)"/)![1];
  resultsClass = source.match(/className="([^"]+)"\s+data-testid="kai-mobile-search-results"/)![1];
  formClass = source.match(/<form\s+className="([^"]+)"/)![1];
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build(`${paletteClass} ${resultsClass} ${formClass}`.split(/\s+/)));
});

for (const [width, height, keyboard] of [[390, 844, 336], [320, 568, 260], [844, 390, 180]]) {
  test(`search stays between the safe area and keyboard at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const safeTop = width > height ? 0 : 64;
    await page.setContent(`<html class="native-ios kb-open" style="--app-native-safe-area-top:${safeTop}px;--kb-height:${keyboard}px"><head><style>${css}</style></head><body>
      <section data-slot="dialog-content" data-keyboard-anchor="bottom" data-search-surface="ios-mobile" class="${paletteClass}" style="position:fixed;display:flex;flex-direction:column;min-height:0;gap:16px">
        <div id="results" class="${resultsClass}">${"<button style='display:block;height:48px'>Search suggestion</button>".repeat(20)}</div>
        <form class="${formClass}"><input aria-label="Search" style="min-width:0;width:100%"></form>
      </section></body></html>`);
    const bounds = await page.locator("section").boundingBox();
    const input = await page.getByRole("textbox").boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(safeTop + 7);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height - keyboard);
    expect(input!.height).toBeGreaterThan(0);
    expect(await page.locator("#results").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  });
}

test("native rotation overrides a stale portrait safe-area probe", async ({ page }) => {
  await page.setContent(`<html class="native-ios" style="--app-native-safe-area-top:64px;--app-safe-area-top-probe:64px"><head><style>${css}</style></head><body><div id="inset" style="height:var(--app-safe-area-top-effective)"></div></body></html>`);
  await expect(page.locator("#inset")).toHaveCSS("height", "64px");
  await page.evaluate(() => document.documentElement.style.setProperty("--app-native-safe-area-top", "0px"));
  await expect(page.locator("#inset")).toHaveCSS("height", "0px");
});

test("opening Profile preserves the underlying canvas and exits beyond its inset", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<html class="native-ios"><head><style>${css}</style></head><body><div class="foundation-public-ambient"></div><nav class="kai-bottom-nav-pill"></nav></body></html>`);
  const snapshot = () => page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    ambient: getComputedStyle(document.querySelector(".foundation-public-ambient")!).display,
    nav: getComputedStyle(document.querySelector("nav")!).backgroundColor,
  }));
  const before = await snapshot();
  await page.evaluate(() => {
    const pane = document.createElement("section");
    pane.className = "profile-pane-sheet";
    pane.dataset.slot = "sheet-content";
    pane.dataset.state = "open";
    pane.style.position = "fixed";
    pane.innerHTML = '<div class="profile-home-screen profile-account-content" data-profile-stack="true">Profile</div>';
    document.body.append(pane);
  });
  expect(await snapshot()).toEqual(before);
  const pane = page.locator(".profile-pane-sheet");
  expect((await pane.boundingBox())!.y).toBeGreaterThanOrEqual(59);
  await pane.evaluate(node => {
    node.setAttribute("data-state", "closed");
    const animation = node.getAnimations()[0];
    animation.pause();
    animation.currentTime = Number(animation.effect!.getTiming().duration) - 0.01;
  });
  expect((await pane.boundingBox())!.x).toBeGreaterThanOrEqual(389);
  await pane.evaluate(node => node.remove());
  expect(await snapshot()).toEqual(before);
});
