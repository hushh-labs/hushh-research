import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { productFontStyle, stripAppFontFaces, awaitProductFont } from "./fixtures/product-font";

let script: string;
let css: string;
const shortcuts = ["Open To-do List", "Get the app", "Open Connectors"];
test.setTimeout(120_000);
// Reuse the production bundle within each browser project, including in CI.
test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
  // Compiling the production icon registry is setup, separate from UI timing.
  test.setTimeout(120_000);
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const { compile } = await import("tailwindcss");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shortcut-motion-"));
  try {
    await build({
      configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
      plugins: [{ name: "shortcut-candidates", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      } }],
      resolve: { alias: { "@": root } },
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: { outDir, lib: { entry: path.join(root, "e2e/fixtures/shortcut-icon-motion.tsx"), formats: ["iife"], name: "ShortcutFixture", fileName: () => "fixture.js" } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    });
    css = stripAppFontFaces(compiler.build([...candidates])) + fs.readdirSync(outDir).filter(file => file.endsWith(".css")).map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n") + productFontStyle();
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

async function openFixture(page: Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://shortcut-motion.test/**", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shortcut motion</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`,
  }));
  await page.goto(`https://shortcut-motion.test/${query}`);
  await page.locator("#root > *").first().waitFor();
  await awaitProductFont(page);
  expect(errors).toEqual([]);
}

async function running(svg: Locator) {
  return svg.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length);
}

// Freeze one inspection point at animationstart, before slow browser RPCs can
// consume the short cycle. Resuming still exercises production completion.
async function inspectCycle(row: Locator) {
  await row.evaluate(element => {
    const inspected = element as HTMLElement & { cycle?: Animation };
    element.dataset.starts = "0";
    element.dataset.pauseCycle = "true";
    element.addEventListener("animationstart", event => {
      if (!(event.target instanceof Element) || !event.target.hasAttribute("data-shortcut-icon-cycle")) return;
      element.dataset.starts = String(Number(element.dataset.starts) + 1);
      const animations = element.querySelector("svg")!.getAnimations({ subtree: true });
      inspected.cycle = animations.find(animation => (animation.effect as KeyframeEffect).target === event.target);
      if (element.dataset.pauseCycle === "true") {
        animations.forEach(animation => { animation.pause(); animation.currentTime = 150; });
      }
    });
  });
}

async function resumeCycle(row: Locator) {
  expect(await row.evaluate(element => {
    element.dataset.pauseCycle = "false";
    element.querySelector("svg")!.getAnimations({ subtree: true }).forEach(animation => animation.play());
    return element.getAttribute("data-shortcut-icon-playing");
  })).toBe("true");
}

for (const label of shortcuts) {
  test(`${label}: whole row starts one complete cycle without moving its label`, async ({ page }) => {
    await openFixture(page);
    const row = page.getByRole("button", { name: label, exact: true });
    const svg = row.locator("svg");
    const title = row.locator("[data-agent-history-row-title]");
    const initial = { row: await row.boundingBox(), svg: await svg.boundingBox(), title: await title.boundingBox() };
    const restingArtwork = await svg.screenshot();
    await inspectCycle(row);
    // Enter over the label, away from the glyph itself.
    await title.hover();
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    await expect.poll(() => svg.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "paused").length)).toBeGreaterThan(0);
    const timing = await svg.evaluate(element => element.getAnimations({ subtree: true }).map(animation => animation.effect!.getTiming()));
    expect(timing.every(item => item.duration === 850 && item.iterations === 1 && item.delay === 0)).toBe(true);
    expect({ row: await row.boundingBox(), svg: await svg.boundingBox(), title: await title.boundingBox() }).toEqual(initial);
    await page.mouse.move(700, 50);
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    await resumeCycle(row);
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
    expect(await running(svg)).toBe(0);
    expect(await svg.screenshot()).toEqual(restingArtwork);
    await title.hover();
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
    await page.waitForTimeout(250);
    expect(await row.getAttribute("data-starts")).toBe("2");
    expect(await svg.evaluate(element => getComputedStyle(element).transform)).toBe("none");
  });

  test(`${label}: rapid re-entry finishes the current cycle and keyboard focus starts once`, async ({ page }) => {
    await openFixture(page);
    const row = page.getByRole("button", { name: label, exact: true });
    await inspectCycle(row);
    await row.hover();
    await expect.poll(() => row.getAttribute("data-starts")).toBe("1");
    await page.mouse.move(700, 50); await row.hover();
    expect(await row.evaluate(element => {
      const original = (element as HTMLElement & { cycle?: Animation }).cycle;
      return element.querySelector("svg")!.getAnimations({ subtree: true }).includes(original!);
    })).toBe(true);
    expect(await row.getAttribute("data-starts")).toBe("1");
    await resumeCycle(row);
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
    await page.mouse.move(700, 50);
    await page.keyboard.press("Tab");
    await row.focus();
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
    await page.waitForTimeout(200);
    expect(await running(row.locator("svg"))).toBe(0);
  });
}

test("a missing globals duration token still plays the complete hover cycle", async ({ page }) => {
  await openFixture(page);
  await page.addStyleTag({ content: ":root { --motion-shortcut-icon-cycle-duration: initial; }" });
  for (const label of shortcuts) {
    const row = page.getByRole("button", { name: label, exact: true });
    await inspectCycle(row);
    await row.hover();
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    const durations = await row.locator("svg").evaluate(element => element.getAnimations({ subtree: true }).map(animation => animation.effect!.getTiming().duration));
    expect(durations.length).toBeGreaterThan(0);
    expect(durations.every(duration => duration === 850)).toBe(true);
    await resumeCycle(row);
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
  }
});

test("mouse entry works when an embedded browser reports no hover capability", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = original(query);
      if (query.includes("hover:")) Object.defineProperty(media, "matches", { value: false });
      return media;
    };
  });
  await openFixture(page);
  expect(await page.evaluate(() => matchMedia("(any-hover: hover)").matches)).toBe(false);
  const foreground = await page.locator("body").evaluate(element => getComputedStyle(element).color);
  for (const label of shortcuts) {
    const row = page.getByRole("button", { name: label, exact: true });
    await inspectCycle(row);
    await row.hover();
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    expect(await row.locator("svg").evaluate(element => getComputedStyle(element).color)).toBe(foreground);
    await resumeCycle(row);
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
  }
});

test("reduced motion stays static, including preference changes mid-cycle", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page);
  for (const label of shortcuts) {
    const row = page.getByRole("button", { name: label, exact: true });
    await row.hover(); expect(await running(row.locator("svg"))).toBe(0);
    expect(await row.getAttribute("data-shortcut-icon-playing")).toBeNull();
  }
  expect(await page.getByRole("button", { name: "Open To-do List", exact: true }).locator("svg").evaluate(element => getComputedStyle(element.parentElement!, "::before").transitionDuration)).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const row = page.getByRole("button", { name: "Open To-do List", exact: true });
  await row.hover(); await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await running(row.locator("svg"))).toBe(0);
});

test("touch triggers the existing action immediately with static icons", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 844 } });
  const page = await context.newPage();
  await openFixture(page, "?mobile");
  for (const [index, label] of shortcuts.entries()) {
    const row = page.getByRole("button", { name: label, exact: true });
    await row.tap();
    await expect(page.getByTestId("shortcut-result")).toHaveText(["todo", "app", "connectors"][index]);
    expect(await running(row.locator("svg"))).toBe(0);
    expect((await row.locator("svg").boundingBox())!.width).toBe(22);
  }
  await context.close();
});

test("all shortcuts preserve their original artwork at 18, 22 and 24 px", async ({ page }, testInfo) => {
  await openFixture(page, "?geometry");
  // Both versions must be rasterized at the same viewport coordinates. Even
  // integer translations can change diagonal-edge rounding by one colour step.
  await page.locator("main svg").evaluateAll(elements => elements.forEach(element => {
    const svg = element as SVGSVGElement;
    Object.assign(svg.style, { position: "fixed", left: "32px", top: "32px", visibility: "hidden" });
  }));
  const differences: string[] = [];
  for (const size of [18, 22, 24]) {
    for (const name of ["todo", "download", "connectors"]) {
      const actualIcon = page.locator(`[data-${name}="${size}"]`);
      const originalIcon = page.locator(`[data-original-${name}="${size}"]`);
      await originalIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "visible"; });
      const original = await originalIcon.screenshot();
      await originalIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "hidden"; });
      await actualIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "visible"; });
      const actual = await actualIcon.screenshot();
      await actualIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "hidden"; });
      if (!actual.equals(original)) {
        differences.push(`${name} at ${size}px`);
        await testInfo.attach(`${name}-${size}-actual`, { body: actual, contentType: "image/png" });
        await testInfo.attach(`${name}-${size}-original`, { body: original, contentType: "image/png" });
      }
    }
  }
  expect(differences).toEqual([]);
});
