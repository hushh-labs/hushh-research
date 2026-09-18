import { test, expect } from "@playwright/test";

const reviewer1PersonRef = "5d6020b2-95f3-4b30-b7a7-e4b60b4a039e";
const appOrigin = process.env.BASE_URL || "http://localhost:3001";
const reviewerUid = process.env.REVIEWER_UID?.trim() || "";
const reviewerPassphrase = process.env.REVIEWER_VAULT_PASSPHRASE || "";

test("Auto-decrypted shared information card and agent chat consent lifecycle", async ({ page }, testInfo) => {
  test.skip(
    !reviewerUid || !reviewerPassphrase,
    "Requires REVIEWER_UID and REVIEWER_VAULT_PASSPHRASE from the maintainer-only test environment.",
  );
  test.setTimeout(180_000);

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
      expectedUserId: reviewerUid,
      vaultPassphrase: reviewerPassphrase,
    },
  );

  const targetProfileUrl = `${appOrigin}/people/${reviewer1PersonRef}?section=shared#shared-with-you`;
  console.log("1. Navigating to login with redirect to shared profile on port 3001:", targetProfileUrl);

  await page.goto(`${appOrigin}/login?redirect=${encodeURIComponent(`/people/${reviewer1PersonRef}?section=shared#shared-with-you`)}`, {
    waitUntil: "domcontentloaded",
  });

  const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
  if (await reviewerButton.isVisible({ timeout: 6000 }).catch(() => false)) {
    console.log("Clicking Continue as Reviewer...");
    await reviewerButton.click();
  }

  const unlockInput = page.locator("#unlock-passphrase");
  const unlockButton = page.getByRole("button", { name: /unlock with passphrase/i }).first();
  const deadline = Date.now() + 90_000;
  let manualUnlockSubmitted = false;

  while (Date.now() < deadline) {
    const bootstrap = await page.evaluate(() => ({
      state: String(window.__HUSHH_NATIVE_TEST__?.bootstrapState || ""),
    }));
    if (bootstrap.state === "vault_unlocked") break;
    if (!manualUnlockSubmitted && (await unlockInput.isVisible().catch(() => false))) {
      console.log("Filling vault passphrase and unlocking...");
      await unlockInput.fill(reviewerPassphrase);
      if (await unlockButton.isEnabled().catch(() => false)) {
        await unlockButton.click({ noWaitAfter: true });
        manualUnlockSubmitted = true;
      }
    }
    await page.waitForTimeout(300);
  }

  console.log("Waiting for person profile route to render...");
  await page.waitForURL((url) => url.pathname.includes("/people/"), { timeout: 30_000 });

  console.log("Profile rendered. Waiting for auto-decryption value to appear...");
  // Wait for the decrypted value container to render
  const decryptedValue = page.locator('[data-testid="person-profile-grant-value"]').first();
  await decryptedValue.waitFor({ state: "visible", timeout: 45_000 });

  // Let animations and structured tags settle
  await page.waitForTimeout(3000);

  console.log("Capturing reviewer_profile_shared_rich_ui.png...");
  await page.screenshot({
    path: testInfo.outputPath("reviewer_profile_shared_rich_ui.png"),
    fullPage: false,
  });
  console.log("Saved rich UI screenshot.");

  // Flow 2: Navigate to Chat and test consent lifecycle
  console.log("2. Navigating to Chat via client navigation...");
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("app-internal-navigation-requested", {
        detail: { href: "/", scroll: false },
      }),
    );
  });

  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await page.waitForTimeout(4000);

  const composer = page.locator('[data-testid="agent-chat-composer-textarea"]').first();
  await composer.waitFor({ state: "visible", timeout: 25_000 });

  test.setTimeout(240_000);
  console.log("Sending: 'What has Reviewer 1 shared with me?'");
  await composer.fill("What has Reviewer 1 shared with me?");
  await page.waitForTimeout(500);
  const sendBtn = page.locator('button[aria-label="Send message"]').first();
  if (await sendBtn.isEnabled().catch(() => false)) {
    await sendBtn.click();
  } else {
    await composer.press("Enter");
  }

  console.log("Waiting for One's response in chat (allowing ADK tool calls to complete)...");
  await page.waitForTimeout(32_000);

  console.log("Sending: 'Ask Reviewer 1 to share their backend stack'");
  await composer.fill("Ask Reviewer 1 to share their backend stack");
  await page.waitForTimeout(500);
  if (await sendBtn.isEnabled().catch(() => false)) {
    await sendBtn.click();
  } else {
    await composer.press("Enter");
  }

  console.log("Waiting for prompt queue to drain and One's second response...");
  const promptQueue = page.locator('[data-testid="agent-chat-prompt-queue"]');
  if (await promptQueue.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("Queue is visible, waiting for it to drain...");
    await promptQueue.waitFor({ state: "hidden", timeout: 50_000 }).catch(() => {
      console.log("Queue drain wait elapsed");
    });
  }

  console.log("Waiting for One's second response to finish thinking and render...");
  // Wait for the Thinking indicator to complete
  await page.locator('text=Thinking').waitFor({ state: "hidden", timeout: 45_000 }).catch(() => {
    console.log("Thinking indicator wait elapsed");
  });

  await page.waitForTimeout(3000);

  console.log("Scrolling chat to bottom to show complete lifecycle...");
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const scrollables = document.querySelectorAll('div[class*="overflow-y-auto"]');
    scrollables.forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  });

  await page.waitForTimeout(1500);

  console.log("Capturing agent_chat_consent_lifecycle.png...");
  await page.screenshot({
    path: testInfo.outputPath("agent_chat_consent_lifecycle.png"),
    fullPage: false,
  });
  console.log("Saved agent chat screenshot.");
});
