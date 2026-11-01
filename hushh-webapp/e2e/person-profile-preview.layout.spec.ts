import { expect, test } from "@playwright/test";
import { buildPersonProfileBrowserFixture, type PersonProfileBrowserFixture } from "./fixtures/person-profile-browser";
let fixture: PersonProfileBrowserFixture;
let css: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await buildPersonProfileBrowserFixture({ includePresentation: false, includeRequests: false, includePreview: true });
  css = fixture.css;
});
test.afterAll(() => fixture?.dispose());
for (const width of [393, 1280]) {
  test(`connected avatar preserves the source sheet, choices and search at ${width}px @feature_connected_profiles @loop_smoke`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("Preview fixture:", error.message); });
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://localhost:41839/**", route => route.fulfill({ contentType: "text/html", body: `<html><head><title>Connected profile return verification</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
    await page.goto("http://localhost:41839/one/location?action=share&step=people");
    await page.addScriptTag({ content: fixture.previewScript! });
    const source = page.getByRole("dialog", { name: "Add people to circle", exact: true });
    await expect(source).toBeVisible();
    await source.getByRole("textbox", { name: "Search connections" }).fill("Aar");
    await source.getByRole("button", { name: "Select Aarav for circle" }).click();
    const before = await source.boundingBox();
    await source.getByRole("button", { name: "View Aarav Sharma's profile" }).click();
    const profile = page.locator("[data-person-profile-preview]");
    await expect(profile.getByRole("heading", { name: "Aarav Sharma" })).toBeVisible();
    await expect(page.locator("button button, a button")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath("connected-profile-open.png") });
    await profile.getByRole("button", { name: "Back to previous screen" }).evaluate(element => {
      // Both taps arrive before the asynchronous history pop completes.
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(profile).toHaveCount(0);
    await expect(source).toBeVisible();
    await expect(page).toHaveURL("http://localhost:41839/one/location?action=share&step=people");
    await expect(source.getByRole("textbox", { name: "Search connections" })).toHaveValue("Aar");
    await expect(source.getByRole("button", { name: "Select Aarav for circle" })).toHaveAttribute("aria-pressed", "true");
    expect(await source.boundingBox()).toEqual(before);
    await expect(source.getByRole("button", { name: "View Aarav Sharma's profile" })).toBeFocused();
    await source.getByRole("button", { name: "View Maya Singh's profile" }).click();
    await expect(profile).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(profile).toHaveCount(0);
    await expect(source).toBeVisible();
    await source.getByRole("button", { name: "View Aarav Sharma's profile" }).click();
    await profile.getByRole("button", { name: "Request information" }).click();
    await expect(page.getByRole("dialog", { name: "Review information request", exact: true })).toBeVisible();
    // Back may be consumed by the dialog without a navigation/load event.
    await page.evaluate(() => history.back());
    await expect(page.getByRole("dialog", { name: "Review information request", exact: true })).toHaveCount(0);
    await expect(profile).toBeVisible();
    await page.evaluate(() => history.back());
    await expect(profile).toHaveCount(0);
    await expect(source).toBeVisible();
    await expect(source.getByRole("textbox", { name: "Search connections" })).toHaveValue("Aar");
    await expect(source.getByRole("button", { name: "Select Aarav for circle" })).toHaveAttribute("aria-pressed", "true");
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("connected-profile-return.png") });
  });
}
