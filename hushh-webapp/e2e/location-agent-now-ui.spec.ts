import { expect, test, type Locator, type Page } from "@playwright/test";

const REQUIRED_VALUES = ["REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"] as const;

function hasReviewerAuthority() {
  return REQUIRED_VALUES.every((key) => Boolean(process.env[key]?.trim()));
}

async function openReviewerLocation(page: Page) {
  await page.goto(`/login?redirect=${encodeURIComponent("/one/location")}`, {
    waitUntil: "domcontentloaded",
  });

  const reviewerButton = page.getByRole("button", {
    name: /continue as reviewer/i,
  });
  await reviewerButton.waitFor({ state: "visible", timeout: 60_000 });
  await reviewerButton.click();

  const unlockInput = page.locator("#unlock-passphrase");
  await unlockInput
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});
  if (await unlockInput.isVisible().catch(() => false)) {
    await unlockInput.fill(process.env.REVIEWER_VAULT_PASSPHRASE ?? "");
    await page
      .getByRole("button", { name: /unlock with passphrase/i })
      .first()
      .click({ noWaitAfter: true });
  }

  await page.goto("/one/location", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Location Agent" }).waitFor({
    state: "visible",
    timeout: 90_000,
  });
}

async function expectTypography(
  locator: Locator,
  expected: {
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    color?: string;
  },
) {
  await expect(locator).toHaveCSS("font-size", expected.fontSize);
  await expect(locator).toHaveCSS("font-weight", expected.fontWeight);
  await expect(locator).toHaveCSS("line-height", expected.lineHeight);
  if (expected.color) {
    await expect(locator).toHaveCSS("color", expected.color);
  }
}

test.describe("Location Agent Now visual contract", () => {
  test.skip(!hasReviewerAuthority(), "reviewer UAT authority is required");

  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

  test("matches the strict Apple typography and background contract", async ({
    page,
  }) => {
    await openReviewerLocation(page);

    await expectTypography(
      page.getByRole("heading", { name: "Location Agent" }),
      {
        fontSize: "34px",
        fontWeight: "700",
        lineHeight: "41px",
        color: "rgb(29, 29, 31)",
      },
    );

    await expectTypography(page.getByRole("heading", { name: "Quick actions" }), {
      fontSize: "22px",
      fontWeight: "600",
      lineHeight: "27px",
      color: "rgb(29, 29, 31)",
    });

    const rowLabels = page.locator(
      '[data-testid^="one-location-now"] [data-slot="settings-row-title"]',
    );
    const rowCount = await rowLabels.count();
    expect(rowCount).toBeGreaterThanOrEqual(7);
    for (let index = 0; index < rowCount; index += 1) {
      await expectTypography(rowLabels.nth(index), {
        fontSize: "17px",
        fontWeight: "400",
        lineHeight: "22px",
        color: "rgb(29, 29, 31)",
      });
    }

    const cardTitles = page.locator(
      '[data-voice-control-id^="one-location-action-"] .ui-text-card-title',
    );
    await expectTypography(cardTitles.filter({ hasText: "Check-In" }), {
      fontSize: "17px",
      fontWeight: "600",
      lineHeight: "22px",
      color: "rgb(29, 29, 31)",
    });
    await expectTypography(cardTitles.filter({ hasText: "SMS" }), {
      fontSize: "17px",
      fontWeight: "600",
      lineHeight: "22px",
      color: "rgb(29, 29, 31)",
    });

    const cardDescriptions = page.locator(
      '[data-voice-control-id^="one-location-action-"] .ui-text-row-description',
    );
    const descriptionCount = await cardDescriptions.count();
    expect(descriptionCount).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < descriptionCount; index += 1) {
      await expectTypography(cardDescriptions.nth(index), {
        fontSize: "13px",
        fontWeight: "400",
        lineHeight: "18px",
        color: "rgb(142, 142, 147)",
      });
    }

    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(242, 242, 247)",
    );
    await expect(page.locator("body")).toHaveCSS("background-image", "none");
    await expect(page.locator(".foundation-public-ambient")).toHaveCSS(
      "background-image",
      "none",
    );
  });
});
