import type { Page } from "@playwright/test";
import path from "node:path";
// Canonical harness is shared with the operational reviewer rehearsals.
import { createReviewerSessionHarness } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";

export async function createProtectedReviewerHarness(
  identity: ReviewerIdentity,
  appOrigin: string,
) {
  return createReviewerSessionHarness({
    repoRoot: path.resolve(__dirname, "../../.."),
    appOrigin,
    reviewerIdentity: {
      reviewerUid: identity.userId,
      reviewerVaultPassphrase: identity.passphrase,
    },
  });
}

/**
 * Reviewer sign-in for real-backend Playwright specs.
 *
 * Lifted verbatim from agent-action-dispatch-consent.spec.ts so a spec that
 * needs TWO signed-in people (the information-sharing proof) can open the
 * same session twice with different identities instead of copying the loop.
 *
 * Sign-in drives the `__HUSHH_NATIVE_TEST__` bridge directly rather than a
 * "Continue as reviewer" control this repo does not have -- see
 * agent-action-dispatch-location.spec.ts for the history. Credentials are
 * never logged: a failure names the bootstrap state and error class only.
 */

export type ReviewerIdentity = {
  userId: string;
  passphrase: string;
};

export type OpenReviewerSessionOptions = {
  /** Where /login sends the person once signed in. Default: /one/location. */
  redirectTo?: string;
  /**
   * Heading that proves the landing page rendered. Default: "Location Agent",
   * the heading at /one/location. Pass null to skip the heading wait.
   */
  readyHeading?: string | null;
};

const TERMINAL_BOOTSTRAP_FAILURES = new Set([
  "auth_error",
  "uid_mismatch",
  "vault_error",
]);

/**
 * Read a {userId, passphrase} pair from two env keys. Empty when either is
 * blank so a caller can gate on it; values are never echoed.
 */
export function reviewerIdentityFromEnv(
  uidKey: string,
  passphraseKey: string,
): ReviewerIdentity | null {
  const userId = process.env[uidKey]?.trim() ?? "";
  const passphrase = process.env[passphraseKey]?.trim() ?? "";
  if (!userId || !passphrase) return null;
  return { userId, passphrase };
}

/**
 * Wait until the bridge reports the vault unlocked on the current document,
 * typing the passphrase into #unlock-passphrase once if the app asks for it.
 *
 * The bootstrap runs on every full page load (the init script re-installs the
 * bridge), so a spec that navigates with `page.goto` between surfaces calls
 * this after each navigation before touching vault-gated controls.
 */
export async function waitForReviewerVault(
  page: Page,
  identity: ReviewerIdentity,
  timeoutMs = 90_000,
): Promise<void> {
  const unlockInput = page.locator("#unlock-passphrase");
  const unlockButton = page
    .getByRole("button", { name: /unlock with passphrase/i })
    .first();
  const deadline = Date.now() + timeoutMs;
  let manualUnlockSubmitted = false;

  while (Date.now() < deadline) {
    const bootstrap = await page.evaluate(() => ({
      state: String(window.__HUSHH_NATIVE_TEST__?.bootstrapState || ""),
      errorClass: String(
        window.__HUSHH_NATIVE_TEST__?.bootstrapErrorClass || "",
      ),
    }));
    if (bootstrap.state === "vault_unlocked") return;
    if (TERMINAL_BOOTSTRAP_FAILURES.has(bootstrap.state)) {
      throw new Error(
        `Reviewer vault bootstrap failed (state=${bootstrap.state}, error_class=${bootstrap.errorClass || "unknown"}). ` +
          "This is a fixture/credential problem, not an action-dispatch problem -- see project notes on the shared reviewer fixture.",
      );
    }
    if (
      !manualUnlockSubmitted &&
      (await unlockInput.isVisible().catch(() => false))
    ) {
      await unlockInput.fill(identity.passphrase);
      if (await unlockButton.isEnabled().catch(() => false)) {
        await unlockButton.click({ noWaitAfter: true });
        manualUnlockSubmitted = true;
      }
    }
    await page.waitForTimeout(250);
  }

  const finalState = await page.evaluate(
    () => window.__HUSHH_NATIVE_TEST__?.bootstrapState || "",
  );
  if (finalState !== "vault_unlocked") {
    throw new Error(
      `Reviewer vault bootstrap timed out (state=${finalState || "unknown"}).`,
    );
  }
}

/**
 * Sign the given identity in on this page and leave it with the vault
 * unlocked on the landing route. Behaviour is identical to the loop the
 * dispatch specs carried inline; only the identity became a parameter.
 */
export async function openReviewerSession(
  page: Page,
  identity: ReviewerIdentity,
  options: OpenReviewerSessionOptions = {},
): Promise<void> {
  const redirectTo = options.redirectTo ?? "/one/location";
  const readyHeading =
    options.readyHeading === undefined
      ? "Location Agent"
      : options.readyHeading;

  await page.addInitScript(
    ({ expectedUserId, vaultPassphrase }) => {
      window.__HUSHH_NATIVE_TEST__ = {
        ...(window.__HUSHH_NATIVE_TEST__ || {}),
        enabled: true,
        autoReviewerLogin: true,
        expectedUserId,
        vaultPassphrase,
      };
    },
    {
      expectedUserId: identity.userId,
      vaultPassphrase: identity.passphrase,
    },
  );

  await page.goto(`/login?redirect=${encodeURIComponent(redirectTo)}`, {
    waitUntil: "domcontentloaded",
  });

  await waitForReviewerVault(page, identity);

  if (readyHeading) {
    await page.getByRole("heading", { name: readyHeading }).waitFor({
      state: "visible",
      timeout: 60_000,
    });
  }
}
