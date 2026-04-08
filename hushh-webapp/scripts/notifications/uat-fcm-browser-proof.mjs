#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

function parseJsonFromStdout(stdout) {
  const lines = String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Scan for the last JSON object in stdout.
    }
  }
  throw new Error(`Could not parse JSON from stdout:\n${stdout}`);
}

function urlsMatch(currentUrl, expectedUrl) {
  const current = new URL(currentUrl);
  const expected = new URL(expectedUrl);
  return current.pathname === expected.pathname && current.search === expected.search;
}

async function waitForContextNavigation(context, expectedUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matchedPage = context.pages().find((candidate) => {
      try {
        return urlsMatch(candidate.url(), expectedUrl);
      } catch {
        return false;
      }
    });
    if (matchedPage) {
      await matchedPage.waitForLoadState("domcontentloaded").catch(() => {});
      return matchedPage;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function main() {
  const origin = (process.env.HUSHH_UAT_ORIGIN || "https://uat.kai.hushh.ai").replace(/\/$/, "");
  const backendUrl = (process.env.HUSHH_UAT_BACKEND_URL || "https://api.uat.hushh.ai").replace(
    /\/$/,
    ""
  );
  const startUrl = process.env.HUSHH_UAT_START_URL || `${origin}/login`;
  const requestUrl = process.env.HUSHH_UAT_NOTIFICATION_TARGET || `${origin}/consents?tab=pending`;
  const passphrase = process.env.HUSHH_KAI_TEST_PASSPHRASE || "test#123";
  const protocolEnv =
    process.env.HUSHH_PROTOCOL_ENV || path.join(repoRoot, "consent-protocol", ".env");
  const webEnv =
    process.env.HUSHH_WEB_ENV || path.join(repoRoot, "hushh-webapp", ".env.uat.local");
  const headless = envFlag("HEADLESS", false);
  const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;

  const uniqueSuffix = String(Date.now());
  const notificationTag = `uat-browser-proof:${uniqueSuffix}`;
  const notificationTitle = `UAT browser proof ${uniqueSuffix}`;
  const notificationBody = `Playwright verification ${uniqueSuffix}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-fcm-proof-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel,
      serviceWorkers: "allow",
    });
    await context.grantPermissions(["notifications"], { origin });

    await context.addInitScript(() => {
      window.__HUSHH_FCM_TEST__ = {
        swMessages: [],
      };
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", (event) => {
          const data = event.data || {};
          if (typeof data.type === "string" && data.type.startsWith("hushh:fcm_")) {
            window.__HUSHH_FCM_TEST__.swMessages.push({
              ...data,
              receivedAt: Date.now(),
            });
          }
        });
      }
    });

    const page = context.pages()[0] || (await context.newPage());
    const consoleLogs = [];
    const registerResponses = [];

    page.on("console", async (message) => {
      const text = message.text();
      consoleLogs.push(text);
    });

    page.on("response", async (response) => {
      if (!response.url().includes("/api/notifications/register")) return;
      registerResponses.push({
        url: response.url(),
        status: response.status(),
        body: await response.text().catch(() => ""),
      });
    });

    await page.goto(startUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /continue as reviewer/i }).click();

    const unlockInput = page.locator("#unlock-passphrase");
    await unlockInput.waitFor({ state: "visible", timeout: 60000 });
    await unlockInput.fill(passphrase);
    await page.getByRole("button", { name: /unlock with passphrase/i }).click();
    await unlockInput.waitFor({ state: "hidden", timeout: 60000 });

    await page.waitForFunction(() => Notification.permission === "granted", undefined, {
      timeout: 30000,
    });

    await page.waitForFunction(
      () =>
        Array.isArray(window.__HUSHH_FCM_TEST__?.swMessages),
      undefined,
      { timeout: 10000 }
    );

    const registerDeadline = Date.now() + 30000;
    while (
      !registerResponses.some((entry) => entry.status === 200) &&
      Date.now() < registerDeadline
    ) {
      await page.waitForTimeout(500);
    }
    if (!registerResponses.some((entry) => entry.status === 200)) {
      throw new Error(
        `Push token registration did not complete successfully. Responses: ${JSON.stringify(registerResponses)}`
      );
    }

    const pushStdout = execFileSync(
      "python3",
      [
        path.join(repoRoot, "consent-protocol", "scripts", "uat_kai_regression_smoke.py"),
        "--scenario",
        "push_delivery",
        "--backend-url",
        backendUrl,
        "--protocol-env",
        protocolEnv,
        "--web-env",
        webEnv,
        "--push-platform",
        "web",
        "--push-title",
        notificationTitle,
        "--push-body",
        notificationBody,
        "--request-url",
        requestUrl,
        "--notification-tag",
        notificationTag,
        "--json",
      ],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const pushResult = parseJsonFromStdout(pushStdout);

    await page.waitForFunction(
      (expectedTag) =>
        Array.isArray(window.__HUSHH_FCM_TEST__?.swMessages) &&
        window.__HUSHH_FCM_TEST__.swMessages.some(
          (message) =>
            message.type === "hushh:fcm_push_received" &&
            message.tag === expectedTag
        ),
      notificationTag,
      { timeout: 45000 }
    );

    const proof = await page.evaluate(async ({ expectedTag, expectedTitle }) => {
      const registration = await navigator.serviceWorker.ready;
      const notifications = await registration.getNotifications();
      const matched = notifications.find((notification) => notification.tag === expectedTag);
      return {
        permission: Notification.permission,
        serviceWorker: {
          scope: registration.scope,
          active: Boolean(registration.active),
        },
        notificationCount: notifications.length,
        matchedNotification: matched
          ? {
              title: matched.title,
              tag: matched.tag,
              body: matched.body,
              data: matched.data ?? null,
            }
          : null,
        pushMessages: window.__HUSHH_FCM_TEST__.swMessages,
        currentUrl: window.location.href,
        matchedTitle: matched?.title === expectedTitle,
      };
    }, { expectedTag: notificationTag, expectedTitle: notificationTitle });

    if (!proof.matchedNotification) {
      throw new Error(`No service-worker notification found for tag ${notificationTag}`);
    }

    await page.evaluate(async (url) => {
      const registration = await navigator.serviceWorker.ready;
      const target =
        navigator.serviceWorker.controller || registration.active || registration.waiting;
      if (!target) {
        throw new Error("No active service worker available for notification click proof");
      }
      target.postMessage({
        type: "hushh:test_notification_click",
        url,
      });
    }, requestUrl);

    await page.waitForFunction(
      () =>
        window.__HUSHH_FCM_TEST__.swMessages.some(
          (message) => message.type === "hushh:fcm_notification_clicked"
        ),
      undefined,
      { timeout: 10000 }
    );

    const clickedEvent = await page.evaluate(() =>
      window.__HUSHH_FCM_TEST__.swMessages.find(
        (message) => message.type === "hushh:fcm_notification_clicked"
      ) || null
    );

    if (!clickedEvent || clickedEvent.url !== requestUrl) {
      throw new Error(
        `Synthetic click did not emit the expected target URL. Event: ${JSON.stringify(clickedEvent)}`
      );
    }

    const navigatedPage = await waitForContextNavigation(context, requestUrl, 5000);

    const result = {
      origin,
      backendUrl,
      startUrl,
      requestUrl,
      pushResult,
      proof,
      clickedEvent,
      registerResponses,
      consoleLogs,
      syntheticClickNavigationObserved: Boolean(navigatedPage),
      routedUrl: navigatedPage?.url() ?? null,
      openPages: context.pages().map((candidate) => candidate.url()),
      manualProofRequired:
        "Real browser notification click navigation must still be verified manually because synthetic service-worker click events do not trigger browser page routing in Chromium.",
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context?.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
