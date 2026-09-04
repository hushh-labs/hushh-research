#!/usr/bin/env node
/**
 * Consent lifecycle from Agent chat, end to end on localhost:
 * discover a person's requestable fields, propose + send a request after a spoken
 * yes (backend-direct, the requester's own connector key), list what is waiting,
 * and cancel the sent request from chat. Values never appear: every assertion is
 * on labels, statuses, and the absence of raw scope identifiers.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const turnTimeoutMs = Number(process.env.REVIEWER_TURN_TIMEOUT_MS || 180_000);
const reportPath = path.join(repoRoot, "tmp", "reviewer-consent-chat-report.json");
const PURPOSE = "Reviewer rehearsal of the consent lifecycle from chat.";

if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS !== "true") {
  throw new Error("Consent chat rehearsal creates and cancels a request on the shared reviewer. Set REVIEWER_ALLOW_SHARED_MUTATIONS=true only with explicit mutation authority.");
}

const results = [];
function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail.note ? ` - ${detail.note}` : ""}\n`);
}
async function step(name, fn) {
  try {
    const note = await fn();
    record(name, true, note ? { note: String(note) } : {});
  } catch (error) {
    record(name, false, { note: String(error?.message || error).slice(0, 400) });
  }
}
function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const preflight = await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "0" });
let session;
let ownerToken = "";
let identityToken = "";
let createdBundleId = "";
let baselineConversationIds = new Set();

async function ensureOnAgent(page) {
  const pathname = await page.evaluate(() => window.location.pathname);
  if (pathname === "/agent") return;
  await reviewer.navigateInApp(page, "/agent");
}
async function sendPrompt(page, text) {
  await ensureOnAgent(page);
  const composer = page.getByTestId("agent-chat-composer-textarea");
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  const baseline = await page.locator('[data-message-role="assistant"]').count();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  return baseline;
}
async function waitForAssistantSettled(page, baselineAssistant) {
  await page.waitForFunction(
    ({ baselineCount }) => {
      const turns = [...document.querySelectorAll('[data-message-role="assistant"]')];
      const latest = turns.at(-1);
      return turns.length > baselineCount && latest?.getAttribute("data-message-status") !== "streaming" && Boolean(latest?.textContent?.trim());
    },
    { baselineCount: baselineAssistant },
    { timeout: turnTimeoutMs },
  );
  return page.locator('[data-message-role="assistant"]').last().innerText();
}
async function turn(page, text) {
  const baseline = await sendPrompt(page, text);
  return waitForAssistantSettled(page, baseline);
}
async function ownerJson(pathname, init = {}) {
  const response = await fetch(`${appOrigin}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { ok: response.ok, status: response.status, payload };
}
const backendOrigin = String(process.env.REVIEWER_BACKEND_ORIGIN || "http://localhost:8010").replace(/\/$/, "");
async function backendJson(pathname) {
  const response = await fetch(`${backendOrigin}${pathname}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { ok: response.ok, status: response.status, payload };
}
async function identityJson(pathname) {
  const response = await fetch(`${appOrigin}${pathname}`, {
    headers: { Authorization: `Bearer ${identityToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${pathname} failed with HTTP ${response.status}.`);
  return response.json();
}
function assertNoLeak(text, label) {
  if (/\battr\.[a-z_]+/.test(text) || /\bpsr_[A-Za-z0-9]+/.test(text)) {
    throw new Error(`${label} exposed an internal scope identifier`);
  }
}
async function findOurBundle(personRef) {
  const profile = await identityJson(`/api/one/people/${encodeURIComponent(personRef)}`);
  const history = Array.isArray(profile?.requestHistory) ? profile.requestHistory : [];
  for (const entry of history) {
    const serialized = JSON.stringify(entry);
    if (serialized.includes(PURPOSE)) {
      return {
        bundleId: clean(entry.bundleId || entry.bundle_id || entry.id),
        status: clean(entry.status).toLowerCase(),
        entry,
      };
    }
  }
  return null;
}

try {
  session = await reviewer.openSession(browser, "/agent");
  const { page } = session;
  ownerToken = await session.capture.ownerToken();
  // The identity token is observed on a Firebase-authenticated request; the
  // Connect tab issues one on entry, /agent does not. Same-session navigation
  // keeps the vault key.
  // Warm the Connect server render first: right after a backend restart the
  // app-router navigation waits on that render, and a cold one can outlast
  // the navigation timeout.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const warm = await fetch(`${appOrigin}/one/connect`, { redirect: "manual" }).catch(() => null);
    if (warm && warm.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  try {
    await reviewer.navigateInApp(page, "/one/connect");
  } catch {
    await page.waitForTimeout(5_000);
    await reviewer.navigateInApp(page, "/one/connect");
  }
  identityToken = await session.capture.identityToken();
  await reviewer.navigateInApp(page, "/agent");
  const conversationIds = async () => {
    const result = await ownerJson(`/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`);
    return new Set(((result.payload || {}).conversations || []).map((item) => String(item.id)));
  };
  baselineConversationIds = await conversationIds();

  let fixture = null;
  await step("reviewer has a connected person with a requestable field", async () => {
    const connectionPage = await identityJson("/api/one/connections?page=1&page_size=100");
    for (const connection of Array.isArray(connectionPage?.items) ? connectionPage.items : []) {
      const personRef = clean(connection.publicPersonRef);
      const displayName = clean(connection.displayName);
      if (!personRef || !displayName) continue;
      const profile = await identityJson(`/api/one/people/${encodeURIComponent(personRef)}`);
      const scopes = Array.isArray(profile?.requestableScopes) ? profile.requestableScopes : [];
      if (scopes.length > 0) {
        fixture = { personRef, displayName, scope: scopes[0], scopeCount: scopes.length };
        break;
      }
    }
    if (!fixture) throw new Error("no connected person with a requestable scope");
    return `person=${fixture.displayName} fields=${fixture.scopeCount}`;
  });
  if (!fixture) throw new Error("fixture missing");
  const scopeLabel = clean(fixture.scope.label);

  await step("requester connector key is registered (set up once on the profile)", async () => {
    // The connector read lives on the backend origin; the web proxy does not serve it.
    const connector = await backendJson(`/api/one/kyc/client-connector?user_id=${encodeURIComponent(reviewer.reviewerUid)}`);
    if (connector.ok && connector.payload?.configured) return "configured";
    if (!connector.ok && connector.status !== 404) throw new Error(`connector read failed with HTTP ${connector.status}`);
    // First-time requesters register the client-held key from the profile page.
    await reviewer.navigateInApp(page, `/people/${fixture.personRef}`);
    await page.getByRole("heading", { name: "Available to request" }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: new RegExp(scopeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
    await page.getByRole("button", { name: /Review request \(1\)/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Purpose").fill("Register the reviewer connector for the chat rehearsal.");
    const created = page.waitForResponse((r) => r.url().includes("/api/one/information-requests") && r.request().method() === "POST", { timeout: timeoutMs });
    await dialog.getByRole("button", { name: "Send request" }).click();
    const response = await created;
    if (!response.ok()) throw new Error(`profile request failed with HTTP ${response.status()}`);
    const payload = await response.json();
    const bundleId = clean(payload.bundleId || payload.bundle_id);
    if (bundleId) await ownerJson(`/api/one/information-requests/${encodeURIComponent(bundleId)}/cancel`, { method: "POST" });
    await reviewer.navigateInApp(page, "/agent");
    const after = await backendJson(`/api/one/kyc/client-connector?user_id=${encodeURIComponent(reviewer.reviewerUid)}`);
    if (!after.payload?.configured) throw new Error(`connector still not configured after the profile flow (HTTP ${after.status})`);
    return "registered via profile, request cancelled";
  });

  await step("chat: discovery names the requestable field and links the profile", async () => {
    const reply = await turn(page, `What information can I request from ${fixture.displayName}?`);
    assertNoLeak(reply, "discovery reply");
    if (!reply.includes(scopeLabel)) throw new Error(`reply lacks the field label: ${clean(reply).slice(0, 200)}`);
  });

  await step("chat: a request is proposed, read back, and sent only after a spoken yes", async () => {
    const proposal = await turn(page, `Request ${fixture.displayName}'s ${scopeLabel} for 2 days. Purpose: ${PURPOSE}`);
    assertNoLeak(proposal, "proposal reply");
    if (!proposal.includes(scopeLabel)) throw new Error(`proposal did not read back the field: ${clean(proposal).slice(0, 200)}`);
    const before = await findOurBundle(fixture.personRef);
    if (before && before.status === "pending") throw new Error("request was sent before the yes");
    const sent = await turn(page, "Yes, send it.");
    assertNoLeak(sent, "send reply");
    let found = null;
    for (let attempt = 0; attempt < 10 && !found; attempt += 1) {
      found = await findOurBundle(fixture.personRef);
      if (!found) await page.waitForTimeout(1500);
    }
    if (!found) throw new Error(`no pending bundle with the rehearsal purpose after: ${clean(sent).slice(0, 200)}`);
    createdBundleId = found.bundleId;
    if (!/sent/i.test(sent)) throw new Error(`reply did not confirm the send: ${clean(sent).slice(0, 200)}`);
    return `bundle status=${found.status}`;
  });

  await step("chat: asking what is waiting answers without leaking identifiers", async () => {
    const reply = await turn(page, "What requests are waiting on me?");
    assertNoLeak(reply, "pending reply");
    if (/couldn't|could not|temporarily unavailable/i.test(reply)) throw new Error(`error surfaced: ${clean(reply).slice(0, 200)}`);
    if (!/waiting|no information requests|nothing/i.test(reply)) throw new Error(`reply did not answer the question: ${clean(reply).slice(0, 200)}`);
  });

  await step("chat: the sent request is cancelled after a spoken yes", async () => {
    const ask = await turn(page, "Cancel that request I just sent.");
    assertNoLeak(ask, "cancel prompt reply");
    const done = await turn(page, "Yes, cancel it.");
    assertNoLeak(done, "cancel reply");
    let state = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await ownerJson(`/api/one/information-requests/${encodeURIComponent(createdBundleId)}`);
      state = JSON.stringify(result.payload || {}).toLowerCase();
      if (result.ok && !state.includes('"pending"')) break;
      await page.waitForTimeout(1500);
    }
    if (!state || state.includes('"pending"')) throw new Error(`bundle still pending after: ${clean(done).slice(0, 200)}`);
    createdBundleId = "";
    return "bundle no longer pending";
  });

  await step("no internal scope identifier anywhere on the chat surface", async () => {
    assertNoLeak(await page.locator("body").innerText(), "chat surface");
  });
  session.capture.assertNoCriticalApiFailures("consent chat lifecycle");
} catch (error) {
  // A failure before or between steps must be visible as a failed step, not as
  // a zero-step PASS.
  record("rehearsal aborted", false, { note: String(error?.stack || error?.message || error).slice(0, 600) });
} finally {
  if (createdBundleId && ownerToken) {
    await ownerJson(`/api/one/information-requests/${encodeURIComponent(createdBundleId)}/cancel`, { method: "POST" }).catch(() => undefined);
  }
  if (ownerToken) {
    const current = await ownerJson(`/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`).catch(() => null);
    const ids = ((current?.payload || {}).conversations || []).map((item) => String(item.id)).filter((id) => !baselineConversationIds.has(id));
    await Promise.all(ids.map((id) => ownerJson(`/api/one/agent-chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined)));
  }
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const failed = results.filter((r) => !r.ok).length || (results.length === 0 ? 1 : 0);
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), preflight: preflight?.summary ?? null, results }, null, 2));
  process.stdout.write(`[reviewer-app-testing] consent-chat ${failed ? "FAIL" : "PASS"} steps=${results.length} failed=${failed} report=${path.relative(repoRoot, reportPath)}\n`);
  process.exitCode = failed ? 1 : 0;
}
