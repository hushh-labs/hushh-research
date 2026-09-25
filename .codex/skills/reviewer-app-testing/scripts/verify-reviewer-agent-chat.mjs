#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { installConsentStreamProbe } from "./consent-rehearsal-stream-probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(
  process.env.REVIEWER_APP_ORIGIN || "http://127.0.0.1:3000",
).replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const scenario = process.env.REVIEWER_AGENT_CHAT_SCENARIO || "baseline";
if (!["baseline", "private_connector_setup", "drive_connector_setup"].includes(scenario)) {
  throw new Error("Unsupported reviewer Agent Chat scenario.");
}
const prompt = scenario === "private_connector_setup"
  ? "I want to connect a private app to One. Show me how to open my connectors."
  : scenario === "drive_connector_setup"
    ? "Connect Google Drive to One so I can search my files."
    : "In one sentence, explain the consent lifecycle.";
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

async function driveAdmission(token) {
  const response = await fetch(`${appOrigin}/api/connectors`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Connector admission check failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const features = payload?.features;
  if (!features || typeof features !== "object") {
    throw new Error("Connector admission response is missing feature state.");
  }
  return {
    connection: features.google_drive_connection === true,
    live: features.google_drive_live === true,
  };
}

try {
  session = await reviewer.openSession(browser, "/");
  const { page } = session;
  ownerToken = await session.capture.ownerToken();
  if (scenario === "drive_connector_setup") {
    const admission = await driveAdmission(ownerToken);
    if (!admission.connection || !admission.live) {
      throw new Error(
        `DRIVE_CONNECTOR_NOT_ADMITTED connection=${Number(admission.connection)} live=${Number(admission.live)}`,
      );
    }
  }
  // The app may restore the reviewer's last conversation on entry. Start a
  // fresh thread through its own control before asserting a new request ID.
  const newChat = page.getByRole("button", { name: "Create new chat" });
  if (await newChat.count() === 0) {
    await page.getByRole("button", { name: "Open chat history" }).click();
  }
  await newChat.first().click();
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-message-role="user"]').length === 0,
  );
  baselineConversationIds = await conversationIds(ownerToken);
  await page.getByTestId("agent-chat-composer-textarea").waitFor({ state: "visible" });
  await page.evaluate(installConsentStreamProbe);
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
  const finalStatus = await page.locator('[data-message-role="assistant"]').last()
    .getAttribute("data-message-status");
  if (finalStatus !== "done") {
    const failure = await page.evaluate(() => {
      const stream = window.__consentRehearsalStreams?.at(-1);
      return stream?.runError ? stream.runErrorClass || "untyped" : "no_run_error";
    });
    throw new Error(`AGENT_CHAT_TURN_NOT_DONE status=${finalStatus ?? "missing"} error_class=${failure}`);
  }

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
  if (scenario === "private_connector_setup" || scenario === "drive_connector_setup") {
    const setup = page.getByTestId("workspace-connector-setup").last();
    try {
      // The assistant turn is already settled. A missing structured card is
      // a product failure, not a reason to wait through another provider-sized
      // timeout or retain assistant text as diagnostic evidence.
      await setup.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      throw new Error("CONNECTOR_SETUP_CARD_MISSING_AFTER_SETTLED_TURN");
    }
    if (scenario === "drive_connector_setup" && await setup.getAttribute("aria-label") !== "Drive connection needed") {
      throw new Error("DRIVE_CONNECTOR_CARD_PROVIDER_MISMATCH");
    }
    await setup.getByRole("button", {
      name: scenario === "drive_connector_setup" ? "Connect Drive" : "Open connectors",
    }).click();
    await page.getByRole("dialog", { name: "Connectors" }).waitFor({
      state: "visible", timeout: timeoutMs,
    });
    if (scenario === "private_connector_setup") {
      const custom = page.getByRole("region", { name: "Custom connectors" });
      await custom.waitFor({ state: "visible", timeout: 15_000 });
      const add = custom.getByRole("button", { name: "Add connector" });
      await add.waitFor({ state: "visible", timeout: 15_000 });
      try {
        // The vault-backed catalog can render its button before it finishes
        // loading. Playwright waits for the actual enabled/hit-test state.
        await add.click({ timeout: 20_000 });
      } catch {
        throw new Error("PRIVATE_CONNECTOR_ADD_UNAVAILABLE");
      }
      await custom.getByRole("textbox", { name: "Server address" }).waitFor({
        state: "visible", timeout: 15_000,
      });
    }
  }
  const createdIds = [...await conversationIds(ownerToken)]
    .filter((id) => !baselineConversationIds.has(id));
  if (createdIds.length !== 1) {
    throw new Error("Agent Chat did not create exactly one fresh conversation.");
  }
  session.capture.assertNoCriticalApiFailures("agent chat prompt round-trip");
  process.stdout.write(
    `[reviewer-app-testing] PASS agent_chat_round_trip=1 scenario=${scenario} fresh_conversation=1 raw_error_leak=0 idle_ready=0 self_avatar=1 horizontal_overflow=0 composer_control_symmetry=1\n`,
  );
} finally {
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
