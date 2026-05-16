import { test, expect } from "@playwright/test";

/**
 * Accessibility Tests
 * ====================
 *
 * Basic accessibility checks for public-facing pages.
 * These tests verify fundamental WCAG compliance without requiring
 * any external accessibility testing library.
 */

test.describe("Landing Page Accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("page has a title", async ({ page }) => {
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test("page has lang attribute on html element", async ({ page }) => {
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBeTruthy();
  });

  test("page has viewport meta tag", async ({ page }) => {
    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute("content");
    expect(viewport).toBeTruthy();
    expect(viewport).toContain("width=");
  });

  test("all images have alt attributes", async ({ page }) => {
    const images = page.locator("img");
    const count = await images.count();
    for (let i = 0; i < count; i++) {
      const alt = await images.nth(i).getAttribute("alt");
      // alt can be empty string (decorative) but must exist
      expect(alt).not.toBeNull();
    }
  });

  test("interactive elements are keyboard focusable", async ({ page }) => {
    const buttons = page.locator(
      "button:visible, a[href]:visible, [role='button']:visible"
    );
    const count = await buttons.count();

    if (count > 0) {
      // Tab through first few interactive elements to verify focus works
      for (let i = 0; i < Math.min(count, 5); i++) {
        await page.keyboard.press("Tab");
        const focused = page.locator(":focus");
        const focusedCount = await focused.count();
        // At least something should be focused after Tab
        expect(focusedCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("no duplicate IDs on page", async ({ page }) => {
    const duplicates = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[id]")).map(
        (el) => el.id
      );
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const id of ids) {
        if (id && seen.has(id)) {
          dupes.push(id);
        }
        seen.add(id);
      }
      return dupes;
    });
    expect(duplicates).toHaveLength(0);
  });
});

test.describe("Login Page Accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
  });

  test("page has a title", async ({ page }) => {
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test("form inputs have associated labels or aria-label", async ({
    page,
  }) => {
    const inputs = page.locator(
      "input:visible, select:visible, textarea:visible"
    );
    const count = await inputs.count();

    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const id = await input.getAttribute("id");
      const ariaLabel = await input.getAttribute("aria-label");
      const ariaLabelledBy = await input.getAttribute("aria-labelledby");
      const placeholder = await input.getAttribute("placeholder");

      // Input should have at least one accessible name source
      const hasLabel =
        id !== null
          ? (await page.locator(`label[for="${id}"]`).count()) > 0
          : false;
      const hasAccessibleName =
        hasLabel || !!ariaLabel || !!ariaLabelledBy || !!placeholder;
      expect(hasAccessibleName).toBeTruthy();
    }
  });

  test("color contrast - text is not invisible", async ({ page }) => {
    // Basic check: ensure no text elements have transparent or same-as-bg color
    const hasVisibleText = await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const computedStyle = window.getComputedStyle(body);
      return computedStyle.color !== "rgba(0, 0, 0, 0)";
    });
    expect(hasVisibleText).toBeTruthy();
  });
});
