import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The inline "New duration" editor on a live share, in a real browser.
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

/** Land on Request with context, with the fixture's row on screen. */
async function openDurationEditor(page: Page) {
  await page.goto("/one/location?action=ask", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Request with context" })
    .waitFor({ state: "visible", timeout: 90_000 });
  const edit = page.getByRole("button", {
    name: `Edit access for ${OWNER_NAME}`,
  });
  await edit.waitFor({ state: "visible", timeout: 30_000 });
  await edit.click();
  await page
    .getByRole("combobox", { name: "New duration" })
    .waitFor({ state: "visible", timeout: 15_000 });
}

test.describe("One Location inline duration editor", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs reviewer credentials AND a /login sign-in path for automation (E2E_REVIEWER_SIGNIN=1); the 'Continue as reviewer' control these specs click does not exist in this repository",
  );
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });
  test.setTimeout(180_000);

  test("opens on what the share has left, not a constant hour", async ({ page }) => {
    // The row said "4 more hours" while the picker underneath said "1 hour".
    await stubLiveGrant(page, 4 * 60);
    await signInAsReviewer(page);
    await openDurationEditor(page);

    await expect(
      page.getByRole("combobox", { name: "New duration" }),
    ).toHaveText(/4 hours/);
  });

  test("Save on an untouched picker calls nothing and closes", async ({ page }) => {
    // This is "time reset is not working": Save spent a refused shorten, then
    // asked the owner for one more minute, and the row never moved.
    const calls = recordDurationCalls(page);
    await stubLiveGrant(page, 59);
    await signInAsReviewer(page);
    await openDurationEditor(page);

    await expect(
      page.getByRole("combobox", { name: "New duration" }),
    ).toHaveText(/1 hour/);

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeHidden({
      timeout: 15_000,
    });
    expect(calls).toEqual([]);
  });

  test("shortening applies immediately and leaves the row usable", async ({ page }) => {
    // The saving flag used to be the revoke flag, and the shorten path left
    // it set -- so Remove stayed disabled and the next Edit opened on a Save
    // that spun forever.
    const calls = recordDurationCalls(page);
    await stubLiveGrant(page, 4 * 60);
    await signInAsReviewer(page);
    await openDurationEditor(page);

    await page.getByRole("combobox", { name: "New duration" }).click();
    await page.getByRole("option", { name: "30 min" }).click();
    await page.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => calls, { timeout: 20_000 }).toContain("shorten PATCH");
    // One call, not a refused shorten followed by a request.
    expect(calls.filter((c) => c === "request POST")).toEqual([]);

    const remove = page.getByRole("button", {
      name: `Remove ${OWNER_NAME}'s access`,
    });
    await expect(remove).toBeEnabled({ timeout: 20_000 });

    // And the same person can be edited again straight away.
    await page.getByRole("button", { name: `Edit access for ${OWNER_NAME}` }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("asks the owner directly when the new duration would extend", async ({ page }) => {
    const calls = recordDurationCalls(page);
    await stubLiveGrant(page, 12);
    await signInAsReviewer(page);
    await openDurationEditor(page);

    await page.getByRole("combobox", { name: "New duration" }).click();
    await page.getByRole("option", { name: "4 hours" }).click();
    await page.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => calls, { timeout: 20_000 }).toContain("request POST");
    // The doomed shorten that made Save slow must not be spent.
    expect(calls.filter((c) => c === "shorten PATCH")).toEqual([]);
  });

  for (const width of [320, 390, 430]) {
    test(`editor fits and stays tappable at ${width}px`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));

      await page.setViewportSize({ width, height: 844 });
      await stubLiveGrant(page, 4 * 60);
      await signInAsReviewer(page);
      await openDurationEditor(page);

      // RES-001: the editor must not push the page sideways.
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return (
          Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) -
          root.clientWidth
        );
      });
      expect(overflow).toBeLessThanOrEqual(1);

      // RES-002/005: Save is inside the viewport and big enough to hit.
      const save = page.getByRole("button", { name: "Save" });
      const box = await save.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.left).toBeGreaterThanOrEqual(-1);
      expect(box!.right).toBeLessThanOrEqual(width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(36);

      // RES-012: opening the editor introduces no runtime errors.
      expect(
        consoleErrors.filter(
          (text) => !/favicon|Failed to load resource|net::ERR_/i.test(text),
        ),
      ).toEqual([]);
    });
  }
});
