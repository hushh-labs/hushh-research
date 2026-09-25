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
  "/api/one/agent-chat",
];

const READ_ONLY_SAFE_POST_PATHS = new Set([
  "/api/app-config/review-mode/session",
  "/api/vault/bootstrap-state",
  "/api/vault/pre-vault-state",
  // Authenticated metadata read; POST keeps consent tokens out of URLs.
  // db_proxy.get_vault_status only selects pkm_index.domain_summaries.
  "/api/vault/status",
  "/api/consent/vault-owner-token",
  // Next.js dev-server source-map lookups for console traces; dev-only tooling.
  "/__nextjs_original-stack-frames",
]);

// Unlock warming publishes only the current device's public ECDH recipient
// keys. These endpoints are idempotent bootstrap metadata, not consent, PKM,
// export, or decrypted-information writes. Preparation-only rehearsals must
// allow this exact readiness seam while continuing to block every other
// state-changing request.
const PREPARATION_SAFE_BOOTSTRAP_POST_PATHS = new Set([
  "/api/one/location/recipient-keys",
  "/api/one/marketplace/recipient-keys",
]);

// Firebase authentication hosts. The reviewer login handshake exchanges the
// review-mode session for a custom token and signs in through Identity
// Toolkit (signInWithCustomToken, accounts:lookup, token refresh). These are
// authentication, never a mutation of the shared fixture; blocking them made
// every read-only localhost rehearsal fail at the first boundary (2026-09-02).
const AUTH_ONLY_HOSTS = new Set([
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
]);

function requestHostname(request) {
  try {
    return new URL(request.url()).hostname;
  } catch {
    return "";
  }
}

function requestPathname(request) {
  return endpointPath(request.url());
}

export async function installReadOnlyMutationGuard(context, {
  appOrigin,
  allowMemoryPreparation = false,
  admitMutation = null,
} = {}) {
  const blockedMutations = [];
  if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true" && !admitMutation) {
    return {
      assertNoBlockedMutation() {},
      policy: "explicit_mutation_authorized",
    };
  }

  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const pathname = requestPathname(request);
    // Preparation sends source text for authorized processing but cannot save
    // Memory. Grant only this exact method/path/origin, not a mutation bypass.
    const memoryPreparation = allowMemoryPreparation && method === "POST" &&
      pathname === "/api/pkm/memory/proposals" &&
      new URL(request.url()).origin === appOrigin;
    const preparationBootstrap = allowMemoryPreparation &&
      method === "POST" &&
      PREPARATION_SAFE_BOOTSTRAP_POST_PATHS.has(pathname) &&
      new URL(request.url()).origin === appOrigin;
    if (
      !["POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      (method === "POST" && READ_ONLY_SAFE_POST_PATHS.has(pathname)
        && (!admitMutation || new URL(request.url()).origin === appOrigin)) ||
      memoryPreparation ||
      preparationBootstrap ||
      AUTH_ONLY_HOSTS.has(requestHostname(request))
    ) {
      await route.continue();
      return;
    }

    // A bounded rehearsal installs this policy before any page navigation,
    // including bootstrap retries and fresh contexts. Authorization is still
    // required; a callback cannot upgrade a read-only run.
    if (admitMutation && process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true"
      && new URL(request.url()).origin === appOrigin) {
      try {
        if (await admitMutation(request) === true) {
          await route.continue();
          return;
        }
      } catch { /* Refusal is retained below without request bodies or errors. */ }
    }

    blockedMutations.push(`${method} ${pathname || "(unknown path)"}`);
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "REVIEWER_READ_ONLY_MUTATION_BLOCKED",
        message: "Read-only reviewer rehearsal blocked a state-changing request.",
      }),
    });
  });

  return {
    assertNoBlockedMutation() {
      if (blockedMutations.length === 0) return;
      throw new Error(
        `Read-only reviewer rehearsal blocked state-changing request(s): ${blockedMutations.join(", ")}. Fix the app's test/read-only posture or use an isolated fixture with explicit mutation authority.`,
      );
    },
    policy: admitMutation ? "bounded_mutation" : allowMemoryPreparation ? "preparation_only" : "read_only",
  };
}

async function waitForValue(readValue, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export function shouldRetryReviewerBootstrap(error) {
  return error?.code !== "REVIEWER_TERMINAL_BOOTSTRAP";
}

/** A loaded route beacon can describe anonymous or locked UI, not admission. */
export async function waitForReviewerVaultAdmission(page, expectedUserId, timeoutMs = 60_000) {
  if (!expectedUserId) throw new Error("Reviewer admission requires a configured identity.");
  await page.waitForFunction((expected) => {
    const bridge = window.__HUSHH_NATIVE_TEST__;
    return bridge?.bootstrapState === "vault_unlocked" &&
      bridge?.bootstrapUserId === expected;
  }, expectedUserId, { timeout: timeoutMs });
}

export async function createReviewerSessionHarness({
  repoRoot,
  appOrigin = "https://uat.one.hushh.ai",
  timeoutMs = 360_000,
  allowMemoryPreparation = false,
  admitMutation = null,
  reviewerIdentity = /** @type {{ reviewerUid: string, reviewerVaultPassphrase: string } | null} */ (null),
}) {
  const webDir = path.join(repoRoot, "hushh-webapp");
  const requireFromWeb = createRequire(path.join(webDir, "package.json"));
  const { chromium } = requireFromWeb("playwright");
  const identityModule = await import(
    pathToFileURL(path.join(webDir, "scripts/testing/reviewer-test-identity.mjs")).href
  );
  const identity = reviewerIdentity ?? identityModule.resolveReviewerTestIdentity({
    envFiles: identityModule.defaultReviewerIdentityEnvFiles({ repoRoot, webDir }),
  });
  const reviewerUid = identity.reviewerUid;
  const reviewerPassphrase = identity.reviewerVaultPassphrase;
  if (!reviewerUid || !reviewerPassphrase) {
    throw new Error("Reviewer identity requires both configured values.");
  }
  const normalizedOrigin = String(appOrigin).replace(/\/$/, "");

  function vaultKeyCommitment(vaultState) {
    const commitment = String(vaultState?.vaultKeyHash || vaultState?.vault_key_hash || "");
    if (!commitment) {
      throw new Error("Reviewer vault state has no key commitment.");
    }
    return commitment;
  }

  async function installBridge(page, { includePassphrase = true } = {}) {
    const reviewerMutationPolicy = process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true"
      ? admitMutation ? "bounded_mutation" : "mutation_authorized"
      : allowMemoryPreparation
        ? "preparation_only"
        : "read_only";
    const reviewerAuthMode = process.env.REVIEWER_AUTH_MODE === "custom_token"
      ? "custom_token"
      : "local_credentials";
    await page.addInitScript(
      ({ expectedUserId, vaultPassphrase, reviewerMutationPolicy, reviewerAuthMode }) => {
        window.__HUSHH_NATIVE_TEST__ = {
          ...(window.__HUSHH_NATIVE_TEST__ || {}),
          enabled: true,
          autoReviewerLogin: true,
          expectedUserId,
          reviewerMutationPolicy,
          reviewerAuthMode,
          ...(vaultPassphrase ? { vaultPassphrase } : {}),
        };
      },
      {
        expectedUserId: reviewerUid,
        vaultPassphrase: includePassphrase ? reviewerPassphrase : "",
        reviewerMutationPolicy,
        reviewerAuthMode,
      }
    );
  }

  function attachMemoryOnlyCapture(page) {
    let vaultState = null;
    let ownerToken = "";
    let identityToken = "";
    const criticalApiFailures = [];
    const responsePromises = new Set();
    page.on("request", (request) => {
      const pathname = endpointPath(request.url());
      const authorization = request.headers().authorization || "";
      if (!authorization.startsWith("Bearer ")) return;
      if (pathname.startsWith("/api/pkm/")) ownerToken = authorization.slice(7);
      // Viewer-relative people/profile reads use the Firebase identity token
      // too, and may be the first identity-authenticated request in a
      // read-only rehearsal. Keep the vault-owner token scoped to PKM routes.
      if (
        pathname.startsWith("/api/one/connections") ||
        pathname.startsWith("/api/one/people/") ||
        pathname === "/api/one/models/preference"
      ) {
        identityToken = authorization.slice(7);
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
      async identityToken() {
        return waitForValue(() => identityToken, "reviewer identity token", timeoutMs);
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

  async function waitForUnlock(page, readOnlyGuard, unlockTimeoutMs = timeoutMs) {
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
          mismatchStage: String(bridge?.bootstrapDetail || "").split(":", 1)[0],
          path: window.location.pathname,
          userMatches: Boolean(bootstrapUserId && bootstrapUserId === expectedUserId),
        };
      }, reviewerUid);

    while (Date.now() < deadline) {
      readOnlyGuard.assertNoBlockedMutation();
      const bootstrap = await safeBootstrapState();
      if (bootstrap.state === "vault_unlocked" && bootstrap.userMatches) return;
      if (terminalFailures.has(bootstrap.state)) {
        const error = new Error(
          `Reviewer vault bootstrap failed (state=${bootstrap.state}, error_class=${bootstrap.errorClass || "unknown"}, stage=${["signin_result", "auth_context", "native_session", "vault_context"].includes(bootstrap.mismatchStage) ? bootstrap.mismatchStage : "unknown"}, path=${bootstrap.path}, user_match=${bootstrap.userMatches}).`
        );
        error.code = "REVIEWER_TERMINAL_BOOTSTRAP";
        throw error;
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
    if (state !== "vault_unlocked") {
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

  async function openSession(browser, redirect, { allowQueryMutation = false } = {}) {
    const maxAttempts = 3;
    const attemptTimeoutMs = Math.max(20_000, Math.floor(timeoutMs / maxAttempts));
    let lastError = null;
    const redirectUrl = new URL(redirect, normalizedOrigin);
    const expectedPath = redirectUrl.pathname;
    const expectedHref = `${redirectUrl.pathname}${redirectUrl.search}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const context = await browser.newContext({ baseURL: normalizedOrigin, viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(attemptTimeoutMs);
      page.setDefaultNavigationTimeout(attemptTimeoutMs);
      const readOnlyGuard = await installReadOnlyMutationGuard(context, { appOrigin: normalizedOrigin, allowMemoryPreparation, admitMutation });
      const capture = attachMemoryOnlyCapture(page);
      await installBridge(page);
      try {
        await page.goto(`${normalizedOrigin}/login?redirect=${encodeURIComponent(redirect)}`, {
          waitUntil: "domcontentloaded",
        });
        await waitForUnlock(page, readOnlyGuard, attemptTimeoutMs);
        // Unlock can finish before the login component's pending redirect.
        // Do not race that redirect with the first same-session navigation.
        await page.waitForFunction(
          ({ targetPath, targetHref, queryMayChange }) =>
            queryMayChange
              ? window.location.pathname === targetPath
              : `${window.location.pathname}${window.location.search}` === targetHref,
          {
            targetPath: expectedPath,
            targetHref: expectedHref,
            queryMayChange: allowQueryMutation,
          },
          { timeout: attemptTimeoutMs },
        );
        return { context, page, capture, readOnlyGuard };
      } catch (error) {
        lastError = error;
        await context.close().catch(() => undefined);
        if (!shouldRetryReviewerBootstrap(error)) throw error;
      }
    }

    const causeMessage = lastError?.cause instanceof Error
      ? lastError.cause.message.replace(/\s+/g, " ").slice(0, 200)
      : "";
    throw new Error(
      `Reviewer session bootstrap failed after ${maxAttempts} attempts.${causeMessage ? ` cause=${causeMessage}` : ""}`,
      {
      cause: lastError,
      },
    );
  }

  async function assertVisibleVaultChallenge(browser, redirect) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const challengeTimeoutMs = Math.min(timeoutMs, 60_000);
    page.setDefaultTimeout(challengeTimeoutMs);
    page.setDefaultNavigationTimeout(challengeTimeoutMs);
    const readOnlyGuard = await installReadOnlyMutationGuard(context, { appOrigin: normalizedOrigin, allowMemoryPreparation, admitMutation });
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
        readOnlyGuard.assertNoBlockedMutation();
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
        openingChat: document.body.textContent?.includes("Opening chat…") === true,
        unlockHeading: document.body.textContent?.includes("Unlock One") === true,
      }));
      throw new Error(
        `Visible vault challenge timed out (path=${diagnostics.path}, title=${diagnostics.title || "unknown"}, state=${diagnostics.bootstrapState}, error_class=${diagnostics.bootstrapErrorClass}, opening_chat=${diagnostics.openingChat}, unlock_heading=${diagnostics.unlockHeading}).`
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
