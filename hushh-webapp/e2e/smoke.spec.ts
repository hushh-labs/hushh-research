import { test, expect } from "@playwright/test";

/**
 * Smoke Tests
 * ===========
 *
 * Minimal end-to-end tests that verify the application boots correctly
 * and critical pages render without errors.
 *
 * These tests run against the unauthenticated (public) surfaces of Kai
 * and should pass without any backend services running.
 */

test.describe("Application Boot", () => {
  test("landing page loads without crash", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBeLessThan(500);
  });

  test("landing page renders onboarding content", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: /Meet Kai,\s*Your Personal Financial Advisor/i,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /Get Started/i }),
    ).toBeVisible();
  });

  test("no console errors on landing page", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });
    await page.goto("/");
    await page.waitForTimeout(2000);
    // Filter out known non-critical errors (e.g., Firebase init without config)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("Firebase") &&
        !e.includes("analytics") &&
        !e.includes("__NEXT"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe("Login Page", () => {
  test("login page loads", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBeLessThan(500);
  });

  test("login page renders auth step", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /Sign in to Kai/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /Continue with Google/i }),
    ).toBeVisible();
  });

  test("login page supports redirect parameter", async ({ page }) => {
    await page.goto("/login?redirect=/portfolio");
    // Page should load without errors even with redirect param
    await expect(
      page.getByRole("heading", { name: /Sign in to Kai/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("404 Handling", () => {
  test("unknown route renders not-found page", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist-12345");
    // Next.js returns 200 for client-side not-found pages, or 404
    expect(response?.status()).toBeLessThan(500);
  });
});
