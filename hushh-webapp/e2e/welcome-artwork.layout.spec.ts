import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

type Box = { x: number; y: number; width: number; height: number };

let mascotPixels: Buffer;
let mascotWidth = 0;
let mascotHeight = 0;
let mascotChannels = 0;
let visibleMascotCenterRatio = 0;

test.beforeAll(async ({}, testInfo) => {
  const source = path.resolve(testInfo.config.rootDir, "../public/onboarding/welcome-stitch/one-mascot.png");
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  mascotPixels = data;
  mascotWidth = info.width;
  mascotHeight = info.height;
  mascotChannels = info.channels;
  let minX = mascotWidth;
  let maxX = 0;
  for (let y = 0; y < mascotHeight; y += 1) {
    for (let x = 0; x < mascotWidth; x += 1) {
      if (mascotPixels[(y * mascotWidth + x) * mascotChannels + 3] <= 64) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  visibleMascotCenterRatio = (minX + maxX) / 2 / mascotWidth;
});

// Test the actual transparent mascot silhouette against rendered controls.
// The image element's own box contains broad transparent margins.
function mascotTouches(box: Box, image: Box, clearance: number): boolean {
  const left = Math.max(0, Math.floor(((box.x - clearance - image.x) / image.width) * mascotWidth));
  const right = Math.min(mascotWidth - 1, Math.ceil(((box.x + box.width + clearance - image.x) / image.width) * mascotWidth));
  const top = Math.max(0, Math.floor(((box.y - clearance - image.y) / image.height) * mascotHeight));
  const bottom = Math.min(mascotHeight - 1, Math.ceil(((box.y + box.height + clearance - image.y) / image.height) * mascotHeight));
  for (let y = top; y <= bottom; y += 2) {
    for (let x = left; x <= right; x += 2) {
      if (mascotPixels[(y * mascotWidth + x) * mascotChannels + 3] > 64) return true;
    }
  }
  return false;
}

function boxesTouch(a: Box, b: Box, clearance: number): boolean {
  return a.x < b.x + b.width + clearance
    && a.x + a.width + clearance > b.x
    && a.y < b.y + b.height + clearance
    && a.y + a.height + clearance > b.y;
}

const viewports = [
  { width: 305, height: 812 },
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 900, height: 600 },
  { width: 1024, height: 768 },
  { width: 1530, height: 883 },
];

for (const theme of ["light", "dark"]) {
  for (const viewport of viewports) {
    test(`welcome artwork has clear logo and face ${theme} ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem("theme", value), theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/?invite=one");
      const preview = page.getByTestId("guest-preview");
      await expect(preview).toHaveAttribute("data-preview-step", "1", { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);

      const artwork = preview.locator("[data-welcome-artwork]");
      const scene = preview.locator("[data-welcome-scene]");
      const mascot = preview.locator("[data-welcome-mascot]");
      const wordmark = preview.locator("[data-welcome-wordmark]");
      await expect.poll(() => mascot.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect.poll(() => wordmark.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const artBox = await artwork.boundingBox();
      const sceneBox = await scene.boundingBox();
      const mascotBox = await mascot.boundingBox();
      const wordmarkBox = await wordmark.boundingBox();
      expect(artBox && sceneBox && mascotBox && wordmarkBox).toBeTruthy();
      if (!artBox || !sceneBox || !mascotBox || !wordmarkBox) return;

      const visibleMascotCenter = mascotBox.x + mascotBox.width * visibleMascotCenterRatio;
      expect(Math.abs(visibleMascotCenter - (artBox.x + artBox.width / 2))).toBeLessThan(artBox.width * .03);
      expect(mascotTouches(wordmarkBox, mascotBox, 8)).toBe(false);

      // The supplied composition lets cards overlap the mascot's outer edge.
      // Keep the eyes and expression unobstructed at every viewport instead.
      const faceBox = {
        x: mascotBox.x + mascotBox.width * .4,
        y: mascotBox.y + mascotBox.height * .28,
        width: mascotBox.width * .22,
        height: mascotBox.height * .26,
      };

      for (const name of ["calendar", "mail", "consent"]) {
        const cueBox = await preview.locator(`[data-welcome-cue="${name}"]`).boundingBox();
        expect(cueBox).toBeTruthy();
        if (!cueBox) continue;
        expect(boxesTouch(cueBox, faceBox, 4), `${name} covers the mascot's face`).toBe(false);
        expect(boxesTouch(cueBox, wordmarkBox, 6), `${name} overlaps the One wordmark`).toBe(false);
        expect(cueBox.x, `${name} clips at the left viewport edge`).toBeGreaterThanOrEqual(sceneBox.x);
        expect(cueBox.x + cueBox.width, `${name} clips at the right viewport edge`).toBeLessThanOrEqual(sceneBox.x + sceneBox.width);
      }

      if (viewport.width === 1530 || viewport.width === 393) {
        await page.screenshot({ path: testInfo.outputPath(`welcome-${theme}.png`) });
      }
    });
  }
}
