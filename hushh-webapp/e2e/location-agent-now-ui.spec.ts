import { expect, test, type Locator, type Page } from "@playwright/test";

const REQUIRED_VALUES = ["REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"] as const;

/**
 * Credentials are only half of reviewer sign-in. The other half is a
 * "Continue as reviewer" control on /login, which this repository does not
 * have -- it appears in e2e specs and nowhere else. Gating on the secrets
 * alone made this file skip on a machine without them (looking like
 * coverage) and time out on a machine with them. E2E_REVIEWER_SIGNIN=1 is
 * the opt-in for once a sign-in path for automation actually exists.
 */
function hasReviewerAuthority() {
  if (!REQUIRED_VALUES.every((key) => Boolean(process.env[key]?.trim()))) {
    return false;
  }
  return process.env.E2E_REVIEWER_SIGNIN === "1";
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
  test.skip(
    !hasReviewerAuthority(),
    "needs reviewer credentials AND a /login sign-in path for automation (E2E_REVIEWER_SIGNIN=1); the 'Continue as reviewer' control this spec clicks does not exist in this repository",
  );

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

    await expectTypography(page.getByRole("heading", { name: "Actions" }), {
      fontSize: "15px",
      fontWeight: "500",
      lineHeight: "20px",
      color: "rgb(110, 110, 115)",
    });

    const rowLabels = page.locator(
      '[data-testid="one-location-now-activity"] [data-slot="settings-row-title"], [data-testid="one-location-now-more"] [data-slot="settings-row-title"]',
    );
    const rowCount = await rowLabels.count();
    expect(rowCount).toBe(5);
    for (let index = 0; index < rowCount; index += 1) {
      await expectTypography(rowLabels.nth(index), {
        fontSize: "17px",
        fontWeight: "400",
        lineHeight: "22px",
        color: "rgb(29, 29, 31)",
      });
    }

    const actionTitles = page.locator(
      '[data-testid="one-location-now-actions"] .ui-text-row-label',
    );
    await expectTypography(actionTitles.filter({ hasText: "Check-In" }), {
      fontSize: "15px",
      fontWeight: "500",
      lineHeight: "20px",
      color: "rgb(29, 29, 31)",
    });
    await expectTypography(actionTitles.filter({ hasText: "Send SOS" }), {
      fontSize: "15px",
      fontWeight: "500",
      lineHeight: "20px",
      color: "rgb(255, 59, 48)",
    });

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

/**
 * The header switch's responsive contract.
 *
 * QA reported the switch had no meaning on an iPhone. The cause was that its
 * status text carried `hidden … sm:inline`, and `sm` is 640px — so it rendered
 * in a desktop browser and on no phone at all. A jsdom test could not catch it
 * (jsdom does not apply media queries, so `getByText` still found the element),
 * and the fix was originally proven by a manual Playwright session that never
 * landed in the repo. This is that measurement, committed, so it can fail.
 *
 * Two invariants, at every supported width:
 *  1. The status is visible and has text — a switch never survives alone.
 *  2. "Location Agent" stays on one line. The full status string is wide
 *     enough to push a 28px title onto a second line at 320-390px, which is
 *     why the compact form exists; if someone drops the compact form this
 *     assertion is what notices.
 */
const HEADER_WIDTHS = [320, 360, 375, 390, 430, 639, 640, 768] as const;

test.describe("Location Agent header responsive contract", () => {
  test.skip(
    !hasReviewerAuthority(),
    "Requires REVIEWER_UID and REVIEWER_VAULT_PASSPHRASE.",
  );

  for (const width of HEADER_WIDTHS) {
    test(`keeps the location switch's meaning visible at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await openReviewerLocation(page);

      const status = page.getByTestId("one-location-header-status");
      await expect(status).toBeVisible();
      expect(((await status.innerText()) ?? "").trim().length).toBeGreaterThan(
        0,
      );

      // The status describes the switch, so it must also reach assistive tech.
      const statusId = await status.getAttribute("id");
      expect(statusId).toBeTruthy();
      await expect(
        page.locator(`[role="switch"][aria-describedby="${statusId}"]`),
      ).toHaveCount(1);

      // Below 640 the visible word is the compact form; at/above it is the
      // full string. Neither may be empty, and they must not swap over.
      const visibleText = (await status.innerText()).trim();
      if (width < 640) {
        expect(visibleText).not.toContain("Location ");
      } else {
        expect(visibleText).toContain("Location ");
      }

      // Product-owned title: one line, never clipped.
      const heading = page.getByRole("heading", { name: "Location Agent" });
      await expect(heading).toBeVisible();
      const box = await heading.evaluate((node) => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        lineHeight: parseFloat(getComputedStyle(node).lineHeight),
      }));
      expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
      // 320px is the one width where a second line is accepted (it wrapped
      // there before this work too); everywhere else it must stay single.
      if (width > 320) {
        expect(box.clientHeight).toBeLessThanOrEqual(
          Math.ceil(box.lineHeight * 1.5),
        );
      }

      // And the page itself must never scroll sideways.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    });
  }
});
