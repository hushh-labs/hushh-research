#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(
  process.env.REVIEWER_APP_ORIGIN || "http://127.0.0.1:3000",
).replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const prompt = "In one sentence, explain the consent lifecycle.";
const forbiddenText = [
  "one_adk_sessions",
  "DB operation failed",
  "[SQL:",
  "parameters:",
  "payload_ciphertext",
  "psycopg2",
];

if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS !== "true") {
  throw new Error(
    "Agent Chat rehearsal creates a conversation. Set REVIEWER_ALLOW_SHARED_MUTATIONS=true only with explicit mutation authority.",
  );
}

await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
});
let session;
let ownerToken = "";
let baselineConversationIds = new Set();

async function conversationIds(token) {
  const response = await fetch(
    `${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Conversation inventory failed with HTTP ${response.status}.`);
  const payload = await response.json();
  return new Set((payload.conversations || []).map((item) => String(item.id)));
}

try {
  session = await reviewer.openSession(browser, "/agent");
  const { page } = session;
  ownerToken = await session.capture.ownerToken();
  baselineConversationIds = await conversationIds(ownerToken);
  await page.getByTestId("agent-chat-composer-textarea").waitFor({ state: "visible" });
  const baselineAssistantTurns = await page.locator('[data-message-role="assistant"]').count();
  await page.getByTestId("agent-chat-composer-textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await page.getByTestId("agent-chat-self-avatar").last().waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ expectedPrompt, forbidden, baselineCount }) => {
      const body = document.body.innerText;
      const promptDelivered = body.includes(expectedPrompt);
      const leaked = forbidden.some((value) => body.includes(value));
      const assistantTurns = [
        ...document.querySelectorAll('[data-message-role="assistant"]'),
      ];
      const latest = assistantTurns.at(-1);
      const settled = latest?.getAttribute("data-message-status") !== "streaming";
      return promptDelivered && assistantTurns.length > baselineCount && settled && Boolean(latest?.textContent?.trim()) && !leaked;
    },
    { expectedPrompt: prompt, forbidden: forbiddenText, baselineCount: baselineAssistantTurns },
    { timeout: timeoutMs },
  );

  const result = await page.evaluate((forbidden) => {
    const body = document.body.innerText;
    const selfAvatars = [...document.querySelectorAll('[data-testid="agent-chat-self-avatar"]')];
    const selfAvatar = selfAvatars.at(-1);
    const avatarImage = selfAvatar?.querySelector("img");
    const voice = document.querySelector('[aria-label="Start voice mode"]')?.getBoundingClientRect();
    const send = document.querySelector('[aria-label="Send message"]')?.getBoundingClientRect();
    return {
      rawErrorLeak: forbidden.some((value) => body.includes(value)),
      idleReadyVisible: /(^|\n)Ready($|\n)/.test(body),
      selfAvatarVisible: Boolean(selfAvatar),
      selfAvatarImageOrFallback: Boolean(avatarImage || selfAvatar?.textContent?.trim()),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      composerControlGeometry:
        Boolean(voice && send) &&
        Math.abs(voice.width - send.width) <= 1 &&
        Math.abs(voice.height - send.height) <= 1 &&
        Math.abs(voice.y + voice.height / 2 - (send.y + send.height / 2)) <= 1,
    };
  }, forbiddenText);

  if (result.rawErrorLeak) throw new Error("Agent Chat exposed an internal runtime error.");
  if (result.idleReadyVisible) throw new Error("Agent Chat still exposes the idle Ready badge.");
  if (!result.selfAvatarVisible || !result.selfAvatarImageOrFallback) {
    throw new Error("Agent Chat did not render the canonical self avatar or fallback.");
  }
  if (result.horizontalOverflow) throw new Error("Agent Chat has horizontal overflow.");
  if (!result.composerControlGeometry) {
    throw new Error("Agent Chat composer controls are not geometrically symmetric.");
  }
  session.capture.assertNoCriticalApiFailures("agent chat prompt round-trip");
  process.stdout.write(
    "[reviewer-app-testing] PASS agent_chat_round_trip=1 raw_error_leak=0 idle_ready=0 self_avatar=1 horizontal_overflow=0 composer_control_symmetry=1\n",
  );
} finally {
  if (ownerToken) {
    const currentIds = await conversationIds(ownerToken).catch(() => new Set());
    const createdIds = [...currentIds].filter((id) => !baselineConversationIds.has(id));
    await Promise.all(
      createdIds.map((id) =>
        fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
        }).catch(() => undefined),
      ),
    );
  }
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
