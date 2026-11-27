import { expect, test, type Locator } from "@playwright/test";
import { buildOnboardingFixture, openFixture } from "./fixtures/render-location-onboarding";

function readFrame(frame: Locator) {
  return frame.evaluate(node => ({
    width: node.offsetWidth,
    height: node.offsetHeight,
    cornerRadius: getComputedStyle(node).borderTopLeftRadius,
  }));
}

test.beforeAll(buildOnboardingFixture);
for (const viewport of [
  { width: 320, height: 568 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 640, height: 560 },
  { width: 768, height: 1024 }, { width: 1440, height: 900 },
]) {
  test(`matches the place frame and fits circle actions at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openFixture(page, { dark: viewport.width === 430 });
    const placeFrame = await readFrame(page.getByTestId("save-location-modal"));
    const placeScreen = page.getByTestId("one-location-onboarding-place-screen");
    const placeBackground = await placeScreen.evaluate(node => getComputedStyle(node).backgroundColor);
    await page.getByRole("button", { name: "Set up later" }).click();

    const heading = page.getByRole("heading", { name: "Find your circle", exact: true });
    await expect(heading).toBeVisible();
    expect(await heading.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects().length;
    })).toBe(1);
    await expect(page.getByText("Connect now. Share only when you choose.", { exact: true })).toHaveCount(0);

    const circleFrame = page.getByTestId("one-location-onboarding-ready-surface");
    expect(await readFrame(circleFrame)).toEqual(placeFrame);
    expect(await circleFrame.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(placeBackground);
    const bounds = (await circleFrame.boundingBox())!;
    expect(Math.abs(bounds.x + (bounds.width - viewport.width) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y + (bounds.height - viewport.height) / 2)).toBeLessThanOrEqual(1);

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
    expect(await circleFrame.evaluate(node => ({
      x: node.scrollWidth > node.clientWidth + 1, y: node.scrollHeight > node.clientHeight + 1,
    }))).toEqual({ x: false, y: false });
    await page.screenshot({ path: testInfo.outputPath("find-your-circle.png"), animations: "disabled" });
  });
}
