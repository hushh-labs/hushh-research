import { expect, test, type Page } from "@playwright/test";

const REQUIRED_VALUES = ["REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"] as const;

const ROUTES = {
  now: "/one/location",
  people: "/one/location?tab=people",
  links: "/one/location?tab=links",
} as const;

// "agent-hero" / "agent-title" used to be the shared `<PageHeader
// titleRole="agent">` ("Location Agent") rendered above the tab strip on
// every tab. The Now-hub redesign removed that header for good (not
// renamed) and replaced it with LocationStatusCard, which carries no
// data-ui-role -- so those two roles no longer exist on any of the three
// tabs and have been dropped from this list rather than asserted as
// permanently absent-but-equal.
const SHARED_ROLES = [
  "top-navigation",
  "agent-tab-bar",
  "talk-to-one",
  "bottom-tab-bar",
] as const;

const TEXT_STYLE_PROPERTIES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
] as const;

const BOX_STYLE_PROPERTIES = [
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginBottom",
  "borderRadius",
  "maxWidth",
  "backgroundColor",
] as const;

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

  await page.goto(ROUTES.now, { waitUntil: "domcontentloaded" });
  await page.getByTestId("one-location-status-card").waitFor({
    state: "visible",
    timeout: 90_000,
  });
}

async function computedStyleForRole(page: Page, role: string) {
  return page.locator(`[data-ui-role="${role}"]`).first().evaluate((node) => {
    const style = window.getComputedStyle(node);
    const result: Record<string, string> = {};
    for (const key of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "color",
      "height",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "marginTop",
      "marginBottom",
      "borderRadius",
      "maxWidth",
      "backgroundColor",
    ] as const) {
      result[key] = style[key];
    }
    return result;
  });
}

async function openLocationTab(page: Page, route: keyof typeof ROUTES) {
  await page.goto(ROUTES[route], { waitUntil: "domcontentloaded" });
  await page.getByTestId("one-location-status-card").waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

test.describe("Location Agent shared shell consistency", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs reviewer credentials AND a /login sign-in path for automation (E2E_REVIEWER_SIGNIN=1); the 'Continue as reviewer' control this spec clicks does not exist in this repository",
  );

  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

  test("Now, People, and Links resolve equivalent roles to identical computed styles", async ({
    page,
  }) => {
    await openReviewerLocation(page);

    const snapshots: Record<string, Record<string, Record<string, string>>> = {};

    for (const route of Object.keys(ROUTES) as Array<keyof typeof ROUTES>) {
      await openLocationTab(page, route);
      snapshots[route] = {};
      for (const role of SHARED_ROLES) {
        await expect(page.locator(`[data-ui-role="${role}"]`).first()).toBeVisible();
        snapshots[route][role] = await computedStyleForRole(page, role);
      }
      await expect(page.locator('[data-ui-role="section-title"]').first()).toBeVisible();
      snapshots[route]["section-title"] = await computedStyleForRole(
        page,
        "section-title",
      );
    }

    const baseline = snapshots.now;
    for (const route of ["people", "links"] as const) {
      for (const role of [...SHARED_ROLES, "section-title"] as const) {
        const properties =
          role === "top-navigation" ||
          role === "agent-tab-bar" ||
          role === "talk-to-one" ||
          role === "bottom-tab-bar"
            ? BOX_STYLE_PROPERTIES
            : TEXT_STYLE_PROPERTIES;
        for (const property of properties) {
          expect(
            snapshots[route][role][property],
            `${route} ${role} ${property}`,
          ).toBe(baseline[role][property]);
        }
      }
    }
  });
});
