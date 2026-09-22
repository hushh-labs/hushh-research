import type { Page } from "@playwright/test";

/**
 * Shared reviewer sign-in for specs that need a real unlocked vault.
 * Mirrors the bootstrap loop in e2e/agent-action-dispatch-location.spec.ts.
 */

const REQUIRED_VALUES = ["REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"] as const;

export function hasReviewerSession() {
  return (
    REQUIRED_VALUES.every((key) => Boolean(process.env[key]?.trim())) &&
    process.env.E2E_REVIEWER_SIGNIN === "1"
  );
}

export async function openReviewerSession(
  page: Page,
  redirect = "/one/location",
) {
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
      expectedUserId: process.env.REVIEWER_UID ?? "",
      vaultPassphrase: process.env.REVIEWER_VAULT_PASSPHRASE ?? "",
    },
  );
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`, {
    waitUntil: "domcontentloaded",
  });

  const unlockInput = page.locator("#unlock-passphrase");
  const unlockButton = page
    .getByRole("button", { name: /unlock with passphrase/i })
    .first();
  const terminalFailures = new Set([
    "auth_error",
    "uid_mismatch",
    "vault_error",
  ]);
  const deadline = Date.now() + 90_000;
  let manualUnlockSubmitted = false;
  while (Date.now() < deadline) {
    const bootstrap = await page.evaluate(() => ({
      state: String(window.__HUSHH_NATIVE_TEST__?.bootstrapState || ""),
      errorClass: String(
        window.__HUSHH_NATIVE_TEST__?.bootstrapErrorClass || "",
      ),
    }));
    if (bootstrap.state === "vault_unlocked") break;
    if (terminalFailures.has(bootstrap.state)) {
      throw new Error(
        `Reviewer vault bootstrap failed (state=${bootstrap.state}, error_class=${bootstrap.errorClass || "unknown"}).`,
      );
    }
    if (
      !manualUnlockSubmitted &&
      (await unlockInput.isVisible().catch(() => false))
    ) {
      await unlockInput.fill(process.env.REVIEWER_VAULT_PASSPHRASE ?? "");
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
  await page.goto(redirect, { waitUntil: "domcontentloaded" });
}
