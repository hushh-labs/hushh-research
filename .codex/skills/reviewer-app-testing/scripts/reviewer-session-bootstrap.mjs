/** Memory-only admission inside the canonical reviewer-session harness. */
export function createReviewerBootstrap({ reviewerUid, reviewerPassphrase,
  reviewerAuthMode, allowMemoryPreparation, admitMutation, deferLegalAcceptance, timeoutMs }) {
  async function installBridge(page, { includePassphrase = true } = {}) {
    const reviewerMutationPolicy = process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true"
      ? admitMutation ? "bounded_mutation" : "mutation_authorized"
      : allowMemoryPreparation
        ? "preparation_only"
        : "read_only";
    await page.addInitScript(
      ({
        expectedUserId,
        vaultPassphrase,
        reviewerSessionPassphrase,
        reviewerMutationPolicy,
        reviewerAuthMode,
      }) => {
        window.__HUSHH_NATIVE_TEST__ = {
          ...(window.__HUSHH_NATIVE_TEST__ || {}),
          enabled: true,
          autoReviewerLogin: true,
          expectedUserId,
          reviewerMutationPolicy,
          reviewerAuthMode,
          // The backend review-session mint requires the reviewer passphrase
          // even when this context must not auto-unlock the vault.
          ...(reviewerAuthMode === "human_authenticated" ? {} : { reviewerSessionPassphrase }),
          ...(reviewerAuthMode !== "human_authenticated" && vaultPassphrase ? { vaultPassphrase } : {}),
        };
      },
      {
        expectedUserId: reviewerUid,
        vaultPassphrase: includePassphrase ? reviewerPassphrase : "",
        reviewerSessionPassphrase: reviewerPassphrase,
        reviewerMutationPolicy,
        reviewerAuthMode,
      }
    );
  }

  async function waitForUnlock(page, readOnlyGuard, unlockTimeoutMs = timeoutMs, requireVaultUnlocked = true) {
    const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
    const unlockInput = page.locator("#unlock-passphrase");
    const passphraseFallback = page.locator('[data-testid="vault-use-passphrase-instead"]');
    const unlockButton = page
      .getByRole("button", { name: /^unlock/i })
      .first();
    const terminalFailures = new Set(["auth_error", "uid_mismatch", "vault_error"]);
    const deadline = Date.now() + unlockTimeoutMs;
    let challengeObserved = false;
    const humanAuthenticated = reviewerAuthMode === "human_authenticated";
    let reviewerLoginSubmitted = false;
    let manualPassphraseFilled = false;
    let manualUnlockSubmitted = false;
    let passphraseFallbackClicked = false;

    const safeBootstrapState = async () =>
      page.evaluate((expectedUserId) => {
        const bridge = window.__HUSHH_NATIVE_TEST__;
        const bootstrapUserId = String(bridge?.bootstrapUserId || "");
        return {
          state: String(bridge?.bootstrapState || ""),
          errorClass: String(bridge?.bootstrapErrorClass || ""),
          mismatchStage: String(bridge?.bootstrapDetail || "").split(":", 1)[0],
          path: window.location.pathname,
          userMatches: Boolean(bootstrapUserId && bootstrapUserId === expectedUserId),
        };
      }, reviewerUid);

    while (Date.now() < deadline) {
      readOnlyGuard.assertNoBlockedMutation();
      await deferLegalAcceptance(page);
      const bootstrap = await safeBootstrapState();
      if (bootstrap.userMatches && bootstrap.state === "authenticated" &&
          await unlockInput.isVisible().catch(() => false)) challengeObserved = true;
      if (bootstrap.userMatches &&
        (bootstrap.state === "vault_unlocked" ||
          (!requireVaultUnlocked && bootstrap.state === "authenticated"))) {
        if (humanAuthenticated && requireVaultUnlocked && !challengeObserved) {
          throw new Error("Human reviewer admission requires an owner-bound visible vault challenge.");
        }
        return;
      }
      if (terminalFailures.has(bootstrap.state)) {
        const error = new Error(
          `Reviewer vault bootstrap failed (state=${bootstrap.state}, error_class=${bootstrap.errorClass || "unknown"}, stage=${["signin_result", "auth_context", "native_session", "vault_context"].includes(bootstrap.mismatchStage) ? bootstrap.mismatchStage : "unknown"}, path=${bootstrap.path}, user_match=${bootstrap.userMatches}).`
        );
        error.code = "REVIEWER_TERMINAL_BOOTSTRAP";
        throw error;
      }

      if (!humanAuthenticated && !reviewerLoginSubmitted && await reviewerButton.isVisible().catch(() => false)) {
        reviewerLoginSubmitted = await page.evaluate(() => {
          const trigger = window.__HUSHH_NATIVE_TEST__?.triggerReviewerLogin;
          if (typeof trigger !== "function") return false;
          trigger();
          return true;
        });
      }

      if (humanAuthenticated || !bootstrap.userMatches) {
        await page.waitForTimeout(250);
        continue;
      }

      if (requireVaultUnlocked && !passphraseFallbackClicked &&
        !(await unlockInput.isVisible().catch(() => false)) &&
        await passphraseFallback.isVisible().catch(() => false)) {
        await passphraseFallback.click({ noWaitAfter: true });
        passphraseFallbackClicked = true;
      }

      if (requireVaultUnlocked && !manualUnlockSubmitted && await unlockInput.isVisible().catch(() => false)) {
        if (!manualPassphraseFilled) {
          await unlockInput.fill(reviewerPassphrase);
          manualPassphraseFilled = true;
        }
        const current = await safeBootstrapState();
        if (!current.userMatches || terminalFailures.has(current.state)) {
          await unlockInput.fill("");
          throw new Error("Reviewer identity changed before vault unlock submission.");
        }
        if (await unlockButton.isEnabled().catch(() => false)) {
          await unlockButton.click({ noWaitAfter: true });
          manualUnlockSubmitted = true;
        }
      }

      await page.waitForTimeout(250);
    }

    const bootstrap = await safeBootstrapState();
    throw new Error(
      `Reviewer vault bootstrap timed out (state=${bootstrap.state || "unknown"}, error_class=${bootstrap.errorClass || "none"}, path=${bootstrap.path}, user_match=${bootstrap.userMatches}).`
    );
  }

  return { installBridge, waitForUnlock };
}
