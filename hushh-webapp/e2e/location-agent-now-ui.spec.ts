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
  await page.getByTestId("one-location-status-card").waitFor({
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

    // The old "Location Agent" page title (a 34px/700 <h1>, agent-hero /
    // agent-title roles) was removed for good by the Now-hub redesign, not
    // renamed -- LocationStatusCard replaced it with a compact status row,
    // and the top app bar's own breadcrumb title is a div, not a heading. The
    // page carries no role="heading" title element anymore, so there is no
    // equivalent locator to assert this contract against.

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
 * One invariant, at every supported width: the status is visible and has
 * text, and reads the same full string ("Location is on/off/paused/blocked/
 * limited", "Finding you…") everywhere — the compact one-word form this test
 * used to gate on was removed once the status moved out of the title row and
 * into its own group with the switch (#5404), where its width no longer
 * competes with the title.
 *
 * A second invariant used to live here: "Location Agent" stays on one line
 * at every width above 320px. That heading was removed for good by the
 * Now-hub redesign (LocationStatusCard replaced the old page title, and the
 * top app bar's breadcrumb title is a div, not a heading), so the page no
 * longer has a role="heading" title element to measure.
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

      // Same full string at every width — no compact/abbreviated form. The
      // status wrapper now also holds a second supporting line (added by the
      // LocationStatusCard redesign), so the headline has to be read off its
      // own paragraph rather than the wrapper's innerText -- two stacked <p>
      // elements render on separate lines, which would otherwise put a line
      // break before the end of the anchored string below.
      const headline = status.locator("p").first();
      const visibleText = (await headline.innerText()).trim();
      expect(visibleText).toMatch(
        /^(Location is (on|off|paused|blocked|limited)|Finding you…)$/,
      );

      // The former "Location Agent" page title no longer exists (removed by
      // the Now-hub redesign, not renamed), so the one-line/never-clipped
      // measurement that used to run against it has no target anymore.

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
