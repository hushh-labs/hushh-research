import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function endpointPath(rawUrl) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "";
  }
}

const CRITICAL_REVIEWER_API_PATHS = [
  "/api/vault/bootstrap-state",
  "/api/consent/center/summary",
  "/api/one/connections",
  "/api/notifications/register",
  "/api/pkm",
];

async function waitForValue(readValue, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export async function createReviewerSessionHarness({
  repoRoot,
  appOrigin = "https://uat.one.hushh.ai",
  timeoutMs = 360_000,
}) {
  const webDir = path.join(repoRoot, "hushh-webapp");
  const requireFromWeb = createRequire(path.join(webDir, "package.json"));
  const { chromium } = requireFromWeb("playwright");
  const identityModule = await import(
    pathToFileURL(path.join(webDir, "scripts/testing/reviewer-test-identity.mjs")).href
  );
  const identity = identityModule.resolveReviewerTestIdentity({
    envFiles: identityModule.defaultReviewerIdentityEnvFiles({ repoRoot, webDir }),
  });
  const reviewerUid = identity.reviewerUid;
  const reviewerPassphrase = identity.reviewerVaultPassphrase;
  const normalizedOrigin = String(appOrigin).replace(/\/$/, "");

  function vaultKeyCommitment(vaultState) {
    const commitment = String(vaultState?.vaultKeyHash || vaultState?.vault_key_hash || "");
    if (!commitment) {
      throw new Error("Reviewer vault state has no key commitment.");
    }
    return commitment;
  }

  async function installBridge(page, { includePassphrase = true } = {}) {
    await page.addInitScript(
      ({ expectedUserId, vaultPassphrase }) => {
        window.__HUSHH_NATIVE_TEST__ = {
          ...(window.__HUSHH_NATIVE_TEST__ || {}),
          enabled: true,
          autoReviewerLogin: true,
          expectedUserId,
          ...(vaultPassphrase ? { vaultPassphrase } : {}),
        };
      },
      {
        expectedUserId: reviewerUid,
        vaultPassphrase: includePassphrase ? reviewerPassphrase : "",
      }
    );
  }

  function attachMemoryOnlyCapture(page) {
    let vaultState = null;
    let ownerToken = "";
    let firebaseBearer = "";
    const criticalApiFailures = [];
    const responsePromises = new Set();
    // Two DISTINCT tokens, each read only off its own allowlisted routes so one
    // can never be mistaken for the other: the vault-owner token rides /api/pkm/,
    // and the Firebase ID token rides the state/agent routes below. The Firebase
    // capture exists because the app fetches bootstrap state DURING sign-in and
    // then serves it from cache -- a caller who attaches a listener after
    // openSession returns can wait forever for a request that already happened.
    const firebaseBearerPaths = [
      "/api/vault/bootstrap-state",
      "/api/vault/pre-vault-state",
      "/api/one/runtime/",
      "/api/one/personal-agent/status",
      "/api/one/u/",
    ];
    page.on("request", (request) => {
      const pathname = endpointPath(request.url());
      const authorization = request.headers().authorization || "";
      if (!authorization.startsWith("Bearer ")) return;
      if (pathname.startsWith("/api/pkm/")) {
        ownerToken = authorization.slice(7);
        return;
      }
      if (firebaseBearerPaths.some((prefix) => pathname.startsWith(prefix))) {
        firebaseBearer = authorization.slice(7);
      }
    });
    page.on("response", (response) => {
      const pathname = endpointPath(response.url());
      if (
        response.status() >= 500 &&
        CRITICAL_REVIEWER_API_PATHS.some(
          (criticalPath) =>
            pathname === criticalPath || pathname.startsWith(`${criticalPath}/`)
        )
      ) {
        criticalApiFailures.push({ pathname, status: response.status() });
      }
      if (pathname !== "/api/vault/get" || !response.ok()) return;
      const pending = response
        .json()
        .then((payload) => {
          vaultState = payload;
        })
        .catch(() => undefined)
        .finally(() => responsePromises.delete(pending));
      responsePromises.add(pending);
    });
    return {
      async ownerToken() {
        return waitForValue(() => ownerToken, "vault-owner token", timeoutMs);
      },
      // Synchronous on purpose: the sign-in traffic already happened by the time
      // a caller asks, so there is nothing to wait for — either it was observed
      // or the caller needs to trigger a fetch of its own.
      firebaseBearer() {
        return firebaseBearer;
      },
      async vaultState() {
        const state = await waitForValue(() => vaultState, "encrypted vault state", timeoutMs);
        await Promise.all([...responsePromises]);
        return state;
      },
      assertNoCriticalApiFailures(label) {
        if (criticalApiFailures.length === 0) return;
        const summary = criticalApiFailures
          .map(({ pathname, status }) => `${pathname}:${status}`)
          .join(",");
        throw new Error(`${label} observed critical first-party API failures: ${summary}`);
      },
    };
  }

  async function waitForUnlock(page, unlockTimeoutMs = timeoutMs) {
    const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
    const unlockInput = page.locator("#unlock-passphrase");
    const unlockButton = page
      .getByRole("button", { name: /unlock with passphrase/i })
      .first();
    const terminalFailures = new Set(["auth_error", "uid_mismatch", "vault_error"]);
    const deadline = Date.now() + unlockTimeoutMs;
    let reviewerLoginSubmitted = false;
    let manualPassphraseFilled = false;
    let manualUnlockSubmitted = false;

    const safeBootstrapState = async () =>
      page.evaluate((expectedUserId) => {
        const bridge = window.__HUSHH_NATIVE_TEST__;
        const bootstrapUserId = String(bridge?.bootstrapUserId || "");
        return {
          state: String(bridge?.bootstrapState || ""),
          errorClass: String(bridge?.bootstrapErrorClass || ""),
          path: window.location.pathname,
          userMatches: Boolean(bootstrapUserId && bootstrapUserId === expectedUserId),
        };
      }, reviewerUid);

    while (Date.now() < deadline) {
      const bootstrap = await safeBootstrapState();
      if (bootstrap.state === "vault_unlocked" && bootstrap.userMatches) return;
      if (terminalFailures.has(bootstrap.state)) {
        throw new Error(
          `Reviewer vault bootstrap failed (state=${bootstrap.state}, error_class=${bootstrap.errorClass || "unknown"}, path=${bootstrap.path}, user_match=${bootstrap.userMatches}).`
        );
      }

      if (!reviewerLoginSubmitted && await reviewerButton.isVisible().catch(() => false)) {
        await reviewerButton.click({ noWaitAfter: true });
        reviewerLoginSubmitted = true;
      }

      if (!manualUnlockSubmitted && await unlockInput.isVisible().catch(() => false)) {
        if (!manualPassphraseFilled) {
          await unlockInput.fill(reviewerPassphrase);
          manualPassphraseFilled = true;
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

  async function assertVaultContinuity(page, label) {
    const unlockVisible = await page.locator("#unlock-passphrase").isVisible().catch(() => false);
    if (unlockVisible) throw new Error(`${label} lost the reviewer vault key.`);
    const state = await page.evaluate(
      () => window.__HUSHH_NATIVE_TEST__?.bootstrapState || ""
    );
    if (state && state !== "vault_unlocked") {
      throw new Error(`${label} changed vault bootstrap state to ${state}.`);
    }
  }

  async function navigateInApp(page, href) {
    await page.evaluate((targetHref) => {
      window.dispatchEvent(
        new CustomEvent("app-internal-navigation-requested", {
          detail: { href: targetHref, scroll: false },
        })
      );
    }, href);
    await page.waitForFunction(
      (targetHref) => `${window.location.pathname}${window.location.search}` === targetHref,
      href,
      { timeout: timeoutMs }
    );
    await assertVaultContinuity(page, href);
  }

  async function openSession(browser, redirect) {
    const maxAttempts = 3;
    const attemptTimeoutMs = Math.max(20_000, Math.floor(timeoutMs / maxAttempts));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(attemptTimeoutMs);
      page.setDefaultNavigationTimeout(attemptTimeoutMs);
      const capture = attachMemoryOnlyCapture(page);
      await installBridge(page);
      try {
        await page.goto(`${normalizedOrigin}/login?redirect=${encodeURIComponent(redirect)}`, {
          waitUntil: "domcontentloaded",
        });
        await waitForUnlock(page, attemptTimeoutMs);
        // The bridge reports `vault_unlocked` while /login is still resolving
        // its redirect. Returning here hands the caller a page with a pending
        // navigation that silently clobbers their first navigateInApp, which
        // then times out against a URL the login route overwrote. Wait for the
        // handoff to leave /login. The destination is deliberately not asserted:
        // the redirect is state-aware and may legitimately land on onboarding.
        await page.waitForFunction(
          () => !window.location.pathname.startsWith("/login"),
          undefined,
          { timeout: attemptTimeoutMs }
        );
        return { context, page, capture };
      } catch (error) {
        lastError = error;
        await context.close().catch(() => undefined);
      }
    }

    throw new Error(`Reviewer session bootstrap failed after ${maxAttempts} attempts.`, {
      cause: lastError,
    });
  }

  async function assertVisibleVaultChallenge(browser, redirect) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const challengeTimeoutMs = Math.min(timeoutMs, 60_000);
    page.setDefaultTimeout(challengeTimeoutMs);
    page.setDefaultNavigationTimeout(challengeTimeoutMs);
    const capture = attachMemoryOnlyCapture(page);
    try {
      // Authenticate the canonical reviewer through the test bridge, but do
      // not inject or submit the passphrase. This context must prove the app
      // itself presents the locked-vault challenge first.
      await installBridge(page, { includePassphrase: false });
      await page.goto(`${normalizedOrigin}/login?redirect=${encodeURIComponent(redirect)}`, {
        waitUntil: "domcontentloaded",
      });
      const unlockInput = page.locator("#unlock-passphrase");
      const deadline = Date.now() + challengeTimeoutMs;
      while (Date.now() < deadline) {
        capture.assertNoCriticalApiFailures("visible vault challenge");
        if (await unlockInput.isVisible().catch(() => false)) return;
        await page.waitForTimeout(250);
      }
      const diagnostics = await page.evaluate(() => ({
        path: `${window.location.pathname}${window.location.search}`,
        title: document.title,
        bootstrapState: window.__HUSHH_NATIVE_TEST__?.bootstrapState || "unknown",
        bootstrapErrorClass:
          window.__HUSHH_NATIVE_TEST__?.bootstrapErrorClass || "none",
      }));
      throw new Error(
        `Visible vault challenge timed out (path=${diagnostics.path}, title=${diagnostics.title || "unknown"}, state=${diagnostics.bootstrapState}, error_class=${diagnostics.bootstrapErrorClass}).`
      );
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async function fetchOwnerJson(pathname, ownerToken, { allow404 = false } = {}) {
    const response = await fetch(`${normalizedOrigin}${pathname}`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`${pathname} returned non-JSON HTTP ${response.status}.`);
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`${pathname} failed with HTTP ${response.status}.`);
    return payload;
  }

  return {
    assertVaultContinuity,
    assertVisibleVaultChallenge,
    chromium,
    endpointPath,
    fetchOwnerJson,
    navigateInApp,
    openSession,
    reviewerUid,
    vaultKeyCommitment,
  };
}
