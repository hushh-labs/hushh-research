import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

const origin = "http://mentor-onboarding.test";
const stories = [
  { id: "ask", title: "Big plans. Less busywork.", description: "Plan your day and draft replies. Just ask One." },
  { id: "know", title: "Find answers. Not more tabs.", description: "Search your files, finances and saved details in one place." },
  { id: "connect", title: "Your people. Right here.", description: "Message, send voice notes and share location with people you choose." },
  { id: "control", title: "Your information. Your call.", description: "Choose who sees what, and for how long. Stop access anytime." },
] as const;

let css: string;
let script: string;

test.beforeAll(async () => {
  const { build } = await import("vite");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mentor-onboarding-"));
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": process.cwd() } },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: { entry: path.join(process.cwd(), "e2e/fixtures/mentor-onboarding.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  css = productFontStyle() + fs.readdirSync(outDir).filter((name) => name.endsWith(".css")).map((name) => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/onboarding/mentor-v72/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice("/onboarding/mentor-v72/".length);
    await route.fulfill({ path: path.join(process.cwd(), "public/onboarding/mentor-v72", name) });
  });
  await page.route(`${origin}/`, (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div></body></html>',
  }));
});

async function mount(page: Page, reducedMotion: "reduce" | "no-preference" = "reduce", textScale = 1) {
  await page.emulateMedia({ reducedMotion });
  await page.goto(origin);
  await page.addStyleTag({ content: `${css}\nhtml { font-size: ${16 * textScale}px; } html, body, #root { width: 100%; height: 100%; margin: 0; } body { background: white; }` });
  await page.addScriptTag({ content: script });
  await expect(page.locator(".ao-slide")).toBeVisible();
  await awaitProductFont(page);
}

async function assertStory(page: Page, index: number) {
  const story = stories[index];
  await expect(page.locator(".ao-slide")).toHaveCount(1);
  await expect(page.locator(".ao-slide")).toHaveAttribute("data-story", story.id);
  await expect(page.locator(".ao-title")).toHaveText(story.title.replace(". ", "."));
  await expect(page.locator(".ao-description")).toHaveText(story.description);
  await expect(page.locator(".ao-progress button")).toHaveCount(4);
  await expect(page.locator(".ao-progress button[aria-current='step']")).toHaveCount(1);
  await expect(page.locator(".ao-progress button").nth(index)).toHaveAttribute("aria-current", "step");
  await expect(page.locator(".ao-onboarding header")).toHaveCount(0);
  await expect.poll(() => page.locator(".ao-onboarding img").evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
}

async function assertLayout(page: Page, textScale = 1) {
  const geometry = await page.locator(".ao-onboarding").evaluate((root) => {
    const rect = (selector: string) => {
      const box = root.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const scene = rect(".ao-scene");
    const mascot = rect(".ao-mascot");
    return {
      overflow: root.scrollWidth - root.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      progress: rect(".ao-progress-row"),
      actions: rect(".ao-actions"),
      skip: rect(".ao-skip"),
      primary: rect(".ao-primary"),
      scene,
      mascot,
      heading: rect(".ao-title"),
      description: rect(".ao-description"),
    };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.skip.right).toBeLessThanOrEqual(geometry.primary.x);
  expect(geometry.progress.bottom).toBeLessThanOrEqual(geometry.actions.y + 1);
  expect(geometry.heading.bottom).toBeLessThanOrEqual(geometry.description.y + 1);
  expect(geometry.description.bottom).toBeLessThanOrEqual(geometry.progress.y + 1);
  expect(geometry.primary.height).toBeGreaterThanOrEqual(44);
  expect(geometry.skip.height).toBeGreaterThanOrEqual(44);
  expect(geometry.primary.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(geometry.skip.x).toBeGreaterThanOrEqual(0);
  expect(geometry.mascot.x).toBeGreaterThanOrEqual(geometry.scene.x - 1);
  expect(geometry.mascot.right).toBeLessThanOrEqual(geometry.scene.right + 1);
  expect(geometry.mascot.y).toBeGreaterThanOrEqual(geometry.scene.y - 1);
  expect(geometry.mascot.bottom).toBeLessThanOrEqual(geometry.scene.bottom + 1);
  if (textScale === 1) expect(geometry.primary.width).toBeLessThan(geometry.actions.width * 0.75);
  await page.locator(".ao-primary").scrollIntoViewIfNeeded();
  await expect(page.locator(".ao-primary")).toBeInViewport();
}

const viewports = [
  [320, 568], [360, 640], [375, 667], [390, 844], [430, 932], [480, 800], [844, 390],
  [768, 1024], [800, 600], [1024, 768], [1280, 720], [1440, 900], [1920, 1080], [402, 874], [852, 393],
];

for (const [width, height] of viewports) {
  test(`all four mentor stories retain their art and footer at ${width}x${height}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await mount(page);
    for (let index = 0; index < stories.length; index += 1) {
      await assertStory(page, index);
      await assertLayout(page);
      if ((width === 390 && height === 844) || (width === 1440 && height === 900)) {
        await page.screenshot({ path: testInfo.outputPath(`mentor-${stories[index].id}-${width}x${height}.png`), fullPage: true });
      }
      if (index < stories.length - 1) await page.getByRole("button", { name: "Next", exact: true }).click();
    }
    expect(errors).toEqual([]);
  });
}

for (const [width, height] of [[320, 568], [1024, 768]]) {
  test(`200% text stays readable and every action remains reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mount(page, "reduce", 2);
    for (let index = 0; index < stories.length; index += 1) {
      await assertStory(page, index);
      await assertLayout(page, 2);
      if (index < stories.length - 1) await page.getByRole("button", { name: "Next", exact: true }).click();
    }
  });
}

test("navigation supports focus, pips, arrows, pointer swipes, and explicit completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await expect(page.locator(".ao-mascot__loop")).toHaveCount(0);
  await page.locator(".ao-onboarding").focus();
  await page.keyboard.press("ArrowLeft");
  await assertStory(page, 0);
  await page.getByRole("button", { name: "Skip", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ao-title")).toBeFocused();
  await assertStory(page, 1);
  await page.getByRole("button", { name: "Previous screen" }).click();
  await assertStory(page, 0);
  await page.getByRole("button", { name: "Screen 3 of 4: Stay close" }).click();
  await assertStory(page, 2);
  await page.keyboard.press("ArrowRight");
  await assertStory(page, 3);
  await page.keyboard.press("ArrowRight");
  await assertStory(page, 3);
  await page.keyboard.press("ArrowLeft");
  await assertStory(page, 2);

  const box = await page.locator(".ao-scene").boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await assertStory(page, 2);
  await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await assertStory(page, 3);
  await expect(page.locator("html")).not.toHaveAttribute("data-completed");
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-completed", "finished");

  await mount(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-completed", "skipped");
});

test("normal motion plays once and returns to a loaded original poster", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, "no-preference");
  await expect(page.locator(".ao-mascot")).toHaveAttribute("data-playing", "true");
  await expect(page.locator(".ao-mascot__loop")).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(".ao-mascot__poster")).toHaveCSS("opacity", "1");
  await expect(page.locator(".ao-mascot__poster")).toHaveJSProperty("naturalWidth", 512);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".ao-mascot")).toHaveAttribute("data-mascot", "thinking");
  await expect(page.locator(".ao-mascot")).toHaveAttribute("data-playing", "true");
});
