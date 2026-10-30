import { expect, test } from "@playwright/test";
import path from "node:path";
import { awaitProductFont } from "./product-font";
import { expectConsentTypography } from "./consent-typography";

type PresentationFixture = { script: () => string; fixtureHtml: () => string };

function registerQuestionCases({ script: getScript, fixtureHtml }: PresentationFixture) {
  for (const width of [320, 390, 1440]) {
    test(`Request scope is a date-free question dialog (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const submissions: Record<string, unknown>[] = [];
      await page.route("http://localhost/request-scope-fixture", (route) =>
        route.fulfill({ contentType: "text/html", body: fixtureHtml() }),
      );
      await page.route("**/api/one/answer-requests", (route) => {
        expect(route.request().headers().authorization).toBe("Bearer synthetic-firebase-proof");
        submissions.push(route.request().postDataJSON());
        return route.fulfill({ contentType: "application/json",
          body: '{"requestId":"55555555-5555-4555-8555-555555555555"}' });
      });
      await page.goto("http://localhost/request-scope-fixture");
      await page.addScriptTag({ content: getScript() });
      await awaitProductFont(page);
      await page.getByRole("button", { name: "Request scope", exact: true }).click();
      const dialog = page.locator('[data-request-dialog="question"]');
      const question = dialog.getByLabel("Your question");
      await expect(dialog).toHaveAccessibleName("Ask a question");
      await expect(question).toBeVisible();
      await expect(question).toHaveAttribute("placeholder", "What is the best way to contact you?");
      await expect(dialog.getByText("To Asha", { exact: true })).toBeVisible();
      await expect(dialog.locator('input[type="date"], input[type="checkbox"]')).toHaveCount(0);
      await expect(dialog.getByText(/Period|Start date|End date|Request files|Drive/)).toHaveCount(0);
      const send = dialog.getByRole("button", { name: "Send request", exact: true });
      // Illustrated forms use TaskSurfaceFooter, which has data-task-region
      // rather than the Radix data-slot. Both footer owners must keep task type.
      await expectConsentTypography(send, "13px", "20px", "600");
      await expectConsentTypography(dialog.getByRole("button", { name: "Cancel", exact: true }), "13px", "20px", "600");
      await expect(send).toBeDisabled();
      const value = "What did you spend on travel from January through March 2026?";
      await question.fill(value);
      await expect(send).toBeEnabled();
      await dialog.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
      });
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      for (const control of [question, send, dialog.getByRole("button", { name: "Cancel" })]) {
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await question.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Plus Jakarta Sans");
      if (process.env.REQUEST_SCOPE_SCREENSHOT_DIR) {
        await dialog.screenshot({ path: path.join(process.env.REQUEST_SCOPE_SCREENSHOT_DIR, `request-scope-${width}.png`) });
      }
      await send.click();
      await expect(dialog).toHaveAccessibleName("Question sent");
      await expect(dialog.getByText(/Request sent/)).toBeVisible();
      expect(submissions).toEqual([{
        personRef: "33333333-3333-4333-8333-333333333333",
        question: value,
        clientRequestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      }]);
      await expect(dialog.getByRole("link", { name: "View request" })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}

function registerPriceCases({ script: getScript, fixtureHtml }: PresentationFixture) {
  for (const width of [350, 620, 621, 768]) {
    test(`Profile default request price remains editable without phone focus zoom (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.route("http://localhost/default-price-fixture", route => route.fulfill({ contentType: "text/html", body: fixtureHtml() }));
      await page.goto("http://localhost/default-price-fixture");
      await page.addScriptTag({ content: getScript() });
      await awaitProductFont(page);
      await page.getByRole("button", { name: "Review default request price" }).click();
      const pricing = page.getByRole("region", { name: "Request pricing" });
      const input = pricing.getByLabel("Default price (USD)");
      await expectConsentTypography(input, width <= 620 ? "16px" : "14px", "22px", "400");
      await input.fill("12.50");
      // A layout/resize cannot reset the existing draft or save a price.
      const element = await input.elementHandle();
      await page.setViewportSize({ width: width <= 620 ? 768 : 390, height: 700 });
      await expect(input).toHaveValue("12.50");
      expect(await input.evaluate((node, previous) => node === previous, element)).toBe(true);
      await expect(pricing.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      expect(await pricing.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    });
  }
}

function registerCostCases({ script: getScript, fixtureHtml }: PresentationFixture) {
  for (const width of [320, 430, 768]) {
    test(`cost disclosure and long preparation action stay readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 480 });
      await page.route("http://localhost/cost-review-fixture", route => route.fulfill({ contentType: "text/html", body: fixtureHtml() }));
      await page.goto("http://localhost/cost-review-fixture");
      await page.addScriptTag({ content: getScript() });
      await awaitProductFont(page);
      await page.getByRole("button", { name: "Review processing costs" }).click();
      const review = page.getByRole("region", { name: "Processing cost review" });
      const prepare = review.getByRole("button", { name: "Prepare encrypted information" });
      const acknowledgement = review.getByRole("checkbox");
      await expect(acknowledgement).not.toBeChecked();
      await expect(prepare).toBeDisabled();
      await expectConsentTypography(review.locator('label'), "14px", "20px", "400");
      await expectConsentTypography(prepare, "17px", "22px", "650");
      await expect(review.getByText(/possible debt/)).toBeVisible();
      await expect(review.locator("dd").last()).toContainText("-");
      await acknowledgement.check();
      await prepare.click();
      await expect(page.locator("body")).toHaveAttribute("data-cost-acknowledgement", "synthetic-cost-binding");
      const bounds = (await prepare.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await review.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    });
  }
}

/** Register the composed-host cases in the existing production fixture pack. */
export function registerConsentPresentationCases(fixture: PresentationFixture) {
  registerQuestionCases(fixture);
  registerPriceCases(fixture);
  registerCostCases(fixture);
}
