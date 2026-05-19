import { test, expect } from "@playwright/test";

/**
 * RIA Onboarding Flow — E2E Smoke Tests
 *
 * These tests verify the RIA onboarding page loads and renders
 * the expected license-first flow structure. Because onboarding
 * requires authentication + backend services, these tests focus
 * on the public page structure and navigation.
 */

test.describe("RIA Onboarding", () => {
  test("onboarding page loads without crash", async ({ page }) => {
    const response = await page.goto("/ria/onboarding");
    expect(response?.status()).toBeLessThan(500);
  });

  test("shows sign-in prompt when unauthenticated", async ({ page }) => {
    await page.goto("/ria/onboarding");
    await expect(
      page.getByText(/sign in/i),
    ).toBeVisible({ timeout: 15_000 });
  });
});
