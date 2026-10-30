import { expect, test } from "@playwright/test";
import { buildOnboardingFixture, openFixture } from "./fixtures/render-location-onboarding";

test.beforeAll(buildOnboardingFixture);
for (const viewport of [
  { width: 320, height: 568 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 768, height: 1024 }, { width: 1440, height: 900 },
]) {
  test(`fits the actual people screen at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openFixture(page, { ready: true, dark: viewport.width === 430 });
    await expect(page.getByRole("heading", { name: "Your people." })).toBeVisible();
    const code = page.getByTestId("one-location-onboarding-invite-code");
    await expect(code).toHaveText("ABCD-EFGH-JKLM");
    expect(await code.evaluate(node => ({
      x: node.scrollWidth > node.clientWidth + 1,
      overflow: getComputedStyle(node).textOverflow,
      size: parseFloat(getComputedStyle(node).fontSize),
    }))).toMatchObject({ x: false, overflow: "clip" });
    for (const name of ["Copy", "Share", "Join with a code", "Find contacts", "Open One Location"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    expect(await page.getByTestId("one-location-onboarding-ready-surface").evaluate(node => ({
      x: node.scrollWidth > node.clientWidth + 1, y: node.scrollHeight > node.clientHeight + 1,
    }))).toEqual({ x: false, y: false });
    await page.screenshot({ path: testInfo.outputPath("your-people.png"), animations: "disabled" });
  });
}
