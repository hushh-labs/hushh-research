#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);

if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS !== "true") {
  throw new Error("Consent rehearsal creates and cancels a UAT request. Explicit mutation authority is required.");
}

await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "0" });
let session;
let ownerToken = "";
let createdBundleId = "";
let baselineConversationIds = new Set();

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

try {
  session = await reviewer.openSession(browser, "/agent");
  let { page } = session;
  ownerToken = await session.capture.ownerToken();
  const conversationIds = async () => {
    const response = await fetch(
      `${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`,
      { headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" } },
    );
    if (!response.ok) return new Set();
    const payload = await response.json();
    return new Set((payload.conversations || []).map((item) => String(item.id)));
  };
  baselineConversationIds = await conversationIds();
  await page.goto(`${appOrigin}/one/connect`, { waitUntil: "domcontentloaded" });
  await reviewer.assertVaultContinuity(page, "/one/connect");
  const identityToken = await session.capture.identityToken();
  const fetchIdentityJson = async (pathname) => {
    const response = await fetch(`${appOrigin}${pathname}`, {
      headers: { Authorization: `Bearer ${identityToken}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${pathname} failed with HTTP ${response.status}.`);
    return response.json();
  };
  const connectionPage = await fetchIdentityJson("/api/one/connections?page=1&page_size=100");
  const connections = Array.isArray(connectionPage?.items) ? connectionPage.items : [];
  let fixture = null;
  for (const connection of connections) {
    const personRef = clean(connection.publicPersonRef);
    const displayName = clean(connection.displayName);
    if (!personRef || !displayName) continue;
    const profile = await fetchIdentityJson(`/api/one/people/${encodeURIComponent(personRef)}`);
    const scopes = Array.isArray(profile?.requestableScopes) ? profile.requestableScopes : [];
    if (scopes.length > 0) {
      fixture = { personRef, displayName, profile, scope: scopes[0] };
      break;
    }
  }
  if (!fixture) throw new Error("Reviewer has no connected person with a requestable scope.");
  await page.goto(`${appOrigin}/agent`, { waitUntil: "domcontentloaded" });
  await reviewer.assertVaultContinuity(page, "/agent");

  const scopeLabel = clean(fixture.scope.label);
  const scopeDomain = clean(fixture.scope.domain);
  const prompt = `Show the exact ${scopeDomain || "information"} fields I can request from ${fixture.displayName}, and explain the next consent step.`;
  const baselineTurns = await page.locator('[data-message-role="assistant"]').count();
  await page.getByTestId("agent-chat-composer-textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(
    ({ baseline, expectedLabel, expectedPath }) => {
      const turns = [...document.querySelectorAll('[data-message-role="assistant"]')];
      const latest = turns.at(-1);
      if (turns.length <= baseline || latest?.getAttribute("data-message-status") === "streaming") return false;
      const text = latest?.textContent || "";
      const hasProfileLink = Boolean(latest?.querySelector(`a[href="${expectedPath}"]`));
      return text.includes(expectedLabel) && hasProfileLink;
    },
    {
      baseline: baselineTurns,
      expectedLabel: scopeLabel,
      expectedPath: `/people/${fixture.personRef}`,
    },
    { timeout: timeoutMs },
  );

  const latestTurn = page.locator('[data-message-role="assistant"]').last();
  await latestTurn.getByRole("button", { name: /Activity/i }).waitFor({ state: "visible" });
  await latestTurn.getByRole("link", { name: "Review information", exact: true }).waitFor({
    state: "visible",
  });
  await session.context.close();
  session = await reviewer.openSession(browser, `/people/${fixture.personRef}`);
  page = session.page;
  await page.getByRole("heading", { name: "Available to request" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: new RegExp(scopeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await page.getByRole("button", { name: /Review request \(1\)/ }).click();
  const reviewDialog = page.getByRole("dialog");
  await reviewDialog.getByText(scopeLabel, { exact: true }).waitFor({ state: "visible" });
  await reviewDialog.getByLabel("Purpose").fill("Verify the reviewer consent lifecycle without accessing values.");

  const createResponse = page.waitForResponse(
    (response) => response.url().includes("/api/one/information-requests") && response.request().method() === "POST",
    { timeout: timeoutMs },
  );
  await reviewDialog.getByRole("button", { name: "Send request" }).click();
  const response = await createResponse;
  if (!response.ok()) throw new Error(`Consent request creation failed with HTTP ${response.status()}.`);
  const payload = await response.json();
  createdBundleId = clean(payload.bundleId || payload.bundle_id);
  if (!createdBundleId) throw new Error("Consent request response did not include a bundle id.");

  const createdStateResponse = await fetch(
    `${appOrigin}/api/one/information-requests/${encodeURIComponent(createdBundleId)}`,
    { headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" } },
  );
  if (!createdStateResponse.ok) {
    throw new Error(`Consent request read failed with HTTP ${createdStateResponse.status}.`);
  }
  const createdState = await createdStateResponse.json();
  if (!JSON.stringify(createdState).toLowerCase().includes("pending")) {
    throw new Error("Consent request did not enter the pending state.");
  }
  const cancelResponse = await fetch(
    `${appOrigin}/api/one/information-requests/${encodeURIComponent(createdBundleId)}/cancel`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
    },
  );
  if (!cancelResponse.ok) throw new Error(`Consent request cancellation failed with HTTP ${cancelResponse.status}.`);
  createdBundleId = "";

  const body = await page.locator("body").innerText();
  if (body.includes("attr.") || body.includes(String(fixture.scope.scopeRef))) {
    throw new Error("Consent rehearsal exposed an internal scope identifier.");
  }
  session.capture.assertNoCriticalApiFailures("agent consent lifecycle");
  process.stdout.write(
    "[reviewer-app-testing] PASS real_scope_discovery=1 retained_activity=1 review_sheet=1 request_created=1 request_cancelled=1 raw_scope_ids=0\n",
  );
} finally {
  if (createdBundleId && ownerToken) {
    await fetch(`${appOrigin}/api/one/information-requests/${encodeURIComponent(createdBundleId)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
    }).catch(() => undefined);
  }
  if (ownerToken) {
    const response = await fetch(
      `${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`,
      { headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" } },
    ).catch(() => null);
    if (response?.ok) {
      const payload = await response.json().catch(() => ({ conversations: [] }));
      const createdIds = (payload.conversations || [])
        .map((item) => String(item.id))
        .filter((id) => !baselineConversationIds.has(id));
      await Promise.all(createdIds.map((id) =>
        fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
        }).catch(() => undefined),
      ));
    }
  }
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
