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
    const badge = profile.getByRole("button", { name: "Verified Advisor" });
    await badge.click();
    const explanation = page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Verified Advisor" });
    await expect(explanation).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(explanation).toBeHidden();
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
    await expect(profile.getByRole("heading", { name: "Maya Singh" })).toBeVisible();
    await expect(profile.getByRole("heading", { name: "Aarav Sharma" })).toHaveCount(0);
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

for (const width of [320, 393, 768, 1440]) {
  test(`network journey retraces mutuals of mutuals, shared lists and degrees at ${width}px @feature_mutual_connections @loop_smoke`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://localhost:41839/**", route => route.fulfill({ contentType: "text/html", body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
    await page.goto("http://localhost:41839/one/location?action=share&step=people");
    await page.addScriptTag({ content: fixture.previewScript! });
    const source = page.getByRole("dialog", { name: "Add people to circle", exact: true });
    await source.getByRole("textbox", { name: "Search connections" }).fill("Aar");
    await source.getByRole("button", { name: "Select Aarav for circle" }).click();
    await source.getByRole("button", { name: "View Aarav Sharma's profile" }).click();
    const preview = page.locator("[data-person-profile-preview]");
    const back = () => preview.getByRole("button", { name: "Back to previous screen" }).click();
    await preview.getByRole("button", { name: "2 mutual connections", exact: true }).click();
    await preview.getByRole("button", { name: "Open Maya Singh's profile" }).click();
    await expect(preview.getByRole("heading", { name: "Maya Singh", exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "Request information" }).click();
    await page.evaluate(() => history.back());
    await expect(page.getByRole("dialog", { name: "Review information request", exact: true })).toHaveCount(0);
    await expect(preview.getByRole("heading", { name: "Maya Singh", exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "2 mutual connections", exact: true }).click();
    await preview.getByRole("button", { name: "Open Aarav Sharma's profile" }).click();
    await expect(preview.getByRole("heading", { name: "Aarav Sharma", exact: true })).toBeVisible();
    const count = preview.getByRole("button", { name: "3 connections", exact: true });
    await expect(count).toBeVisible();
    const [contactBounds, countBounds] = await Promise.all([
      preview.getByRole("link", { name: "profile@example.com" }).boundingBox(), count.boundingBox(),
    ]);
    expect(countBounds!.y).toBeGreaterThanOrEqual(contactBounds!.y + contactBounds!.height);
    expect(countBounds!.x).toBeCloseTo(contactBounds!.x, 0);
    expect(countBounds!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`profile-connection-count-${width}.png`) });
    await count.click();
    const connected = preview.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Open Maya Singh's profile" }) });
    await expect(connected.getByText("Connected", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`profile-connections-${width}.png`) });
    await preview.getByRole("textbox", { name: "Search network by name" }).fill("Second");
    const connect = preview.getByRole("button", { name: "Connect with Second Degree Person" });
    await expect(connect).toBeVisible();
    await expect.poll(async () => {
      const [connectBounds, profileBounds] = await Promise.all([
        connect.boundingBox(),
        preview.getByRole("button", { name: "Open Second Degree Person's profile" }).boundingBox(),
      ]);
      return connectBounds && profileBounds
        ? profileBounds.x + profileBounds.width - connectBounds.x
        : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(0);
    expect(await connect.evaluate(button => {
      const row = button.closest("li")!;
      return row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight) - button.getBoundingClientRect().right;
    })).toBeCloseTo(0, 0);
    await expect(preview.getByTestId("mutual-avatar-stack")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`network-connect-action-${width}.png`) });
    await connect.click();
    await expect(preview.getByText("Request sent", { exact: true })).toBeVisible();
    await expect(preview.getByRole("heading", { name: "Second Degree Person", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`network-connect-row-${width}.png`) });
    await preview.getByRole("button", { name: "Open Second Degree Person's profile" }).click();
    await expect(preview.getByText("2nd connection", { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "1 mutual connection", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Maya Singh", exact: true })).toBeVisible();
    await page.evaluate(() => history.back());
    await expect(preview.getByRole("heading", { name: "Second Degree Person", exact: true })).toBeVisible();
    await back();
    await expect(preview.getByRole("textbox", { name: "Search network by name" })).toHaveValue("Second");
    await expect(preview.getByRole("button", { name: "Open Second Degree Person's profile" })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`network-shared-list-${width}.png`) });
    await back(); // Aarav's revisited profile
    await expect(preview.getByRole("heading", { name: "Aarav Sharma", exact: true })).toBeVisible();
    await expect(count).toBeFocused();
    await back(); // Maya's mutual list
    await expect(preview.getByRole("button", { name: "Open Aarav Sharma's profile" })).toBeVisible();
    await back(); // Maya
    await expect(preview.getByRole("heading", { name: "Maya Singh", exact: true })).toBeVisible();
    await back(); // Aarav's mutual list
    await expect(preview.getByRole("button", { name: "Open Maya Singh's profile" })).toBeVisible();
    await back(); // Aarav
    await expect(preview.getByRole("heading", { name: "Aarav Sharma", exact: true })).toBeVisible();
    await back(); // original picker
    await expect(preview).toHaveCount(0);
    await expect(source.getByRole("textbox", { name: "Search connections" })).toHaveValue("Aar");
    await expect(source.getByRole("button", { name: "Select Aarav for circle" })).toHaveAttribute("aria-pressed", "true");
    await expect(source.getByRole("button", { name: "View Aarav Sharma's profile" })).toBeFocused();
    await page.evaluate(() => history.forward());
    await expect(preview.getByRole("heading", { name: "Aarav Sharma", exact: true })).toBeVisible();
    await back();
    await source.getByRole("button", { name: "Explore your network", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Your network", exact: true })).toBeVisible();
    await expect(preview.getByRole("button", { name: "Open Aarav Sharma's profile" })).toBeVisible();
    await expect(preview.getByTestId("mutual-avatar-stack")).toHaveCount(4);
    await expect(preview).toHaveCSS("opacity", "1");
    const filters = preview.getByRole("group", { name: "Connection degree filters" });
    expect(await filters.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await preview.locator("[data-network-scroll-owner]").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const stackWidths = await preview.getByTestId("mutual-avatar-stack").evaluateAll(stacks =>
      stacks.map(stack => stack.getBoundingClientRect().width),
    );
    expect(Math.max(...stackWidths) - Math.min(...stackWidths)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`network-discovery-${width}.png`) });
    await preview.getByRole("button", { name: "Extended network", exact: true }).click();
    await preview.getByRole("button", { name: "Open Third Degree Person's profile" }).click();
    await expect(preview.getByText("3rd connection", { exact: true })).toBeVisible();
    await expect(preview.getByRole("button", { name: /mutual connection/ })).toHaveCount(0);
    await expect(preview.locator('[data-voice-control-id="person-network-connections"]')).toHaveCount(0);
    await back();
    await expect(preview.getByRole("button", { name: "Extended network", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(preview.getByRole("button", { name: "Open Third Degree Person's profile" })).toBeFocused();
    await back();
    await expect(preview).toHaveCount(0);
    await expect(source.getByRole("button", { name: "Explore your network", exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  });
}
