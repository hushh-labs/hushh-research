import { expect, test, type Page } from "@playwright/test";

export function registerAdvisorReviewChecks(
  mount: (page: Page, width: number) => Promise<void>,
) {
  test("Finance advisor discovery separates connections, nearby and global search", async ({
    page,
  }) => {
    await mount(page, 393);
    await page
      .getByRole("button", { name: "Start sample advisor request" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Sample advisor", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute(
      "data-advisor-candidate-scope",
      "connections",
    );
    await dialog.getByRole("tab", { name: "Nearby" }).click();
    await dialog.getByRole("textbox", { name: "Postal code" }).fill("10001");
    await dialog.getByRole("button", { name: "Search nearby" }).click();
    await expect(
      dialog.getByText("Local advisor", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("textbox", { name: "Advisor name" }).fill("Distant");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByText("Distant advisor", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute(
      "data-advisor-candidate-scope",
      "global",
    );
    await expect(
      dialog.getByRole("textbox", { name: "Postal code" }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Choose", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Send request" }),
    ).toBeDisabled();
  });

  for (const width of [393, 960]) {
    test(`Finance portfolio review caches and refreshes with advisor fallback at ${width}px`, async ({
      page,
    }, info) => {
      await mount(page, width);
      const toggle = page.getByRole("button", {
        name: "Toggle sample analysis",
      });
      await toggle.click();
      const review = page.getByRole("region", {
        name: "Agent One portfolio review",
      });
      await expect(page.locator("body")).not.toHaveAttribute(
        "data-portfolio-review-calls",
      );
      await review.getByRole("button", { name: "Enable auto-review" }).click();
      await expect(review.getByText("72", { exact: false })).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Portfolio charts" })
          .getByRole("heading", { name: "Largest holdings" }),
      ).toBeVisible();
      await review.screenshot({
        path: info.outputPath("portfolio-review.png"),
      });
      await toggle.click();
      await toggle.click();
      await expect(review.getByText("72", { exact: false })).toBeVisible();
      await expect(page.locator("body")).toHaveAttribute(
        "data-portfolio-review-calls",
        "1",
      );
      await page.evaluate(() => {
        document.body.dataset.portfolioReviewFailed = "true";
      });
      await page
        .getByRole("button", { name: "Update sample portfolio" })
        .click();
      await expect(
        review.getByText("Agent One couldn’t finish this review."),
      ).toBeVisible();
      await expect(page.locator("body")).toHaveAttribute(
        "data-portfolio-review-calls",
        "2",
      );
      await expect(review.getByText("72", { exact: false })).toHaveCount(0);
      await review.getByRole("button", { name: "Talk to an advisor" }).click();
      await expect(
        page.getByRole("dialog").getByText("Sample advisor", { exact: true }),
      ).toBeVisible();
    });
  }

  for (const width of [393, 1440])
    for (const theme of ["light", "dark"]) {
      test(`Finance advisor request locks snapshot until acceptance at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await mount(page, width);
        await page.evaluate(
          (theme) =>
            document.documentElement.classList.toggle("dark", theme === "dark"),
          theme,
        );
        await page
          .getByRole("button", {
            name: "Open sample advisor request",
            exact: true,
          })
          .click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toHaveCount(1);
        await expect(dialog.getByText(/snapshot is sealed/i)).toBeVisible();
        await expect(
          dialog.getByRole("heading", { name: "Finance snapshot" }),
        ).toHaveCount(0);
        expect(
          await page.evaluate(() => document.body.dataset.advisorDecrypts),
        ).toBeUndefined();
        await dialog.getByRole("button", { name: "Accept & connect" }).click();
        await expect(
          dialog.getByRole("heading", { name: "Finance snapshot" }),
        ).toBeVisible();
        expect(
          await dialog
            .getByRole("heading", { name: "Finance snapshot" })
            .evaluate((el) => getComputedStyle(el).fontSize),
        ).toBe("14px");
        await expect(
          dialog.getByRole("link", { name: "Connect or manage Calendar" }),
        ).toHaveAttribute("href", "/one/calendar");
        await expect(
          dialog.getByRole("link", { name: "Finish Stripe setup" }),
        ).toHaveAttribute("href", "/one/profile/payouts");
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await dialog.screenshot({
          path: info.outputPath(`advisor-workspace-${width}-${theme}.png`),
        });
      });
      test(`Finance advisor request reuses an uncertain send and Calendar recovery at ${width}px ${theme}`, async ({
        page,
      }) => {
        await mount(page, width);
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.body.dataset.advisorAck = "uncertain";
        }, theme);
        await page
          .getByRole("button", { name: "Start sample advisor request" })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog
          .getByRole("button", { name: "Choose", exact: true })
          .click();
        await expect(
          dialog.getByRole("heading", { name: "Finance snapshot" }),
        ).toBeVisible();
        const send = dialog.getByRole("button", {
          name: "Send request",
          exact: true,
        });
        await expect(send).toBeDisabled();
        await dialog.getByRole("checkbox").check();
        await send.click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await dialog
          .getByRole("button", { name: "Retry same request" })
          .click();
        await expect(
          dialog.getByRole("button", { name: "Withdraw request" }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => ({
            prepare: document.body.dataset.advisorPrepares,
            sends: document.body.dataset.advisorSends,
          })),
        ).toEqual({ prepare: "1", sends: "2" });
        await dialog
          .getByRole("button", { name: /^Close(?: detail panel)?$/ })
          .click();
        await page
          .getByRole("button", { name: "Open sample agreed meeting" })
          .click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Review Calendar booking" })
          .click();
        await expect(page.getByRole("alert")).toContainText(
          "Connect Google Calendar",
        );
        await expect(
          page.getByRole("button", { name: "Confirm meeting" }),
        ).toHaveCount(0);
      });
    }
}
