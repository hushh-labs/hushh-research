import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The inline "add minutes" control on a live share, in a real browser.
 *
 * The component tests prove the logic; these prove the thing a person
 * actually touches -- against the deployed bundle when BASE_URL points at
 * UAT. The reported bugs were all in this editor:
 *
 *   "save button taking more time after edit time"
 *   "time reset is not working"
 *
 * The live grant is supplied by intercepting the workspace state, so this
 * needs one reviewer account rather than two real people mid-share.
 *
 * The control used to be a pencil opening a full "New duration" dropdown +
 * Save, with an X beside it that revoked the grant. It's now a compact,
 * immediate-apply "add minutes" chip row -- shortening and the X are both
 * gone from this row (ending a received share now lives only on Shared with
 * me), so these specs test extend-only behavior and confirm the X is gone.
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

/**
 * `ceilingMinutes`, when given, sets `ceilingExpiresAt` -- the furthest the
 * owner ever explicitly approved. Without it, the backend's own fallback
 * treats the current expiry as its own ceiling, so any chip tap has zero
 * room to grow into and always asks the owner instead of applying directly.
 * Tests of the in-ceiling grow path need real headroom or they silently end
 * up testing the ask-the-owner path instead.
 */
function liveGrant(minutes: number, ceilingMinutes?: number) {
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
    ...(ceilingMinutes !== undefined
      ? { ceilingExpiresAt: expiresInMinutes(ceilingMinutes) }
      : {}),
  };
}

/**
 * Give the workspace state one live received share, leaving every other
 * projection exactly as the backend sent it. Rewriting the whole payload
 * would test a fixture rather than the screen.
 */
async function stubLiveGrant(
  page: Page,
  minutes: number,
  ceilingMinutes?: number,
) {
  await page.route("**/api/one/location/state", async (route: Route) => {
    const response = await route.fetch();
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return route.fulfill({ response });
    }
    const grant = liveGrant(minutes, ceilingMinutes);
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

/** Every call the control could make, recorded in order. */
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

/** Land on Request with context, open the add-minutes control on the fixture's row. */
async function openAddTimeControl(page: Page) {
  await page.goto("/one/location?action=ask", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Request with context" })
    .waitFor({ state: "visible", timeout: 90_000 });
  const trigger = page.getByRole("button", {
    name: `Add time for ${OWNER_NAME}`,
  });
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();
  await page
    .getByRole("button", { name: `Add 15 minutes for ${OWNER_NAME}` })
    .waitFor({ state: "visible", timeout: 15_000 });
}

test.describe("One Location inline add-minutes control", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs reviewer credentials AND a /login sign-in path for automation (E2E_REVIEWER_SIGNIN=1); the 'Continue as reviewer' control these specs click does not exist in this repository",
  );
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });
  test.setTimeout(180_000);

  test("does not offer Remove on this screen -- that lives on Shared with me", async ({ page }) => {
    await stubLiveGrant(page, 4 * 60);
    await signInAsReviewer(page);
    await openAddTimeControl(page);

    await expect(
      page.getByRole("button", { name: `Remove ${OWNER_NAME}'s access` }),
    ).toHaveCount(0);
  });

  test("a chip within the ceiling applies immediately and leaves the row usable", async ({ page }) => {
    // The saving flag used to be the revoke flag, and the shorten path left
    // it set -- so the next open showed a chip already spinning and
    // permanently disabled. That is the "save button takes more time" report.
    const calls = recordDurationCalls(page);
    await stubLiveGrant(page, 4 * 60, 24 * 60);
    await signInAsReviewer(page);
    await openAddTimeControl(page);

    await page.getByRole("button", { name: `Add 15 minutes for ${OWNER_NAME}` }).click();

    await expect.poll(() => calls, { timeout: 20_000 }).toContain("shorten PATCH");
    expect(calls.filter((c) => c === "request POST")).toEqual([]);

    // The trigger and its chips are usable again straight away.
    const trigger = page.getByRole("button", { name: `Add time for ${OWNER_NAME}` });
    await expect(trigger).toBeEnabled({ timeout: 20_000 });
    await trigger.click();
    await expect(
      page.getByRole("button", { name: `Add 30 minutes for ${OWNER_NAME}` }),
    ).toBeEnabled();
  });

  test("asks the owner directly when a chip would push past the ceiling", async ({ page }) => {
    const calls = recordDurationCalls(page);
    // No ceiling given -- the fallback treats the current expiry as its own
    // ceiling, so any chip tap has to ask.
    await stubLiveGrant(page, 12);
    await signInAsReviewer(page);
    await openAddTimeControl(page);

    await page.getByRole("button", { name: `Add 15 minutes for ${OWNER_NAME}` }).click();

    await expect.poll(() => calls, { timeout: 20_000 }).toContain("request POST");
    // The doomed shorten that made Save slow must not be spent.
    expect(calls.filter((c) => c === "shorten PATCH")).toEqual([]);
  });

  for (const width of [320, 390, 430]) {
    test(`add-minutes control fits and stays tappable at ${width}px`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));

      await page.setViewportSize({ width, height: 844 });
      await stubLiveGrant(page, 4 * 60, 24 * 60);
      await signInAsReviewer(page);
      await openAddTimeControl(page);

      // RES-001: the control must not push the page sideways.
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return (
          Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) -
          root.clientWidth
        );
      });
      expect(overflow).toBeLessThanOrEqual(1);

      // RES-002/005: the chip is inside the viewport and big enough to hit.
      const chip = page.getByRole("button", { name: `Add 15 minutes for ${OWNER_NAME}` });
      const box = await chip.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.left).toBeGreaterThanOrEqual(-1);
      expect(box!.right).toBeLessThanOrEqual(width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(36);

      // RES-012: opening the control introduces no runtime errors.
      expect(
        consoleErrors.filter(
          (text) => !/favicon|Failed to load resource|net::ERR_/i.test(text),
        ),
      ).toEqual([]);
    });
  }
});
