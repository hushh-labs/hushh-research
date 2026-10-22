import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Render production components and styles; replace only device/map/telemetry
// boundaries. Handwritten card markup previously hid the reported regressions.
let fixtureCss: string;
let fixtureScript: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "location-onboarding-"));
  const stubs: Record<string, string> = {
    "@/lib/one-location/use-google-maps": "export const useGoogleMaps = () => ({ isLoaded: false });",
    "@/lib/one-location/use-current-location": "export const useCurrentLocation = () => ({ snapshot: null });",
    "@/components/one-location/onboarding/onboarding-live-map": "export const OnboardingLiveMap = () => null;",
    "@/components/app-ui/native-test-beacon": "export const NativeTestBeacon = () => null;",
    "@/lib/observability/client": "export const trackEvent = () => {};",
    "@/lib/observability/growth": "export const trackLocationFunnelStepCompleted = () => {};",
  };
  await build({
    configFile: false, publicDir: false, logLevel: "error",
    plugins: [{
      name: "onboarding-boundaries",
      load(id) { return stubs[id.replace("\0", "")]; },
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [...Object.keys(stubs).map(find => ({ find, replacement: `\0${find}` })), { find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/location-onboarding.tsx"), name: "OnboardingFixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  fixtureScript = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  fixtureCss = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function openFixture(page: Page, { ready = false, dark = false, banner = false } = {}) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/one-location/onboarding/*.webp", route => route.fulfill({ contentType: "image/webp", body: fs.readFileSync(path.join("public/one-location/onboarding", path.basename(new URL(route.request().url()).pathname))) }));
  await page.route("**/one-location/onboarding/check-in-location-pin.svg", route => route.fulfill({ contentType: "image/svg+xml", body: fs.readFileSync("public/one-location/onboarding/check-in-location-pin.svg") }));
  await page.setContent(`<html class="${dark ? "dark" : ""}"><head><base href="http://fixture.invalid/"><style>${fixtureCss}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(flags => { window.onboardingFixture = flags; }, { ready, banner });
  await page.addScriptTag({ content: fixtureScript });
  await expect.poll(() => errors.length ? errors : page.getByTestId(banner ? "saved-places-banner" : "one-location-onboarding").count()).toBe(1);
  await awaitProductFont(page);
}

const VIEWPORTS = [
  { width: 320, height: 568 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 768, height: 1024 }, { width: 1440, height: 900 },
];

test("the artwork is not positioned from the viewport", async ({ page }) => {
  let firstPinOffset: number | undefined;
  for (const height of [667, 812, 844, 932]) {
    await page.setViewportSize({ width: 390, height });
    await openFixture(page);
    const measured = await page.evaluate(() => {
      const artNodes = [...document.querySelectorAll("[data-one-use-case-art], [data-one-feature-art-region]")];
      const card = document.querySelector('[data-one-feature-card="checkin"]')!;
      const cardBox = card.getBoundingClientRect();
      const pin = card.querySelector("[data-one-checkin-destination]")!.getBoundingClientRect();
      return {
        artCount: artNodes.length,
        artFits: artNodes.every(art => {
          const parent = art.closest("[data-one-use-case-card]")!.getBoundingClientRect();
          const box = art.getBoundingClientRect();
          return box.top >= parent.top - 1 && box.bottom <= parent.bottom + 1;
        }),
        copyBottom: card.querySelector("[data-one-feature-copy]")!.getBoundingClientRect().bottom,
        pinTop: pin.top,
        pinOffset: pin.top - cardBox.top,
      };
    });
    expect(measured.artCount).toBe(3);
    expect(measured.artFits).toBe(true);
    // Mobile artwork sits beside the copy; desktop places it below.
    expect(measured.artFits).toBe(true);
    firstPinOffset ??= measured.pinOffset;
    expect(Math.abs(measured.pinOffset - firstPinOffset)).toBeLessThanOrEqual(1);
  }
});

for (const viewport of VIEWPORTS) {
  test(`keeps actual cards readable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    const checkin = page.getByTestId("location-use-case-checkin");
    await expect(checkin.locator("[data-one-feature-title-line]")).toHaveCount(2);
    await expect(page.locator("[data-one-checkin-illustration]")).toHaveCount(0);
    await expect(checkin.locator("[data-one-checkin-pin]")).toBeVisible();
    await expect(checkin.locator("img")).toHaveCount(1);
    await expect.poll(() => checkin.locator("[data-one-checkin-pin]").evaluate((pin: HTMLImageElement) => pin.complete && pin.naturalWidth > 0)).toBe(true);
    await expect(page.locator("[data-one-feature-map]")).toHaveCount(3);
    const layout = await page.evaluate(() => {
      const sms = document.querySelector('[data-one-feature-card="sms"]')!;
      const cardBox = sms.getBoundingClientRect();
      const rings = [...sms.querySelectorAll('[data-one-sms-radar-ring]')];
      rings.forEach(ring => {
        const animation = ring.getAnimations()[0];
        animation.pause();
        animation.currentTime = 2399;
      });
      const radialArtFits = rings.every(ring => {
        const box = ring.getBoundingClientRect();
        return box.top >= cardBox.top - 1 && box.bottom <= cardBox.bottom + 1
          && box.left >= cardBox.left - 1 && box.right <= cardBox.right + 1;
      });
      rings.forEach(ring => { ring.getAnimations()[0].currentTime = 900; });
      const font = (node: Element) => {
        const style = getComputedStyle(node);
        return { family: style.fontFamily, size: style.fontSize,
          line: style.lineHeight, weight: style.fontWeight, tracking: style.letterSpacing };
      };
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        linesFit: [...document.querySelectorAll<HTMLElement>("[data-one-feature-title-line]")].every(line => line.scrollWidth <= line.clientWidth + 1),
        copyFits: [...document.querySelectorAll<HTMLElement>("[data-one-feature-card]")].every(card => card.querySelector("[data-one-feature-copy]")!.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom),
        ctaBottom: document.querySelector("[data-one-feature-cta]")!.getBoundingClientRect().bottom,
        radialArtFits,
        headingSize: getComputedStyle(document.querySelector("[data-one-feature-heading]")!).fontSize,
        headingWeight: getComputedStyle(document.querySelector("[data-one-feature-heading]")!).fontWeight,
        titleFonts: [...document.querySelectorAll("[data-one-feature-title]")].map(font),
        titleLineFonts: [...document.querySelectorAll("[data-one-feature-title-line]")].map(font),
        bodyFonts: [...document.querySelectorAll("[data-one-feature-body]")].map(font),
      };
    });
    expect(layout.headingSize).toBe("28px");
    expect(layout.headingWeight).toBe("600");
    const headingRole = expect.objectContaining({ size: "14px", line: "22px", weight: "600", tracking: "normal" });
    expect(layout.titleFonts).toEqual([headingRole, headingRole, headingRole]);
    expect(layout.titleLineFonts).toEqual(Array(6).fill(headingRole));
    const descriptionRole = expect.objectContaining({ size: "12px", line: "18px", weight: "400", tracking: "normal" });
    expect(layout.bodyFonts).toEqual([descriptionRole, descriptionRole, descriptionRole]);
    for (const font of [...layout.titleFonts, ...layout.titleLineFonts, ...layout.bodyFonts]) {
      expect(font.family).toContain("Plus Jakarta Sans");
    }
    expect(layout.overflow).toBe(false);
    expect(layout.linesFit).toBe(true);
    expect(layout.copyFits).toBe(true);
    expect(layout.radialArtFits).toBe(true);
    expect(layout.ctaBottom).toBeLessThanOrEqual(viewport.height);
    await page.getByTestId("one-location-onboarding-features").screenshot({ path: testInfo.outputPath("features.png") });
    if (viewport.width < 768) {
      await page.getByTestId("location-use-case-sos").scrollIntoViewIfNeeded();
      await page.getByTestId("location-use-case-sos").screenshot({ path: testInfo.outputPath("sms-card.png") });
    }
  });
}

test("animates only radial outlines around the static SMS core", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  const measured = await page.evaluate(() => {
    const core = document.querySelector("[data-one-sms-core]")!;
    const radar = document.querySelector("[data-one-sms-radar]")!;
    const rings = [...document.querySelectorAll("[data-one-sms-radar-ring]")];
    const animations = rings.map(ring => ring.getAnimations()[0]);
    const rect = () => { const box = core.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; };
    const before = rect();
    animations.forEach(animation => { animation.pause(); animation.currentTime = 400; });
    const ringBefore = rings[0].getBoundingClientRect().width;
    animations.forEach(animation => { animation.currentTime = 1100; });
    return { coreBefore: before, coreAfter: rect(), coreAnimations: core.getAnimations().length, radarAnimations: radar.getAnimations().length, ringBefore, ringAfter: rings[0].getBoundingClientRect().width };
  });
  expect(measured.coreAnimations).toBe(0);
  expect(measured.radarAnimations).toBe(0);
  expect(measured.coreAfter).toEqual(measured.coreBefore);
  expect(measured.ringAfter).toBeGreaterThan(measured.ringBefore);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator("[data-one-sms-radar-ring]").first().evaluate(node => getComputedStyle(node).opacity)).toBe("0");
});

test("keeps map art themed and feature Back local", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page, { dark: true });
  expect(await page.locator('[data-one-feature-map="share"] rect').first().evaluate(node => getComputedStyle(node).fill)).not.toBe("rgb(237, 241, 246)");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("one-location-onboarding-ready")).toBeVisible();
  await expect(page.getByText("3 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Private until you share.")).toHaveCount(0);
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("one-location-onboarding-features")).toBeVisible();
  await page.evaluate(() => window.onboardingBack());
  await expect(page.getByText("Agents home")).toBeVisible();
});

for (const width of [320, 390, 1280]) {
  test(`keeps contact and completion actions compact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page, { ready: true });
    await page.getByRole("button", { name: "Find contacts" }).click();
    await expect(page.getByText(/Phone numbers are standardized/)).toHaveCount(0);
    const contact = page.getByRole("button", { name: "Check my contacts" });
    await contact.scrollIntoViewIfNeeded();
    expect(await contact.evaluate(node => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderRadius, height: node.getBoundingClientRect().height };
    })).toMatchObject({ background: "rgba(0, 0, 0, 0)", border: "0px", radius: "0px", height: 44 });
    const complete = page.getByRole("button", { name: "Open One Location" });
    const box = (await complete.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(244);
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    await contact.click();
    await expect(page.getByText("No eligible contacts matched.")).toBeVisible();
  });
}

for (const width of [320, 390, 1440]) {
  test(`keeps the places banner readable and dismissible at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page, { banner: true, dark: width === 390 });
    const banner = page.getByTestId("saved-places-banner");
    const dismiss = page.getByRole("button", { name: "Dismiss saved places reminder" });
    const box = (await dismiss.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await banner.getByRole("heading").evaluate(node => getComputedStyle(node).fontSize)).toBe("17px");
    expect(await banner.evaluate(node => ({ radius: getComputedStyle(node).borderRadius, overflow: node.scrollWidth > node.clientWidth + 1 }))).toEqual({ radius: "18px", overflow: false });
    await expect(page.getByRole("button", { name: "Save a place" })).toBeVisible();
    const saveBox = (await page.getByRole("button", { name: "Save a place" }).boundingBox())!;
    const bannerBox = (await banner.boundingBox())!;
    expect(saveBox.height).toBeGreaterThanOrEqual(44);
    expect(bannerBox.height).toBeLessThanOrEqual(width >= 640 ? 74 : 124);
    expect(await banner.evaluate(node => getComputedStyle(node).paddingTop)).toBe(width >= 640 ? "12px" : "10px");
    expect(saveBox.x + saveBox.width <= box.x || saveBox.y >= box.y + box.height).toBe(true);
    await banner.screenshot({ path: testInfo.outputPath("places-banner.png") });
    await dismiss.click();
    await expect(banner).toHaveCount(0);
  });
}
