import { resolveReviewerAuthMode, isHumanReviewerAuthenticationRequest } from "../../../../hushh-webapp/lib/testing/reviewer-authentication-policy.mjs";
import { createReviewerBootstrap } from "./reviewer-session-bootstrap.mjs";
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
  reviewerAuthMode = resolveReviewerAuthMode(process.env.REVIEWER_AUTH_MODE),
} = {}) {
  const blockedMutations = [];
  let suppressedAnalytics = 0;
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
    const hostname = requestHostname(request);
    if (method === "POST" && pathname === "/g/collect" &&
      (hostname === "www.google-analytics.com" ||
        hostname === "region1.google-analytics.com" ||
        hostname === "analytics.google.com")) {
      suppressedAnalytics += 1;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    // Chat automatically asks for this optional card, but the backend records
    // an offer in one_attention_ledger. A read-only rehearsal must not consume
    // the shared reviewer's first-connection offer. Return the documented
    // no-card result without forwarding the request; this is not a general
    // POST exemption or proof of the insights feature.
    if (method === "POST" && pathname === "/api/one/first-connect-insights" &&
      new URL(request.url()).origin === appOrigin) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "unavailable" }),
      });
      return;
    }
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
        && (reviewerAuthMode !== "human_authenticated" ||
          pathname !== "/api/app-config/review-mode/session")
        && (reviewerAuthMode !== "operator_issued_token" ||
          pathname !== "/api/app-config/review-mode/session")
        && ((!admitMutation && reviewerAuthMode !== "human_authenticated") ||
          new URL(request.url()).origin === appOrigin)) ||
      memoryPreparation ||
      preparationBootstrap ||
      (reviewerAuthMode === "human_authenticated"
        ? isHumanReviewerAuthenticationRequest(request.url(), method)
        : AUTH_ONLY_HOSTS.has(requestHostname(request)))
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
    suppressedAnalyticsRequests() { return suppressedAnalytics; },
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
  reviewerTokenProvider = /** @type {((uid: string) => Promise<string>) | null} */ (null),
}) {
  const webDir = path.join(repoRoot, "hushh-webapp");
  const requireFromWeb = createRequire(path.join(webDir, "package.json"));
  const { chromium } = requireFromWeb("playwright");
  const identityModule = await import(
    pathToFileURL(path.join(webDir, "scripts/testing/reviewer-test-identity.mjs")).href
  );
  const reviewerAuthMode = resolveReviewerAuthMode(process.env.REVIEWER_AUTH_MODE);
  const humanAuthenticated = reviewerAuthMode === "human_authenticated";
  const operatorIssued = reviewerAuthMode === "operator_issued_token";
  if (operatorIssued !== (typeof reviewerTokenProvider === "function")) {
    throw new Error("Operator reviewer authentication requires its explicit token provider.");
  }
  const identity = reviewerIdentity ?? identityModule.resolveReviewerTestIdentity({
    requireVaultPassphrase: !humanAuthenticated,
    envFiles: operatorIssued || humanAuthenticated ? [] : identityModule.defaultReviewerIdentityEnvFiles({ repoRoot, webDir }),
  });
  const reviewerUid = identity.reviewerUid;
  const reviewerPassphrase = humanAuthenticated ? "" : identity.reviewerVaultPassphrase;
  if (!reviewerUid || !humanAuthenticated && !reviewerPassphrase) {
    throw new Error("Reviewer identity requires both configured values.");
  }
  const normalizedOrigin = String(appOrigin).replace(/\/$/, "");
  const { installBridge, waitForUnlock } = createReviewerBootstrap({
    reviewerUid, reviewerPassphrase, reviewerAuthMode, allowMemoryPreparation,
    admitMutation, deferLegalAcceptance, timeoutMs,
    appOrigin: normalizedOrigin, reviewerTokenProvider,
  });

  function vaultKeyCommitment(vaultState) {
    const commitment = String(vaultState?.vaultKeyHash || vaultState?.vault_key_hash || "");
    if (!commitment) {
      throw new Error("Reviewer vault state has no key commitment.");
    }
    return commitment;
  }


  function attachMemoryOnlyCapture(page) {
    let vaultState = null;
    let ownerToken = "";
    let identityToken = "";
    // The app's own derived chat key (X-Hussh-Chat-Key), kept in memory only so
    // a rehearsal can read the history it just wrote. Never printed.
    let chatKey = "";
    const criticalApiFailures = [];
    const responsePromises = new Set();
    page.on("request", async (request) => {
      const pathname = endpointPath(request.url());
      const headers = await request.allHeaders().catch(() => ({}));
      const sentChatKey = headers["x-hussh-chat-key"] || "";
      if (sentChatKey) chatKey = sentChatKey;
      const authorization = headers.authorization || "";
      if (!authorization.startsWith("Bearer ")) return;
      if (pathname.startsWith("/api/pkm/")) ownerToken = authorization.slice(7);
      // Viewer-relative people/profile reads use the Firebase identity token
      // too, and may be the first identity-authenticated request in a
      // read-only rehearsal. Keep the vault-owner token scoped to PKM routes.
      if (
        pathname.startsWith("/api/one/connections") ||
        pathname.startsWith("/api/one/people/") ||
        pathname === "/api/one/models/preference" ||
        pathname === "/api/one/personal-agent/endpoint" ||
        pathname === "/api/one/personal-agent/status" ||
        pathname === "/api/account/trusted-devices" ||
        pathname === "/api/one/profile-discovery"
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
      async chatKey() {
        return waitForValue(() => chatKey, "chat key", timeoutMs);
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

  async function deferLegalAcceptance(page) {
    const dialog = page.getByRole("dialog", {
      name: /^(Terms and Privacy Policy|We updated our Terms and Privacy Policy)$/,
    });
    if (await dialog.isVisible().catch(() => false)) {
      try {
        await dialog.getByRole("button", { name: "Not now", exact: true }).click({ timeout: 2_000 });
      } catch (error) {
        // Authentication can unmount this optional prompt during the click.
        // A prompt that remains visible must still be explicitly deferred.
        if (await dialog.isVisible()) throw error;
      }
    }
  }


  async function assertVaultContinuity(page, label) {
    await deferLegalAcceptance(page);
    const unlockVisible = await page.locator("#unlock-passphrase").isVisible().catch(() => false);
    if (unlockVisible) throw new Error(`${label} lost the reviewer vault key.`);
    const bootstrap = await page.evaluate((expectedUid) => ({
      state: window.__HUSHH_NATIVE_TEST__?.bootstrapState || "",
      userMatches: window.__HUSHH_NATIVE_TEST__?.bootstrapUserId === expectedUid,
    }), reviewerUid);
    if (bootstrap.state !== "vault_unlocked" || !bootstrap.userMatches) {
      throw new Error(`${label} lost the owner-bound unlocked vault session.`);
    }
  }

  async function assertAuthenticatedContinuity(page, label) {
    const bootstrap = await page.evaluate((expectedUserId) => {
      const bridge = window.__HUSHH_NATIVE_TEST__;
      return {
        state: String(bridge?.bootstrapState || ""),
        userMatches: bridge?.bootstrapUserId === expectedUserId,
      };
    }, reviewerUid);
    if (!bootstrap.userMatches ||
      !["authenticated", "vault_unlocked"].includes(bootstrap.state)) {
      throw new Error(`${label} lost the expected reviewer session.`);
    }
  }

  async function navigateInApp(page, href, { requireVaultUnlocked = true } = {}) {
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
    if (requireVaultUnlocked) await assertVaultContinuity(page, href);
    else await assertAuthenticatedContinuity(page, href);
  }

  async function openSession(browser, redirect, {
    allowQueryMutation = false,
    requireVaultUnlocked = true,
    onPageCreated,
  } = {}) {
    const maxAttempts = humanAuthenticated || operatorIssued ? 1 : 3;
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
      try {
        const readOnlyGuard = await installReadOnlyMutationGuard(context, { appOrigin: normalizedOrigin, allowMemoryPreparation, admitMutation, reviewerAuthMode });
        const capture = attachMemoryOnlyCapture(page);
        await installBridge(page, { includePassphrase: requireVaultUnlocked });
        if (onPageCreated) onPageCreated(page);
        await page.goto(`${normalizedOrigin}/login?redirect=${encodeURIComponent(redirect)}`, {
          waitUntil: "domcontentloaded",
        });
        await waitForUnlock(page, readOnlyGuard, attemptTimeoutMs, requireVaultUnlocked);
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
    const readOnlyGuard = await installReadOnlyMutationGuard(context, { appOrigin: normalizedOrigin, allowMemoryPreparation, admitMutation, reviewerAuthMode });
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
        await deferLegalAcceptance(page);
        capture.assertNoCriticalApiFailures("visible vault challenge");
        const owner = await page.evaluate(expectedUid => ({
          matches: window.__HUSHH_NATIVE_TEST__?.bootstrapUserId === expectedUid,
          state: window.__HUSHH_NATIVE_TEST__?.bootstrapState,
        }), reviewerUid);
        if (["auth_error", "uid_mismatch", "vault_error"].includes(owner.state)) {
          throw new Error("Visible vault challenge lost expected reviewer authentication.");
        }
        if (owner.matches && owner.state === "authenticated" &&
            await unlockInput.isVisible().catch(() => false)) return;
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
    assertAuthenticatedContinuity,
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
