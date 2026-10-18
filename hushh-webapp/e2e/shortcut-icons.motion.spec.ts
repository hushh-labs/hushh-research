import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { productFontStyle, stripAppFontFaces, awaitProductFont } from "./fixtures/product-font";

let script: string;
let css: string;
const shortcuts = ["Get the app"];
const allShortcuts = [...shortcuts, "Open Connectors"];
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
  for (const label of allShortcuts) {
    const row = page.getByRole("button", { name: label, exact: true });
    await row.hover(); expect(await running(row.locator("svg"))).toBe(0);
    expect(await row.getAttribute("data-shortcut-icon-playing")).toBeNull();
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const row = page.getByRole("button", { name: "Get the app", exact: true });
  await row.hover(); await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await running(row.locator("svg"))).toBe(0);
});

test("touch starts playback and triggers the existing action immediately", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 844 } });
  const page = await context.newPage();
  await openFixture(page, "?mobile");
  for (const [index, label] of allShortcuts.entries()) {
    const row = page.getByRole("button", { name: label, exact: true });
    await row.tap();
    await expect(page.getByTestId("shortcut-result")).toHaveText(["app", "connectors"][index]);
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    await expect.poll(() => row.getAttribute("data-shortcut-icon-playing")).toBeNull();
    expect((await row.locator("svg").boundingBox())!.width).toBe(22);
  }
  await context.close();
});

test("To-do and Download preserve their original geometry at 18, 22 and 24 px", async ({ page }, testInfo) => {
  await openFixture(page, "?geometry");
  // Neutralise only colour to compare the preserved artwork geometry.
  await page.addStyleTag({ content: "main svg, main svg * { stroke: currentColor !important; } main svg[viewBox=\"0 0 256 256\"] * { stroke: none !important; fill: currentColor !important; }" });
  // Both versions must be rasterized at the same viewport coordinates. Even
  // integer translations can change diagonal-edge rounding by one colour step.
  await page.locator("main svg").evaluateAll(elements => elements.forEach(element => {
    const svg = element as SVGSVGElement;
    Object.assign(svg.style, { position: "fixed", left: "32px", top: "32px", visibility: "hidden" });
  }));
  const differences: string[] = [];
  for (const size of [18, 22, 24]) {
    for (const name of ["todo", "download"]) {
      const actualIcon = page.locator(`[data-${name}="${size}"]`);
      const originalIcon = page.locator(`[data-original-${name}="${size}"]`);
      await originalIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "visible"; });
      const original = await originalIcon.screenshot();
      await originalIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "hidden"; });
      await actualIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "visible"; });
      const actual = await actualIcon.screenshot();
      await actualIcon.evaluate(element => { (element as SVGSVGElement).style.visibility = "hidden"; });
      // Separate colour regions retain geometry but can change fractional-edge
      // rasterisation by a few channel levels when a compound fill is split.
      const pixelDifference = await page.evaluate(async ({ actual, original }) => {
        const pixels = async (data: string) => {
          const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
          const canvas = document.createElement("canvas");
          canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, image.width, image.height).data;
        };
        const [a, b] = await Promise.all([pixels(actual), pixels(original)]);
        let max = 0, changed = 0;
        for (let index = 0; index < a.length; index += 4) {
          const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(a[index + channel]! - b[index + channel]!)));
          max = Math.max(max, delta);
          if (delta) changed++;
        }
        return { max, changed };
      }, { actual: actual.toString("base64"), original: original.toString("base64") });
      if (pixelDifference.max > 4 || pixelDifference.changed > size * size * .05) {
        differences.push(`${name} at ${size}px`);
        fs.writeFileSync(testInfo.outputPath(`${name}-${size}-actual.png`), actual);
        fs.writeFileSync(testInfo.outputPath(`${name}-${size}-original.png`), original);
        await testInfo.attach(`${name}-${size}-actual`, { body: actual, contentType: "image/png" });
        await testInfo.attach(`${name}-${size}-original`, { body: original, contentType: "image/png" });
      }
    }
  }
  expect(differences).toEqual([]);
});


test("Weave keeps the approved quarter-turn and alternating colours across replay", async ({ page, browserName }, testInfo) => {
  await openFixture(page, "?mobile");
  const frozen = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: frozen });
  await page.clock.pauseAt(new Date(frozen.getTime() + 1000));
  const row = page.getByRole("button", { name: "Open Connectors", exact: true });
  const svg = row.locator("svg");
  const title = row.locator("[data-agent-history-row-title]");
  const bounds = { svg: await svg.boundingBox(), title: await title.boundingBox() };
  const colours = () => svg.evaluate(element => [...element.querySelectorAll("[data-weave-loop]")].sort((a, b) => Number(a.getAttribute("data-weave-loop")) - Number(b.getAttribute("data-weave-loop"))).map(group => getComputedStyle(group.querySelector("path")!).stroke));
  const originalColours = await colours();
  expect(originalColours[0]).toBe(originalColours[2]);
  expect(originalColours[1]).toBe(originalColours[3]);
  expect(originalColours[0]).not.toBe(originalColours[1]);
  for (let cycle = 0; cycle < 3; cycle++) {
    const resting = await svg.innerHTML();
    const before = await colours();
    await title.hover();
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    await page.clock.runFor(300);
    expect(await svg.innerHTML()).not.toBe(resting);
    expect(await colours()).toEqual(before);
    const movingFrame = await svg.innerHTML();
    await row.click(); // The action rerenders its parent while playback is active.
    await expect(page.getByTestId("shortcut-result")).toHaveText("connectors");
    expect(await svg.innerHTML()).toBe(movingFrame);
    await page.mouse.move(700, 50);
    await title.hover(); // Re-entry cannot restart the cycle.
    await page.clock.runFor(700);
    await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
    expect(await colours()).toEqual(before);
    await page.clock.runFor(100);
    await expect(row).not.toHaveAttribute("data-shortcut-icon-playing");
    expect(await colours()).toEqual([before[1], before[0], before[3], before[2]]);
    expect({ svg: await svg.boundingBox(), title: await title.boundingBox() }).toEqual(bounds);
    const settled = await svg.innerHTML();
    await page.clock.runFor(250);
    expect(await svg.innerHTML()).toBe(settled);
    await page.mouse.move(700, 50);
  }
  await page.locator("[data-agent-history-footer]").screenshot({ path: testInfo.outputPath("chat-shortcuts-mobile.png") });
  await page.getByRole("button", { name: "Get the app", exact: true }).focus();
  // Safari uses Option-Tab for full keyboard navigation when its default
  // tab preference skips buttons. Exercise that real browser input path.
  await page.keyboard.press(process.platform === "darwin" && browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("data-shortcut-icon-playing", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(row).not.toHaveAttribute("data-shortcut-icon-playing");
  const reducedFrame = await svg.innerHTML();
  await row.click();
  await page.clock.runFor(1200);
  expect(await svg.innerHTML()).toBe(reducedFrame);
});

test("all shortcut details use the actual Profile accent and ink tokens", async ({ page }) => {
  await openFixture(page);
  for (const dark of [false, true]) {
    await page.locator("html").evaluate((element, enabled) => element.classList.toggle("dark", enabled), dark);
    const tokens = await page.locator("body").evaluate(element => {
      const probe = document.createElement("span");
      element.append(probe);
      probe.style.color = "var(--ios-account-accent)";
      const accent = getComputedStyle(probe).color;
      probe.style.color = "var(--ios-account-label)";
      const ink = getComputedStyle(probe).color;
      probe.remove();
      return { accent, ink };
    });
    const app = page.getByRole("button", { name: "Get the app", exact: true }).locator("svg");
    expect(await app.locator("g").filter({ has: page.locator("path") }).first().locator(":scope > path").nth(1).evaluate(element => getComputedStyle(element).fill)).toBe(tokens.accent);
    const weave = page.getByRole("button", { name: "Open Connectors", exact: true }).locator("svg");
    expect(await weave.locator("[data-weave-loop='0'] path").first().evaluate(element => getComputedStyle(element).stroke)).toBe(tokens.accent);
    expect(await weave.locator("[data-weave-loop='1'] path").first().evaluate(element => getComputedStyle(element).stroke)).toBe(tokens.ink);
  }
});


test("Weave settling and reset render identical pixels at sidebar sizes", async ({ page }, testInfo) => {
  await openFixture(page, "?geometry");
  await page.locator("main svg").evaluateAll(elements => elements.forEach(element => {
    Object.assign((element as SVGSVGElement).style, { position: "fixed", left: "32px", top: "32px", visibility: "hidden" });
  }));
  for (const size of [18, 22, 24]) {
    const end = page.locator(`[data-weave-end="${size}"]`);
    const reset = page.locator(`[data-weave-reset="${size}"]`);
    await end.evaluate(element => { (element as SVGSVGElement).style.visibility = "visible"; });
    const expected = await end.screenshot();
    await end.evaluate(element => { (element as SVGSVGElement).style.visibility = "hidden"; });
    await reset.evaluate(element => { (element as SVGSVGElement).style.visibility = "visible"; });
    expect(await reset.screenshot()).toEqual(expected);
    await reset.evaluate(element => { (element as SVGSVGElement).style.visibility = "hidden"; });
  }
  await openFixture(page, "?frames");
  await page.locator("main").screenshot({ path: testInfo.outputPath("weave-motion-frames.png") });
});
