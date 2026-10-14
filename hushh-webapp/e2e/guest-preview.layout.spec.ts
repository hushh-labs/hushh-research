import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

let css: string;
let script: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-guest-preview-"));
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": root } },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/guest-preview.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
});

test.beforeEach(async ({ page }) => {
  await page.route("http://one-preview.test/brand/hushh-mark.png*", async (route) => {
    await route.fulfill({ path: path.join(process.cwd(), "public/brand/hushh-mark.png") });
  });
  await page.route("http://one-preview.test/_next/image*", async (route) => {
    const source = new URL(route.request().url()).searchParams.get("url") ?? "";
    const introPrefix = "/onboarding/intro-v2/";
    const welcomePrefix = "/onboarding/welcome-stitch/";
    await route.fulfill({
      path: source.startsWith(introPrefix)
        ? path.join(process.cwd(), "public/onboarding/intro-v2", source.slice(introPrefix.length))
        : source.startsWith(welcomePrefix)
          ? path.join(process.cwd(), "public/onboarding/welcome-stitch", source.slice(welcomePrefix.length))
          : source === "/onboarding/figma/one-light.svg"
            ? path.join(process.cwd(), "public/onboarding/figma/one-light.svg")
        : path.join(process.cwd(), "public/brand/hushh-mark.png"),
    });
  });
  await page.route("http://one-preview.test/onboarding/figma/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ path: path.join(process.cwd(), "public/onboarding/figma", name) });
  });
  await page.route("http://one-preview.test/onboarding/welcome-stitch/**", async (route) => {
    const relativePath = new URL(route.request().url()).pathname.slice("/onboarding/welcome-stitch/".length);
    await route.fulfill({ path: path.join(process.cwd(), "public/onboarding/welcome-stitch", relativePath) });
  });
  await page.route("http://one-preview.test/onboarding/intro-v2/**", async (route) => {
    const relativePath = new URL(route.request().url()).pathname.slice("/onboarding/intro-v2/".length);
    await route.fulfill({ path: path.join(process.cwd(), "public/onboarding/intro-v2", relativePath) });
  });
  await page.route("http://one-preview.test/onboarding/mentor-v72/**", async (route) => {
    const relativePath = new URL(route.request().url()).pathname.slice("/onboarding/mentor-v72/".length);
    await route.fulfill({ path: path.join(process.cwd(), "public/onboarding/mentor-v72", relativePath) });
  });
});

test("welcome headline and action remain usable when decorative images fail", async ({
  page,
}) => {
  await page.route("http://one-preview.test/_next/image*", (route) =>
    route.abort(),
  );
  await page.route("http://one-preview.test/brand/hushh-mark.png*", (route) =>
    route.abort(),
  );
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(
    `<html class="dark"><head><base href="http://one-preview.test/"><style>${css}:root { --app-fullscreen-flow-content-offset: 0px; --app-scroll-bottom-pad: 0px; }</style></head><body><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  const preview = page.getByTestId("guest-preview");
  await expect(preview.getByRole("heading", { name: "Your private AI agent for everyday life." })).toBeVisible();
  const cta = preview.getByRole("button", { name: "Create your One", exact: true });
  await cta.scrollIntoViewIfNeeded();
  await expect(cta).toBeInViewport();
  await cta.click();
  await expect(preview).toHaveAttribute("data-preview-step", "2");
});

const STORY_TITLES = [
  "Big plans.Less busywork.",
  "Find answers.Not more tabs.",
  "Your people.Right here.",
  "Your information.Your call.",
] as const;
const STORY_IDS = ["ask", "know", "connect", "control"] as const;

function storyCard(preview: Locator, index: number) {
  return preview.locator(`.ao-slide[data-story="${STORY_IDS[index - 1]}"]`);
}

async function mountPreview(
  page: Page,
  { dark, viewport }: { dark: boolean; viewport: { width: number; height: number; top: number; bottom: number } },
) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(
    `<html class="${dark ? "dark" : ""}" data-invite="true"><head><base href="http://one-preview.test/"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}:root { --app-fullscreen-flow-content-offset: 0px; --app-scroll-bottom-pad: 0px; --app-safe-area-top-effective: ${viewport.top}px; --app-safe-area-bottom-effective: ${viewport.bottom}px; }</style></head><body><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  return page.getByTestId("guest-preview");
}

test("welcome leads into four stories and only the last action starts", async ({ page }) => {
  const preview = await mountPreview(page, {
    dark: false,
    viewport: { width: 393, height: 852, top: 59, bottom: 34 },
  });
  await expect(preview).toHaveAttribute("data-preview-step", "1");
  await expect(preview.getByRole("heading", { name: "Your private AI agent for everyday life." })).toBeVisible();
  await expect.poll(() => preview.locator('img[src*="one-mascot"]').evaluate((image) =>
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
  )).toBe(true);
  for (const cue of ["Find a time", "Catch me up", "My access"]) {
    await expect(preview.getByText(cue, { exact: true })).toBeVisible();
  }
  await preview.getByRole("button", { name: "Create your One", exact: true }).click();
  await expect(preview).toHaveAttribute("data-preview-step", "2");
  await expect(storyCard(preview, 1).locator(".ao-back")).toBeDisabled();
  await storyCard(preview, 1).getByRole("button", { name: "Screen 2 of 4: Find your answers" }).click();
  await expect(preview).toHaveAttribute("data-preview-step", "3");
  await expect(page.locator("html")).not.toHaveAttribute("data-started", "true");
  await storyCard(preview, 2).getByRole("button", { name: "Previous screen" }).click();
  await expect(preview).toHaveAttribute("data-preview-step", "2");

  for (let index = 1; index <= STORY_TITLES.length; index++) {
    const card = storyCard(preview, index);
    await expect(preview).toHaveAttribute("data-preview-step", String(index + 1));
    await expect(card.locator("[data-intro-v2-title]")).toHaveText(STORY_TITLES[index - 1]);
    await expect(card).toBeVisible();
    await expect(preview.locator("[data-intro-v2-card]:visible")).toHaveCount(1);
    await expect(page.locator("html")).not.toHaveAttribute("data-started", "true");
    if (index < STORY_TITLES.length) {
      await card.getByRole("button", { name: "Next", exact: true }).click();
    } else {
      await expect(preview.getByText("Invited by Alex")).toBeVisible();
      await card.getByRole("button", { name: "Join this Circle" }).click();
    }
  }
  await expect(page.locator("html")).toHaveAttribute("data-started", "true");
});

for (const viewport of [
  { width: 305, height: 568, top: 20, bottom: 0 },
  { width: 320, height: 568, top: 20, bottom: 0 },
  { width: 375, height: 667, top: 20, bottom: 0 },
  { width: 390, height: 844, top: 59, bottom: 34 },
  { width: 393, height: 852, top: 59, bottom: 34 },
  { width: 390, height: 664, top: 0, bottom: 0 },
  { width: 768, height: 1024, top: 24, bottom: 20 },
  { width: 900, height: 600, top: 0, bottom: 0 },
  { width: 901, height: 600, top: 0, bottom: 0 },
  { width: 1024, height: 768, top: 0, bottom: 0 },
  { width: 1320, height: 800, top: 0, bottom: 0 },
  { width: 1440, height: 900, top: 0, bottom: 0 },
]) {
  for (const dark of [false, true]) {
    test(`five-step introduction ${viewport.width}x${viewport.height} ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const preview = await mountPreview(page, { dark, viewport });
      await expect(preview).toHaveAttribute("data-preview-step", "1");
      const welcomeTitle = preview.getByRole("heading", { level: 1 });
      await expect(welcomeTitle).toBeVisible();
      expect(await welcomeTitle.evaluate((element) => element.scrollWidth - element.clientWidth), "welcome title is not clipped").toBeLessThanOrEqual(1);
      await preview.getByRole("button", { name: "Create your One", exact: true }).click();

      for (let index = 1; index <= STORY_TITLES.length; index++) {
        const card = storyCard(preview, index);
        const title = card.locator("[data-intro-v2-title]");
        await expect(preview).toHaveAttribute("data-preview-step", String(index + 1));
        await expect(title).toHaveText(STORY_TITLES[index - 1]);
        await expect(card).toBeVisible();
        await expect(preview.locator("[data-intro-v2-card]:visible")).toHaveCount(1);
        if (viewport.width >= 800) {
          const artBounds = (await card.locator(".ao-hero").boundingBox())!;
          const copyBounds = (await card.locator(".ao-sheet").boundingBox())!;
          expect(artBounds.x + artBounds.width, "desktop places complete artwork beside the copy").toBeLessThanOrEqual(copyBounds.x);
        }
        await expect.poll(
          () => card.locator("img").evaluateAll((images) =>
            images.filter((image) => image.complete && image.naturalWidth > 0).length),
          { message: "The original One artwork loads" },
        ).toBeGreaterThanOrEqual(1);
        const size = await page.evaluate(() => ({
          excessWidth: document.documentElement.scrollWidth - innerWidth,
          excessHeight: document.documentElement.scrollHeight - innerHeight,
        }));
        expect(size.excessWidth, "no horizontal scrolling").toBeLessThanOrEqual(1);
        if (viewport.width <= 900 && viewport.height >= 800) {
          expect(size.excessHeight, "standard phone and tablet screens fit").toBeLessThanOrEqual(1);
        }
        expect(await title.evaluate((element) => element.scrollWidth - element.clientWidth), "story title is not clipped").toBeLessThanOrEqual(1);
        const next = card.getByRole("button", {
          name: index === STORY_TITLES.length ? "Join this Circle" : "Next",
          exact: true,
        });
        await next.scrollIntoViewIfNeeded();
        await expect(next).toBeInViewport();
        const bounds = (await next.boundingBox())!;
        expect(bounds.height, "primary action tap target").toBeGreaterThanOrEqual(44);
        if (size.excessHeight <= 1) {
          expect(bounds.y + bounds.height, "primary action clears the safe area").toBeLessThanOrEqual(viewport.height - viewport.bottom + 1);
        }
        await page.screenshot({ path: testInfo.outputPath(`story-${index}.png`), animations: "disabled" });
        await expect(page.locator("html")).not.toHaveAttribute("data-started", "true");
        if (index < STORY_TITLES.length) await next.click();
      }
      expect(errors).toEqual([]);
    });
  }
}
