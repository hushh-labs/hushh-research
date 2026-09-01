#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const outputDir = path.resolve(
  process.env.REVIEWER_SCREENSHOT_DIR || path.join(repoRoot, "tmp/agent-one-verification"),
);
const syntheticImport = Array.from(
  { length: 14 },
  (_, index) => `${index + 1}. Example domain ${index + 1}\n- Synthetic fact ${index + 1} for memory review only.`,
).join("\n\n");
const chatPrompt = "In one sentence, explain the consent lifecycle.";

if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS !== "true") {
  throw new Error("Screenshot rehearsal creates a temporary conversation. Explicit mutation authority is required.");
}

await prepareReviewerRehearsal({ repoRoot, appOrigin });
fs.mkdirSync(outputDir, { recursive: true });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin });
const browser = await reviewer.chromium.launch({ headless: true });
let session;
let ownerToken = "";
let baselineConversationIds = new Set();

async function conversationIds(token) {
  const response = await fetch(
    `${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) return new Set();
  const payload = await response.json();
  return new Set((payload.conversations || []).map((item) => String(item.id)));
}

try {
  session = await reviewer.openSession(browser, "/agent");
  let { page } = session;
  ownerToken = await session.capture.ownerToken();
  baselineConversationIds = await conversationIds(ownerToken);
  const newChat = page.getByRole("button", { name: /New chat/i }).first();
  if (await newChat.isVisible().catch(() => false)) await newChat.click();
  const composer = page.getByTestId("agent-chat-composer-textarea");
  await composer.fill(syntheticImport);
  await composer.evaluate((element, text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, syntheticImport);
  await page.getByTestId("agent-chat-paste-purpose").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: path.join(outputDir, "01-memory-import-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(outputDir, "02-memory-import-mobile.png"),
    fullPage: false,
  });

  await session.context.close();
  session = await reviewer.openSession(browser, "/agent");
  page = session.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  const chatComposer = page.getByTestId("agent-chat-composer-textarea");
  await chatComposer.fill(chatPrompt);
  const baselineTurns = await page.locator('[data-message-role="assistant"]').count();
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(
    (baseline) => {
      const turns = [...document.querySelectorAll('[data-message-role="assistant"]')];
      const latest = turns.at(-1);
      return turns.length > baseline && latest?.getAttribute("data-message-status") !== "streaming" && Boolean(latest?.textContent?.trim());
    },
    baselineTurns,
    { timeout: 360_000 },
  );
  const activity = page.locator('[data-message-role="assistant"]').last().getByRole("button", { name: /Activity/i });
  if (await activity.isVisible().catch(() => false)) await activity.click();
  const latestTurn = page.locator('[data-message-role="assistant"]').last();
  for (const [name, width, height] of [
    ["03-agent-answer-desktop.png", 1440, 900],
    ["04-agent-answer-tablet.png", 768, 1024],
    ["05-agent-answer-mobile.png", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await latestTurn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outputDir, name), fullPage: false });
  }
  process.stdout.write(
    `[reviewer-app-testing] PASS sanitized_screenshots=5 output_dir=${path.relative(repoRoot, outputDir)}\n`,
  );
} finally {
  if (ownerToken) {
    const currentIds = await conversationIds(ownerToken).catch(() => new Set());
    const createdIds = [...currentIds].filter((id) => !baselineConversationIds.has(id));
    await Promise.all(createdIds.map((id) =>
      fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
      }).catch(() => undefined),
    ));
  }
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
