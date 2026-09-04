import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Asking for more of a live share, in a real browser.
 *
 * The component tests prove the logic; these prove the thing a person actually
 * touches -- against the deployed bundle when BASE_URL points at UAT.
 *
 * WHAT THIS USED TO COVER. An inline "New duration" editor: a `Select` of
 * ABSOLUTE lengths, preselected to whatever the share had left, whose Save
 * shortened the share when you picked under that and asked its owner for more
 * when you picked over it. Reported, and correctly:
 *
 *   "4 hours ke liye approval maine le liya toh neeche ke time duration edit
 *    mein aana illogical ... agar deni hain toh user can ask for more time"
 *
 * One field performing two opposite operations, with nothing saying which side
 * of the line you were on -- and the value that went out was already additive,
 * because the request carries `extendsGrantId`. It is replaced by the control
 * the People tab already used: four amounts, every one of them "more". Ending
 * a share early is the row's own Remove, which is unambiguous.
 *
 * So the claims here are what the new lane promises: exactly one request goes
 * out, it names the grant it lengthens, and no shorten is ever spent.
 *
 * The live grant is supplied by intercepting the workspace state, so this
 * needs one reviewer account rather than two real people mid-share.
 */

const REQUIRED_VALUES = ["REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"] as const;

/**
 * Reviewer sign-in needs two things, and only one of them is a secret.
 *
 * The other is a "Continue as reviewer" control on /login, which this
 * repository does not have -- `grep -r "Continue as reviewer"` finds it in
 * e2e specs and nowhere else. The two existing Location browser specs gate
 * on the credentials alone, so on a machine without them they skip and look
 * like coverage, and on a machine WITH them they spend three sixty-second
 * timeouts waiting for a button that was never built.
 *
 * So this gate names the real precondition. Set E2E_REVIEWER_SIGNIN=1 once a
 * sign-in path for automation actually exists; until then these skip for a
 * reason somebody can act on, and are ready the moment it lands.
 */
function hasReviewerAuthority() {
  if (!REQUIRED_VALUES.every((key) => Boolean(process.env[key]?.trim()))) {
    return false;
  }
  return process.env.E2E_REVIEWER_SIGNIN === "1";
}

/** ISO expiry `minutes` from now, so "what is left" is a real question. */
function expiresInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const OWNER_USER_ID = "e2e_owner_duration";
const GRANT_ID = "e2e_grant_duration";
const OWNER_NAME = "Duration Fixture";

function liveGrant(minutes: number) {
  return {
    id: GRANT_ID,
    ownerUserId: OWNER_USER_ID,
    recipientUserId: process.env.REVIEWER_UID ?? "reviewer",
    ownerDisplayName: OWNER_NAME,
    recipientKeyId: "e2e_key",
    status: "active",
    consentScope: "cap.location.live.view",
    capabilityScopes: ["cap.location.live.view"],
    durationHours: minutes / 60,
    expiresAt: expiresInMinutes(minutes),
  };
}

/**
 * Give the workspace state one live received share, leaving every other
 * projection exactly as the backend sent it. Rewriting the whole payload
 * would test a fixture rather than the screen.
 */
async function stubLiveGrant(page: Page, minutes: number) {
  await page.route("**/api/one/location/state", async (route: Route) => {
    const response = await route.fetch();
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return route.fulfill({ response });
    }
    const grant = liveGrant(minutes);
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    return route.fulfill({
      response,
      json: {
        ...body,
        receivedGrants: [grant],
        recipients: [
          ...recipients.filter(
            (r) => (r as { userId?: string })?.userId !== OWNER_USER_ID,
          ),
          {
            userId: OWNER_USER_ID,
            displayName: OWNER_NAME,
            keyId: "e2e_key",
            phoneVerified: true,
          },
        ],
      },
    });
  });
}

/** Every call the editor could make, recorded in order. */
function recordDurationCalls(page: Page) {
  const calls: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/\/api\/one\/location\/grants\/[^/]+\/shorten/.test(url)) {
      calls.push(`shorten ${request.method()}`);
    } else if (/\/api\/one\/location\/requests$/.test(url) && request.method() === "POST") {
      calls.push("request POST");
    }
  });
  return calls;
}

async function signInAsReviewer(page: Page) {
  await page.goto(`/login?redirect=${encodeURIComponent("/one/location")}`, {
    waitUntil: "domcontentloaded",
  });
  const reviewerButton = page.getByRole("button", {
    name: /continue as reviewer/i,
  });
  await reviewerButton.waitFor({ state: "visible", timeout: 60_000 });
  await reviewerButton.click();

  const unlockInput = page.locator("#unlock-passphrase");
  await unlockInput.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await unlockInput.isVisible().catch(() => false)) {
    await unlockInput.fill(process.env.REVIEWER_VAULT_PASSPHRASE ?? "");
    await page
      .getByRole("button", { name: /unlock with passphrase/i })
      .first()
      .click({ noWaitAfter: true });
  }
}

/** Land on Request location, with the fixture's row expanded. */
async function openMoreTimePanel(page: Page) {
  await page.goto("/one/location?action=ask", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Request location" })
    .waitFor({ state: "visible", timeout: 90_000 });
  const edit = page.getByRole("button", {
    name: `Edit access for ${OWNER_NAME}`,
  });
  await edit.waitFor({ state: "visible", timeout: 30_000 });
  await edit.click();
  await page
    .getByTestId("one-location-more-time-options")
    .waitFor({ state: "visible", timeout: 15_000 });
}

/** The button for one amount, addressed the way a screen reader hears it. */
function moreTimeButton(page: Page, label: string) {
  return page.getByRole("button", {
    name: `Ask ${OWNER_NAME} for ${label}`,
  });
}

test.describe("One Location ask-for-more-time panel", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs reviewer credentials AND a /login sign-in path for automation (E2E_REVIEWER_SIGNIN=1); the 'Continue as reviewer' control these specs click does not exist in this repository",
  );
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });
  test.setTimeout(180_000);

  test("offers additive amounts, never an absolute new length", async ({ page }) => {
    // The screen the report was about. Four amounts, ascending, every label
    // saying "more" -- and no Save, because there is nothing to confirm: the
    // amount IS the action.
    await stubLiveGrant(page, 4 * 60);
    await signInAsReviewer(page);
    await openMoreTimePanel(page);

    await expect(
      page.getByRole("combobox", { name: "New duration" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

    await expect(
      page.getByTestId("one-location-more-time-options").getByRole("button"),
    ).toHaveText(["15 min more", "30 min more", "1 hour more", "2 hours more"]);
    await expect(page.getByText("They\u2019ll need to approve.")).toBeVisible();
  });

  test("one request goes out, and no shorten is ever spent", async ({ page }) => {
    // The old editor's cheapest path still cost two round trips: a doomed
    // shorten, its 422, and then the request the person was always going to
    // need. There is one call now, whatever the share has left.
    const calls = recordDurationCalls(page);
    await stubLiveGrant(page, 2 * 60);
    await signInAsReviewer(page);
    await openMoreTimePanel(page);

    await moreTimeButton(page, "1 hour more").click();

    await expect.poll(() => calls, { timeout: 20_000 }).toEqual(["request POST"]);
  });

  test("the smallest amount is a top-up, not a cut", async ({ page }) => {
    // "15 min" on the old absolute picker SHORTENED a four-hour share to
    // fifteen minutes. The same words now add fifteen minutes to it, which is
    // what somebody minutes from expiry is reaching for.
    const calls = recordDurationCalls(page);
    await stubLiveGrant(page, 4 * 60);
    await signInAsReviewer(page);
    await openMoreTimePanel(page);

    await moreTimeButton(page, "15 min more").click();

    await expect.poll(() => calls, { timeout: 20_000 }).toContain("request POST");
    expect(calls.filter((call) => call.startsWith("shorten"))).toEqual([]);
  });

  test("the row stays usable, and Remove is never the ask's to disable", async ({
    page,
  }) => {
    // The retired editor's save flag was the revoke flag, so one successful
    // save disabled that person's Remove for good. The amounts spin on their
    // own key now -- see `requestMoreTimeKey`.
    await stubLiveGrant(page, 4 * 60);
    await signInAsReviewer(page);
    await openMoreTimePanel(page);

    await moreTimeButton(page, "30 min more").click();

    await expect(
      page.getByRole("button", { name: `Remove ${OWNER_NAME}'s access` }),
    ).toBeEnabled({ timeout: 20_000 });
  });

  for (const width of [320, 390, 430]) {
    test(`panel fits and stays tappable at ${width}px`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));

      await page.setViewportSize({ width, height: 844 });
      await stubLiveGrant(page, 4 * 60);
      await signInAsReviewer(page);
      await openMoreTimePanel(page);

      // RES-001: the editor must not push the page sideways.
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return (
          Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) -
          root.clientWidth
        );
      });
      expect(overflow).toBeLessThanOrEqual(1);

      // RES-002/005: every amount is inside the viewport and big enough to
      // hit. All four, not one: below 340px they stack to a single column and
      // above it they are a 2x2, and it is the longest label ("2 hours more")
      // that decides whether either fits.
      const amounts = page
        .getByTestId("one-location-more-time-options")
        .getByRole("button");
      await expect(amounts).toHaveCount(4);
      for (let index = 0; index < 4; index += 1) {
        const box = await amounts.nth(index).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(-1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      // RES-012: opening the panel introduces no runtime errors.
      expect(
        consoleErrors.filter(
          (text) => !/favicon|Failed to load resource|net::ERR_/i.test(text),
        ),
      ).toEqual([]);
    });
  }
});
