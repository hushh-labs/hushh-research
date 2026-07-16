import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
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

function decodeBinary(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Encrypted binary field is empty.");
  if (text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text) && !/[+/=_-]/.test(text)) {
    return Buffer.from(text, "hex");
  }
  let normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  return Buffer.from(normalized, "base64");
}

export function decryptAesGcm({ ciphertext, iv, tag }, key) {
  const encrypted = decodeBinary(ciphertext);
  const authTag = tag ? decodeBinary(tag) : encrypted.subarray(encrypted.length - 16);
  const body = tag ? encrypted : encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, decodeBinary(iv));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
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

  function deriveVaultKey(vaultState) {
    const wrappers = Array.isArray(vaultState?.wrappers) ? vaultState.wrappers : [];
    const wrapper = wrappers.find(
      (candidate) => String(candidate?.method || "").toLowerCase() === "passphrase"
    );
    if (!wrapper) throw new Error("Reviewer vault has no passphrase wrapper.");
    const derived = pbkdf2Sync(
      Buffer.from(reviewerPassphrase, "utf8"),
      decodeBinary(wrapper.salt),
      100_000,
      32,
      "sha256"
    );
    let vaultKey;
    try {
      vaultKey = decryptAesGcm(
        {
          ciphertext: wrapper.encryptedVaultKey || wrapper.encrypted_vault_key,
          iv: wrapper.iv,
        },
        derived
      );
    } finally {
      derived.fill(0);
    }
    if (vaultKey.length !== 32) throw new Error("Reviewer vault key is not 256 bits.");
    const expectedHash = String(vaultState.vaultKeyHash || vaultState.vault_key_hash || "");
    if (expectedHash) {
      const actualHash = createHash("sha256")
        .update(vaultKey.toString("hex"), "utf8")
        .digest("hex");
      if (actualHash !== expectedHash) {
        throw new Error("Reviewer vault key integrity check failed.");
      }
    }
    return vaultKey;
  }

  async function installBridge(page) {
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
      { expectedUserId: reviewerUid, vaultPassphrase: reviewerPassphrase }
    );
  }

  function attachMemoryOnlyCapture(page) {
    let vaultState = null;
    let ownerToken = "";
    const responsePromises = new Set();
    page.on("request", (request) => {
      if (!endpointPath(request.url()).startsWith("/api/pkm/")) return;
      const authorization = request.headers().authorization || "";
      if (authorization.startsWith("Bearer ")) ownerToken = authorization.slice(7);
    });
    page.on("response", (response) => {
      if (endpointPath(response.url()) !== "/api/vault/get" || !response.ok()) return;
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
      async vaultState() {
        const state = await waitForValue(() => vaultState, "encrypted vault state", timeoutMs);
        await Promise.all([...responsePromises]);
        return state;
      },
    };
  }

  async function waitForUnlock(page) {
    const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
    if (await reviewerButton.isVisible().catch(() => false)) await reviewerButton.click();
    await page.waitForFunction(
      (expectedUserId) => {
        const bridge = window.__HUSHH_NATIVE_TEST__;
        return (
          bridge?.bootstrapState === "vault_unlocked" &&
          bridge?.bootstrapUserId === expectedUserId
        );
      },
      reviewerUid,
      { timeout: timeoutMs }
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    const capture = attachMemoryOnlyCapture(page);
    await installBridge(page);
    await page.goto(`${normalizedOrigin}/login?redirect=${encodeURIComponent(redirect)}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForUnlock(page);
    return { context, page, capture };
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
    chromium,
    deriveVaultKey,
    endpointPath,
    fetchOwnerJson,
    navigateInApp,
    openSession,
    reviewerUid,
  };
}
