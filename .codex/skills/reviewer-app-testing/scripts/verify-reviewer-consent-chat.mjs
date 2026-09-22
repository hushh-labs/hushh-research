#!/usr/bin/env node
/**
 * Consent lifecycle from Agent chat, end to end on localhost:
 * discover a person's requestable fields, propose + send a request after the
 * visible app confirmation (backend-direct, the requester's own connector key),
 * list what is waiting, and cancel the sent request from chat. Values never
 * appear: every assertion is on labels, statuses, and the absence of raw scope
 * identifiers.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { assertAllStreamProofs, assertConfirmationReview, assertRequestState, assertStreamProof, createDraftAdmission, requireEvidence, safeFailureCode } from "./consent-rehearsal-contract.mjs";
import { installConsentStreamProbe } from "./consent-rehearsal-stream-probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const turnTimeoutMs = Number(process.env.REVIEWER_TURN_TIMEOUT_MS || 180_000);
const reportPath = path.join(repoRoot, "tmp", "reviewer-consent-chat-report.json");
const runId = randomUUID();
const PURPOSE = `Synthetic reviewer consent lifecycle ${runId}`;
const personRef = String(process.env.REVIEWER_COUNTERPART_PERSON_REF || "").trim();
const scopeRef = String(process.env.REVIEWER_CONSENT_SCOPE_REF || "").trim();
requireEvidence(Boolean(personRef && scopeRef), "EXPLICIT_RECIPIENT_AND_SYNTHETIC_SCOPE_REQUIRED");
requireEvidence(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(personRef), "INVALID_REVIEWER_PERSON_REFERENCE");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

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
    record(name, false, { code: safeFailureCode(error) });
    throw error;
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
let allowCreate = false;
let allowCancel = false;
let mutationFailure = null;
const validatedStreams = new Map();
const admitDraft = createDraftAdmission({ personRef, purpose: PURPOSE, durationSeconds: 172800, scopeRefs: [scopeRef] });

async function ensureOnChat(page) {
  const pathname = await page.evaluate(() => window.location.pathname);
  if (pathname === "/") return;
  await reviewer.navigateInApp(page, "/");
}
async function sendPrompt(page, text) {
  await ensureOnChat(page);
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
      // Structured experiences are the authoritative response surface for
      // consent discovery/proposals. They may intentionally have no prose;
      // waiting for text here can time out a completed AG-UI turn forever.
      return turns.length > baselineCount && latest?.getAttribute("data-message-status") !== "streaming";
    },
    { baselineCount: baselineAssistant },
    { timeout: turnTimeoutMs },
  );
  return page.locator('[data-message-role="assistant"]').last().innerText();
}
async function verifyChatStream(page, index, expectedParkedAction = null) {
  await page.waitForFunction(index => window.__consentRehearsalStreams?.[index]?.settled === true,
    index, { timeout: turnTimeoutMs });
  const proof = await page.evaluate(index => window.__consentRehearsalStreams[index], index);
  assertStreamProof(proof, expectedParkedAction);
  validatedStreams.set(index, expectedParkedAction);
  requireEvidence(await page.locator('[data-message-role="assistant"]').last()
    .getAttribute("data-message-status") === "done", "ASSISTANT_TURN_FAILED");
  if (expectedParkedAction) {
    requireEvidence(await page.getByTestId("specialist-directive-confirm").count() === 1,
      "EXPECTED_CONFIRMATION_MISSING");
    await page.getByTestId("specialist-directive-confirm").waitFor({ state: "visible", timeout: turnTimeoutMs });
  }
}
async function verifyAllStartedStreams(page) {
  await page.waitForFunction(() => window.__consentRehearsalStreams.every(proof => proof.settled),
    undefined, { timeout: turnTimeoutMs });
  // Only explicitly verified proposal/cancellation turns can be parked.
  // Streams started by confirmation execution must actually finish.
  assertAllStreamProofs(await page.evaluate(() => window.__consentRehearsalStreams), validatedStreams);
}
async function turn(page, text, expectedParkedAction = null) {
  const index = await page.evaluate(() => window.__consentRehearsalStreams.length);
  const baseline = await sendPrompt(page, text);
  const reply = await waitForAssistantSettled(page, baseline);
  await verifyChatStream(page, index, expectedParkedAction);
  if (mutationFailure) throw mutationFailure;
  return reply;
}
async function ownerJson(pathname, init = {}) {
  const response = await fetch(`${appOrigin}${pathname}`, {
    signal: AbortSignal.timeout(30_000),
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
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { ok: response.ok, status: response.status, payload };
}
async function identityJson(pathname) {
  const response = await fetch(`${appOrigin}${pathname}`, {
    signal: AbortSignal.timeout(30_000),
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
async function visibleSurfaceText(page) {
  return page.locator("body").innerText();
}
async function selectIntendedPersonCandidate(page) {
  const picker = page.locator("section").filter({ hasText: "Who do you mean?" }).last();
  if (!(await picker.isVisible().catch(() => false))) return "";
  const profileLink = picker.locator(`a[href="/people/${personRef}"]`);
  requireEvidence(await profileLink.count() === 1, "INTENDED_CANDIDATE_NOT_UNIQUE");
  const candidate = profileLink.locator("..").getByRole("button");
  const baseline = await page.locator('[data-message-role="assistant"]').count();
  const index = await page.evaluate(() => window.__consentRehearsalStreams.length);
  await candidate.click();
  await waitForAssistantSettled(page, baseline);
  await verifyChatStream(page, index);
  return true;
}
async function findOurBundle(personRef) {
  const profile = await identityJson(`/api/one/people/${encodeURIComponent(personRef)}`);
  const history = Array.isArray(profile?.requestHistory) ? profile.requestHistory : [];
  for (const entry of history) {
    if (entry.purpose === PURPOSE) {
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
  session = await reviewer.openSession(browser, "/");
  const { page } = session;
  await page.evaluate(installConsentStreamProbe);
  await page.route("**/api/one/information-requests**", async route => {
    const request = route.request();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.fallback();
    try {
      const pathname = new URL(request.url()).pathname;
      requireEvidence(new URL(request.url()).origin === appOrigin, "MUTATION_ORIGIN_MISMATCH");
      requireEvidence(request.method() === "POST", "UNEXPECTED_REQUEST_MUTATION");
      if (pathname === "/api/one/information-requests") {
        requireEvidence(allowCreate, "REQUEST_SENT_BEFORE_CONFIRMATION");
        admitDraft(request.postDataJSON());
      } else {
        requireEvidence(allowCancel && Boolean(createdBundleId) &&
          pathname === `/api/one/information-requests/${encodeURIComponent(createdBundleId)}/cancel`,
        "UNEXPECTED_REQUEST_MUTATION");
      }
      return route.fallback();
    } catch (error) {
      mutationFailure = error;
      return route.abort("blockedbyclient");
    }
  });
  ownerToken = await session.capture.ownerToken();
  {
    // A lifecycle rehearsal must not inherit a parked tool run or stale
    // conversational selection from another rehearsal. This only resets the
    // in-memory workspace; the existing encrypted conversation history remains
    // untouched and is covered by separate restoration checks.
    await page.getByRole("button", { name: "Open chat history" }).click();
    await page
      .getByRole("button", { name: "Create new chat" })
      .click();
  }
  // The identity token is observed on a Firebase-authenticated request; the
  // Connect tab issues one on entry, root Chat does not. Same-session navigation
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
  await reviewer.navigateInApp(page, "/");
  let fixture = null;
  await step("intended reviewer has the selected synthetic requestable field", async () => {
    let profile = await identityJson(`/api/one/people/${encodeURIComponent(personRef)}?catalog_page=1`);
    requireEvidence(profile.personRef === personRef, "PROFILE_RECIPIENT_MISMATCH");
    requireEvidence(profile.relationship?.status === "connected", "REVIEWER_CONNECTION_REQUIRED");
    const revision = profile.scopeCatalog?.catalogRevision;
    const visited = new Set([1]);
    let scope = profile.requestableScopes?.find(item => item.scopeRef === scopeRef);
    while (!scope && profile.scopeCatalog?.hasMore) {
      const nextPage = profile.scopeCatalog.nextPage;
      requireEvidence(Number.isInteger(nextPage) && !visited.has(nextPage) && visited.size < 100,
        "CATALOG_CONTINUATION_INVALID");
      visited.add(nextPage);
      const query = new URLSearchParams({ catalog_page: String(nextPage) });
      if (revision) query.set("catalog_revision", revision);
      profile = await identityJson(`/api/one/people/${encodeURIComponent(personRef)}?${query}`);
      requireEvidence(profile.personRef === personRef, "PROFILE_RECIPIENT_MISMATCH");
      requireEvidence(!profile.scopeCatalog?.paginationReset && profile.scopeCatalog?.catalogRevision === revision,
        "CATALOG_REVISION_CHANGED");
      scope = profile.requestableScopes?.find(item => item.scopeRef === scopeRef);
    }
    requireEvidence(Boolean(scope), "SYNTHETIC_SCOPE_NOT_LOADED");
    fixture = { personRef, displayName: profile.displayName, scope };
    requireEvidence(Boolean(fixture.displayName), "RECIPIENT_NAME_UNAVAILABLE");
  });
  if (!fixture) throw new Error("fixture missing");
  const scopeLabel = clean(fixture.scope.label);

  await step("requester connector key is registered (set up once on the profile)", async () => {
    // The connector read lives on the backend origin; the web proxy does not serve it.
    const connector = await backendJson(`/api/one/kyc/client-connector?user_id=${encodeURIComponent(reviewer.reviewerUid)}`);
    if (connector.ok && connector.payload?.configured) return "configured";
    if (!connector.ok && connector.status !== 404) throw new Error(`connector read failed with HTTP ${connector.status}`);
    // Connector setup belongs to the explicit Profile fixture journey; never
    // create an extra request as hidden setup for a Chat test.
    requireEvidence(false, "REVIEWER_CONNECTOR_SETUP_REQUIRED");
  });

  await step("chat: discovery names the requestable field and links the profile", async () => {
    const reply = await turn(page, `What information can I request from ${fixture.displayName}?`);
    assertNoLeak(reply, "discovery reply");
    await selectIntendedPersonCandidate(page);
    const surface = await visibleSurfaceText(page);
    if (!reply.includes(scopeLabel) && !surface.includes(scopeLabel)) {
      requireEvidence(false, "DISCOVERY_FIELD_MISSING");
    }
    requireEvidence(await page.locator(`a[href^="/people/${personRef}"]`).count() > 0, "DISCOVERY_PROFILE_LINK_MISSING");
  });

  await step("chat: a request is proposed, read back, and sent only after visible confirmation", async () => {
    const proposal = await turn(page, `Request ${fixture.displayName}'s ${scopeLabel} for 2 days. Purpose: ${PURPOSE}`, "consent.request");
    assertNoLeak(proposal, "proposal reply");
    const confirmation = page.getByTestId("specialist-directive-card");
    const summary = await confirmation.innerText();
    const currentCards = page.locator('[data-message-role="assistant"]').last().locator('[data-experience-type]');
    const reviewText = (await currentCards.allTextContents()).join(" ");
    assertConfirmationReview(summary, reviewText, { displayName: fixture.displayName, scopeLabel, purpose: PURPOSE });
    const before = await findOurBundle(fixture.personRef);
    requireEvidence(!before, "REQUEST_SENT_BEFORE_CONFIRMATION");
    const confirm = page.getByTestId("specialist-directive-confirm");
    // No compatibility turn: a second confirmation is a UX failure.
    await confirm.waitFor({ state: "visible", timeout: turnTimeoutMs });
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/one/information-requests" &&
        response.request().method() === "POST",
      { timeout: turnTimeoutMs },
    );
    allowCreate = true;
    await confirm.click();
    const createdResponse = await created;
    allowCreate = false;
    if (!createdResponse.ok()) {
      throw new Error(`chat request failed with HTTP ${createdResponse.status()}`);
    }
    const createdPayload = await createdResponse.json().catch(() => null);
    const responseBundleId = clean(createdPayload?.bundleId || createdPayload?.bundle_id);
    requireEvidence(Boolean(responseBundleId), "CREATED_REQUEST_ID_MISSING");
    createdBundleId = responseBundleId;
    assertRequestState(await ownerJson(`/api/one/information-requests/${encodeURIComponent(createdBundleId)}`), {
      bundleId: createdBundleId, personRef, purpose: PURPOSE, durationSeconds: 172800,
      scopeRefs: [scopeRef], status: "pending",
    });
    await page.getByTestId("specialist-directive-card").waitFor({ state: "hidden", timeout: turnTimeoutMs });
    await verifyAllStartedStreams(page);
    return "exact new request is pending";
  });

  await step("chat: asking what is waiting answers without leaking identifiers", async () => {
    const reply = await turn(page, "What requests are waiting on me?");
    assertNoLeak(reply, "pending reply");
    requireEvidence(!/couldn't|could not|temporarily unavailable/i.test(reply), "PENDING_SUMMARY_UNAVAILABLE");
    requireEvidence(/waiting|no information requests|nothing/i.test(reply), "PENDING_SUMMARY_MISSING");
  });

  await step("chat: the sent request is cancelled after visible confirmation", async () => {
    if (!createdBundleId) {
      throw new Error("No request was created by this rehearsal; refusing to cancel an older request.");
    }
    const ask = await turn(page, "Cancel that request I just sent.", "consent.cancel_request");
    assertNoLeak(ask, "cancel prompt reply");
    const confirm = page.getByTestId("specialist-directive-confirm");
    await confirm.waitFor({ state: "visible", timeout: turnTimeoutMs });
    const cancelled = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/one/information-requests/${encodeURIComponent(createdBundleId)}/cancel` &&
        response.request().method() === "POST",
      { timeout: turnTimeoutMs },
    );
    allowCancel = true;
    await confirm.click();
    const cancelledResponse = await cancelled;
    allowCancel = false;
    if (!cancelledResponse.ok()) {
      throw new Error(`chat cancellation failed with HTTP ${cancelledResponse.status()}`);
    }
    assertRequestState(await ownerJson(`/api/one/information-requests/${encodeURIComponent(createdBundleId)}`), {
      bundleId: createdBundleId, personRef, purpose: PURPOSE, durationSeconds: 172800,
      scopeRefs: [scopeRef], status: "cancelled",
    });
    await page.getByTestId("specialist-directive-card").waitFor({ state: "hidden", timeout: turnTimeoutMs });
    await verifyAllStartedStreams(page);
    return "exact request items are cancelled";
  });

  await step("no internal scope identifier anywhere on the chat surface", async () => {
    assertNoLeak(await page.locator("body").innerText(), "chat surface");
  });
  session.capture.assertNoCriticalApiFailures("consent chat lifecycle");
  await verifyAllStartedStreams(page);
  if (mutationFailure) throw mutationFailure;
} catch (error) {
  // A failure before or between steps must be visible as a failed step, not as
  // a zero-step PASS.
  record("rehearsal aborted", false, { code: safeFailureCode(error) });
} finally {
  // Retain the exact test request and conversation as reviewable history.
  // Never delete baseline-difference conversations from a shared reviewer.
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const failed = results.filter((r) => !r.ok).length || (results.length === 0 ? 1 : 0);
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), sourceSha, runId, preflight, results }, null, 2), { mode: 0o600 });
  fs.chmodSync(reportPath, 0o600);
  process.stdout.write(`[reviewer-app-testing] consent-chat ${failed ? "FAIL" : "PASS"} steps=${results.length} failed=${failed} report=${path.relative(repoRoot, reportPath)}\n`);
  process.exitCode = failed ? 1 : 0;
}
