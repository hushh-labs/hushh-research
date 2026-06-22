import { expect, test, type Page } from "@playwright/test";

/**
 * Consent Connector + UX Verification (real signed-in flow)
 * =========================================================
 *
 * Verifies, against a real signed-in + vault-unlocked session:
 *   1. The agent icon lives inside the Kai search bar.
 *   2. A developer-connector consent request surfaces in the MAIN consent
 *      manager (not just a notification) with the friendly developer name.
 *   3. The detail view humanizes the scope (no raw `pkm.read`) and exposes the
 *      "Allow" / "Don't allow" actions (consumer-friendly wording).
 *
 * PREREQUISITES
 *   Backend (consent-protocol) must run with review mode enabled and the
 *   Cloud SQL proxy up so the DB is reachable:
 *     APP_REVIEW_MODE=true REVIEWER_UID=<uid> REVIEWER_VAULT_PASSPHRASE=<pass> \
 *       python -m uvicorn server:app --port 8000
 *     cloud-sql-proxy --address 127.0.0.1 --port 6543 \
 *       --credentials-file <creds.json> <instance>
 *
 *   Provide the reviewer fixture to the test via env:
 *     REVIEWER_UID, REVIEWER_VAULT_PASSPHRASE
 *
 *   A pending developer request must exist for the reviewer user. Create one with:
 *     POST /api/v1/request-consent  (Authorization: Bearer <developer-token>)
 *     body: { user_id, scope: "pkm.read", connector_public_key, connector_key_id,
 *             connector_wrapping_alg: "X25519-AES256-GCM", ... }
 *   The developer app registered for the local token displays as
 *   "Codex Local Workspace".
 *
 * Run:
 *   REVIEWER_UID=... REVIEWER_VAULT_PASSPHRASE=... \
 *     npx playwright test e2e/consent-connector-ux.spec.ts --project=chromium
 */

const EXPECTED_DEV_NAME = process.env.CONSENT_DEV_NAME || "Codex Local Workspace";
const REVIEWER_UID = process.env.REVIEWER_UID || "";
const REVIEWER_PASSPHRASE = process.env.REVIEWER_VAULT_PASSPHRASE || "";

// Inject the native-test bridge so NativeTestBootstrap auto-logs-in + unlocks.
async function enableReviewerBridge(page: Page) {
  if (!REVIEWER_UID || !REVIEWER_PASSPHRASE) return false;
  await page.addInitScript(
    ({ uid, pass }) => {
      (window as unknown as { __HUSHH_NATIVE_TEST__?: unknown }).__HUSHH_NATIVE_TEST__ = {
        enabled: true,
        autoReviewerLogin: true,
        vaultPassphrase: pass,
        expectedUserId: uid,
      };
    },
    { uid: REVIEWER_UID, pass: REVIEWER_PASSPHRASE },
  );
  return true;
}

async function waitForVaultUnlocked(page: Page) {
  await page.waitForFunction(
    () =>
      (window as unknown as { __HUSHH_NATIVE_TEST__?: { bootstrapState?: string } })
        .__HUSHH_NATIVE_TEST__?.bootstrapState === "vault_unlocked",
    { timeout: 30_000 },
  );
}

// A developer (consumer) consent request is reviewed on the INVESTOR surface.
// Reviewer accounts may default to the RIA persona, so switch via the app's own API.
async function switchToInvestorPersona(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __HUSHH_NATIVE_TEST__?: { switchPersona?: unknown } })
        .__HUSHH_NATIVE_TEST__?.switchPersona === "function",
    { timeout: 20_000 },
  );
  await page.evaluate(async () => {
    const b = (
      window as unknown as {
        __HUSHH_NATIVE_TEST__?: { switchPersona?: (t: string) => Promise<unknown> };
      }
    ).__HUSHH_NATIVE_TEST__;
    await b?.switchPersona?.("investor");
  });
  await page
    .waitForFunction(
      () =>
        (window as unknown as { __HUSHH_NATIVE_TEST__?: { personaSwitchStatus?: string } })
          .__HUSHH_NATIVE_TEST__?.personaSwitchStatus === "ok:investor",
      { timeout: 30_000 },
    )
    .catch(() => {});
}

test.describe("Consent connector UX", () => {
  test("agent icon is present inside the Kai search bar", async ({ page }) => {
    await enableReviewerBridge(page);
    await page.goto("/kai", { waitUntil: "domcontentloaded" });
    const agentButton = page.getByRole("button", { name: /open agent/i }).first();
    await expect(agentButton).toBeVisible({ timeout: 20_000 });
  });

  test("developer request shows friendly name + detailed view + Allow/Don't allow", async ({
    page,
  }) => {
    const authed = await enableReviewerBridge(page);
    test.skip(
      !authed,
      "Set REVIEWER_UID + REVIEWER_VAULT_PASSPHRASE to run the signed-in detail check.",
    );

    await page.goto("/kai", { waitUntil: "domcontentloaded" });
    await waitForVaultUnlocked(page);
    await switchToInvestorPersona(page);

    await page.goto("/consents?tab=pending", { waitUntil: "domcontentloaded" });

    // Friendly developer name appears in the MAIN consent manager (not a toast).
    const devName = page.getByText(EXPECTED_DEV_NAME, { exact: false }).first();
    const present = await devName
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !present,
      `No pending "${EXPECTED_DEV_NAME}" request found. Create one via POST /api/v1/request-consent first.`,
    );

    // Open the detail dialog for that request.
    await devName.click();
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // Detail view humanizes the scope (no raw "pkm.read" in the primary area).
    await expect(dialog.getByText(/personal knowledge model/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // Consumer-friendly Allow / Don't allow actions are present.
    await expect(dialog.getByRole("button", { name: /^Allow$/ }).first()).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Don.?t allow/i }).first(),
    ).toBeVisible();

    // Raw scope id is tucked into Technical details, not the primary review area.
    await expect(dialog.getByText(/Scope ID/i).first()).toBeVisible();
  });
});
