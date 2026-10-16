import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";
import { mountAppChrome, awaitClosedHistoryGeometry } from "./fixtures/app-chrome-layer";

let script: string;
let css: string;
let fixtureDirectory: string | undefined;

test.afterAll(() => {
  if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-motion-"));
  fixtureDirectory = outDir;
  await build({
    configFile: false, logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "history-motion-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }]))
            candidates.add(candidate);
      },
    }],
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir, emptyOutDir: false, copyPublicDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/agent-history-motion.tsx"),
        name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
        : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle()
    + fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
      .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});

test.beforeEach(async ({ page }) => {
  await page.route("http://localhost/history-motion", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
      + css + '</style></head><body><div id="root"></div></body></html>',
  }));
  await page.goto("http://localhost/history-motion");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
});


test("History tap motion and interrupted pulls move the entire panel without shifting Chat", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mountAppChrome(page, 74);
  await page.locator("[data-agent-history-drawer]").waitFor({ state: "attached" });
  // Changing this retained fixture's viewport can itself animate its closed
  // percentage translate. Measure the tap from the authored closed position,
  // not from a desktop-to-phone resize that is still settling.
  await awaitClosedHistoryGeometry(page);
  const motion = await page.evaluate(async () => {
    const panel = document.querySelector<HTMLElement>("[data-agent-history-drawer]")!;
    const main = document.querySelector("main")!;
    const nav = document.querySelector("[data-fixture-bottom-bar]")!;
    const before = [main.getBoundingClientRect().x, nav.getBoundingClientRect().y];
    const width = panel.offsetWidth;
    const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent === "Open drawer")!;
    trigger.click();
    const frames: { elapsed: number; x: number }[] = [];
    const start = performance.now();
    await new Promise<void>(resolve => {
      const sample = () => {
        const elapsed = performance.now() - start;
        frames.push({ elapsed, x: panel.getBoundingClientRect().x });
        if (elapsed < 360) requestAnimationFrame(sample); else resolve();
      };
      requestAnimationFrame(sample);
    });
    const style = getComputedStyle(panel);
    return { frames, width, before, after: [main.getBoundingClientRect().x, nav.getBoundingClientRect().y],
      presentation: { translate: style.translate, transform: style.transform, visibility: style.visibility,
        coarse: matchMedia("(pointer: coarse)").matches,
        scrimFilter: getComputedStyle(document.querySelector("[data-agent-history-scrim]")!).backdropFilter,
        documentAnimations: document.getAnimations().filter(animation => animation.playState === "running").map(animation => ({
          target: (animation.effect as KeyframeEffect | null)?.target instanceof Element
            ? ((animation.effect as KeyframeEffect).target as Element).className : null,
          timing: animation.effect?.getComputedTiming(),
        })),
        transition: style.transition, animations: panel.getAnimations().map(animation => ({
          state: animation.playState, timing: animation.effect?.getComputedTiming(),
        })) } };
  });
  // An instantaneous endpoint jump passes a settled screenshot but fails here.
  expect(motion.frames.some(frame => frame.x > -motion.width + 1 && frame.x < -1), JSON.stringify(motion)).toBe(true);
  expect(motion.frames.find(frame => frame.x > -motion.width + 1)?.elapsed, JSON.stringify(motion)).toBeLessThan(100);
  expect(Math.abs(motion.frames.at(-1)!.x)).toBeLessThanOrEqual(1);
  expect(motion.after).toEqual(motion.before);
  const dialog = page.locator("[data-agent-history-drawer]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create new chat" })).toBeVisible();
  const measured = await dialog.evaluate(frame => {
    const title = frame.querySelector("h2")!;
    const body = frame.querySelector<HTMLElement>("aside")!;
    const before = [title.getBoundingClientRect().x, body.getBoundingClientRect().x];
    const dispatch = (type: string, x: number, time: number) => {
      const point = { identifier: 1, clientX: x, clientY: 320 };
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { touches: { value: [point] }, changedTouches: { value: [point] }, timeStamp: { value: time } });
      body.dispatchEvent(event);
    };
    dispatch("touchstart", 160, 100); dispatch("touchmove", 110, 220);
    const after = [title.getBoundingClientRect().x, body.getBoundingClientRect().x];
    dispatch("touchcancel", 110, 240);
    return { before, after, frameTransform: (frame as HTMLElement).style.transform };
  });
  expect(measured.after[0]! - measured.before[0]!).toBeCloseTo(-50, 0);
  expect(measured.after[1]! - measured.before[1]!).toBeCloseTo(-50, 0);
  expect(measured.frameTransform).toContain("translate3d");
  await expect(dialog).toHaveAttribute("aria-hidden", "false");
  await expect.poll(() => dialog.evaluate(element => element.getBoundingClientRect().x)).toBeCloseTo(0, 0);
  const exit = await page.evaluate(async () => {
    const panel = document.querySelector<HTMLElement>("[data-agent-history-drawer]")!;
    // The authored Escape handler closes History without another navigation owner.
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const samples: number[] = [];
    const start = performance.now();
    await new Promise<void>(resolve => {
      const sample = () => {
        samples.push(panel.getBoundingClientRect().x);
        if (performance.now() - start < 260) requestAnimationFrame(sample); else resolve();
      };
      requestAnimationFrame(sample);
    });
    return { samples, width: panel.offsetWidth };
  });
  expect(exit.samples.some(x => x < -1 && x > -exit.width + 1), JSON.stringify(exit)).toBe(true);
  expect(exit.samples.at(-1)).toBeCloseTo(-exit.width - 48, 0);
});
