#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "../../../.agents/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "../../../.agents/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs";

if (process.argv.includes("--help")) {
  console.log("Rehearse signed-in Finance chat on an exact hosted UAT build. Set REVIEWER_APP_ORIGIN, canonical reviewer identity, and REVIEWER_ALLOW_SHARED_MUTATIONS=true.");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appOrigin = new URL(process.env.REVIEWER_APP_ORIGIN || "https://uat.one.hussh.ai").origin;
const ticker = "MSFT";
const stockPrompt = `Analyze ${ticker} in this chat. Show the stock analysis preview so I can confirm it.`;
const portfolioPrompt = "Show my portfolio allocation in this chat.";
const intendedPrompts = [stockPrompt, portfolioPrompt];
const timeoutMs = 420_000;
let submittedPrompts = 0;
let starts = 0;
let reattachCount = 0;
let confirmed = false;
let phase = "preflight";
let browser;
let session;

function requireCondition(condition, reason) {
  if (!condition) throw new Error(reason);
}

try {
  requireCondition(process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true", "Explicit fixture authority is required.");
  requireCondition(appOrigin === "https://uat.one.hussh.ai", "Use the canonical UAT origin for shared reviewer credentials.");
  await prepareReviewerRehearsal({ repoRoot, appOrigin });
  const reviewer = await createReviewerSessionHarness({
    repoRoot, appOrigin, timeoutMs,
    admitMutation(request) {
      if (request.method() !== "POST") return false;
      const { pathname } = new URL(request.url());
      if (pathname === "/api/one/agent-chat") {
        const body = request.postDataJSON();
        const prompt = body.messages?.filter((message) => message.role === "user").at(-1)?.content;
        if (submittedPrompts >= intendedPrompts.length || prompt !== intendedPrompts[submittedPrompts]) return false;
        submittedPrompts += 1;
        return true;
      }
      if (pathname !== "/api/kai/analyze/stream" || !confirmed || starts !== 0) return false;
      const body = request.postDataJSON();
      if (body.ticker !== ticker || body.user_id !== process.env.REVIEWER_UID) return false;
      starts += 1;
      return true;
    },
  });
  phase = "vault";
  browser = await reviewer.chromium.launch({ headless: true });
  await reviewer.assertVisibleVaultChallenge(browser, "/");
  session = await reviewer.openSession(browser, "/");
  const { page, context } = session;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === appOrigin && request.method() === "GET" && /^\/api\/kai\/analyze\/run\/[^/]+\/stream$/.test(url.pathname)) reattachCount += 1;
  });
  const composer = page.getByTestId("agent-chat-composer-textarea");
  const assistantMessages = page.locator('[data-message-role="assistant"]');
  const send = async (prompt) => {
    const previousCount = await assistantMessages.count();
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await assistantMessages.nth(previousCount)
      .and(page.locator('[data-message-status="done"]')).waitFor({ state: "visible", timeout: timeoutMs });
    session.readOnlyGuard.assertNoBlockedMutation();
    session.capture.assertNoCriticalApiFailures("Finance chat");
  };

  phase = "stock preview";
  const newChat = page.getByRole("button", { name: "Create new chat" });
  if (!await newChat.isVisible()) await page.getByRole("button", { name: "Open chat history" }).click();
  await newChat.click();
  await send(stockPrompt);
  await page.getByText(`${ticker} stock analysis`, { exact: true }).click();
  const confirm = page.getByRole("button", { name: "Start debate", exact: true });
  await confirm.waitFor({ state: "visible" });
  requireCondition(starts === 0, "The debate started without confirmation.");

  phase = "confirmation and live progress";
  confirmed = true;
  await confirm.click();
  const card = page.locator("details").filter({ has: page.getByText(`${ticker} stock analysis`, { exact: true }) });
  await card.getByRole("status").filter({ hasText: /Starting research|Research round underway|Debate round underway|research specialist|Reviewing research findings/ }).waitFor({ timeout: timeoutMs });
  requireCondition(starts === 1, "Expected exactly one new debate.");

  phase = "reconnect";
  await context.setOffline(true);
  try {
    await card.getByRole("button", { name: "Reconnect", exact: true }).waitFor({ timeout: 90_000 });
  } finally {
    await context.setOffline(false);
  }
  const replayBefore = reattachCount;
  await card.getByRole("button", { name: "Reconnect", exact: true }).click();
  const openAnalysis = card.getByRole("button", { name: "Open analysis", exact: true });
  await openAnalysis.waitFor({ timeout: timeoutMs });
  requireCondition(reattachCount > replayBefore && starts === 1, "Reconnect must reattach without starting another debate.");
  await card.getByText("Saved to Finance history.", { exact: true }).waitFor({ timeout: timeoutMs });
  await reviewer.assertVaultContinuity(page, "Finance debate");

  phase = "read-only analysis details";
  const chatUrl = page.url();
  requireCondition(await card.getByText("What to consider", { exact: true }).count() === 0, "The chat card should contain only the analysis overview.");
  await openAnalysis.click();
  const details = page.getByRole("dialog", { name: `${ticker} analysis`, exact: true });
  await details.getByText("Full debate and research", { exact: true }).waitFor();
  await details.getByText("Detailed record and sources", { exact: true }).waitFor();
  requireCondition(page.url() === chatUrl && submittedPrompts === 1 && starts === 1, "Opening analysis must stay in chat and reuse the completed debate.");
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "hidden" });
  await openAnalysis.waitFor({ state: "visible" });
  requireCondition(page.url() === chatUrl, "Closing analysis must return to the same chat.");

  phase = "portfolio";
  await send(portfolioPrompt);
  await page.locator('[data-message-role="assistant"]').last().getByText("Allocation", { exact: true }).waitFor();
  requireCondition(new URL(page.url()).pathname === "/", "Finance unexpectedly navigated away from chat.");
  await reviewer.assertVaultContinuity(page, "Finance portfolio");
  requireCondition(submittedPrompts === 2 && starts === 1, "Unexpected Finance mutation count.");
  console.log("PASS Finance preview, confirmed debate, live progress, reconnect, save, analysis detail panel, portfolio card, and vault continuity.");
} catch {
  // Playwright errors can include DOM or request details. Only emit the step.
  console.error(`FAIL Finance reviewer rehearsal at ${phase}.`);
  process.exitCode = 1;
} finally {
  await session?.context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
