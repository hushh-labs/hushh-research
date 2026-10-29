import { expect, test } from "@playwright/test";
import { buildOnboardingFixture, openFixture } from "./fixtures/render-location-onboarding";

test.beforeAll(buildOnboardingFixture);
const VIEWPORTS = [
  { width: 320, height: 568 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 768, height: 1024 }, { width: 1440, height: 900 },
];

// Retain the protected height sweep after merging the illustrated intro into
// Your place. Measure the actual map visual and copy, rather than dead artwork.
test("the artwork is not positioned from the viewport", async ({ page }) => {
  let firstPinOffset: number | undefined;
  for (const height of [667, 812, 844, 932]) {
    await page.setViewportSize({ width: 390, height });
    await openFixture(page);
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByRole("button", { name: "Save & continue" })).toBeEnabled();
    const map = page.locator("[data-location-picker-surface]");
    const measured = await map.evaluate(node => {
      const box = node.getBoundingClientRect();
      const visual = node.querySelector("[role=status] svg")!.getBoundingClientRect();
      const copy = node.querySelector("[role=status] p")!.getBoundingClientRect();
      return {
        pinOffset: visual.top + visual.height / 2 - (box.top + box.height / 2),
        visualFits: visual.top >= box.top && visual.bottom <= copy.top,
        copyFits: copy.bottom <= box.bottom && copy.left >= box.left && copy.right <= box.right,
        scrolls: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    firstPinOffset ??= measured.pinOffset;
    expect(Math.abs(measured.pinOffset - firstPinOffset)).toBeLessThanOrEqual(1);
    expect(measured.visualFits).toBe(true);
    expect(measured.copyFits).toBe(true);
    expect(measured.scrolls).toBe(false);
    const mapBox = (await map.boundingBox())!;
    const address = (await page.getByRole("button", { name: "Edit address details" }).boundingBox())!;
    expect(mapBox.y + mapBox.height).toBeLessThanOrEqual(address.y);
    await expect(page.getByRole("button", { name: "Save & continue" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Set up later" })).toBeInViewport({ ratio: 1 });
  }
});

for (const viewport of VIEWPORTS) {
  test(`fits the place and atomic save at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openFixture(page, { dark: viewport.width === 430 });
    await expect(page.getByRole("heading", { name: "Your place." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use my location" })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByRole("button", { name: "Save & continue" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save & continue" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Set up later" })).toBeInViewport({ ratio: 1 });
    expect(await page.getByTestId("one-location-onboarding-place-screen").evaluate(node => ({
      x: node.scrollWidth > node.clientWidth + 1, y: node.scrollHeight > node.clientHeight + 1,
    }))).toEqual({ x: false, y: false });
    const map = await page.locator("[data-location-picker-surface]").boundingBox();
    expect(map!.height).toBeGreaterThanOrEqual(104);
    const hint = await page.getByText("Using the captured point.", { exact: true }).evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const { x, width } = range.getBoundingClientRect();
      return { x, width };
    });
    expect(hint.x).toBeGreaterThanOrEqual(map!.x + 8);
    expect(hint.x + hint.width).toBeLessThanOrEqual(map!.x + map!.width - 8);
    await page.getByTestId("save-location-modal").screenshot({ path: testInfo.outputPath("your-place.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Edit address details" }).click();
    await page.getByRole("textbox", { name: "House or flat" }).fill("Flat 4B");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByRole("heading", { name: "Your people." })).toBeVisible();
    await page.getByRole("button", { name: "Go back" }).click();
    await expect(page.getByText("Place saved.", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  });
}

test("uses local Back and keeps optional work in focused sheets", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 844 });
  await openFixture(page);
  await page.getByRole("button", { name: "Set up later" }).click();
  await page.getByRole("button", { name: "Join with a code" }).click();
  await expect(page.getByRole("dialog", { name: "Join with a code" })).toBeVisible();
  await expect.poll(async () => Math.round((await page.getByRole("dialog", { name: "Join with a code" }).boundingBox())?.width ?? 0)).toBe(560);
  await page.getByRole("textbox", { name: "Circle code" }).fill("ZXCVBNMASDFG");
  await page.getByRole("button", { name: "Look up" }).click();
  await page.getByRole("button", { name: "Join Family" }).click();
  await expect(page.getByText(/You'll join Family after setup/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Find contacts" }).click();
  await page.getByRole("button", { name: "Check my contacts" }).click();
  await expect(page.getByText("No eligible contacts matched.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open One Location" })).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => window.onboardingBack());
  await expect(page.getByRole("heading", { name: "Your place." })).toBeVisible();
  await page.evaluate(() => window.onboardingBack());
  await expect(page.getByText("Agents home")).toBeVisible();
});

for (const width of [320, 390, 1440]) {
  test(`keeps the places banner readable and dismissible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page, { banner: true });
    const banner = page.getByTestId("saved-places-banner");
    const dismiss = page.getByRole("button", { name: "Dismiss saved places reminder" });
    const box = (await dismiss.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Save a place" })).toBeVisible();
    expect(await banner.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    await dismiss.click();
    await expect(banner).toHaveCount(0);
  });
}

test("keeps actions reachable in a short landscape or zoomed viewport", async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await openFixture(page);
  await page.getByRole("button", { name: "Use my location" }).click();
  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(page.getByRole("heading", { name: "Your people." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open One Location" })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Find contacts" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Find contacts" }).click();
  await expect(page.getByRole("button", { name: "Check my contacts" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});
