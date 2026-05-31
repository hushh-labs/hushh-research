import { expect, test } from "@playwright/test";

test.describe("Onboarding carousel", () => {
  test("slide indicators are keyboard-selectable buttons", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /get started/i }).click();

    const slideTwo = page.getByRole("button", { name: "Go to slide 2" });
    const slideThree = page.getByRole("button", { name: "Go to slide 3" });

    await expect(slideTwo).toBeVisible();

    await slideTwo.focus();
    await page.keyboard.press("Enter");
    await expect(slideTwo).toHaveAttribute("aria-current", "step");
    await expect(
      page.getByText(/Performance, allocation, and risk/i),
    ).toBeVisible();

    await slideThree.focus();
    await page.keyboard.press("Space");
    await expect(slideThree).toHaveAttribute("aria-current", "step");
    await expect(page.getByText(/structured analysis/i)).toBeVisible();
  });
});
