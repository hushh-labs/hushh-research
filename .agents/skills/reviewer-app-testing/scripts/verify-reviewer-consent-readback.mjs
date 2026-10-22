import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { matchesExpectedJson } from "./consent-rehearsal-contract.mjs";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const appOrigin = process.env.REVIEWER_APP_ORIGIN || "http://localhost:3001";

const expectedBundleId = String(process.env.REVIEWER_EXPECTED_BUNDLE_ID || "");
const expectedRequestId = String(process.env.REVIEWER_EXPECTED_REQUEST_ID || "");
const expectedScopeRef = String(process.env.REVIEWER_CONSENT_SCOPE_REF || "");
let expectedPayload;
try { expectedPayload = JSON.parse(process.env.REVIEWER_EXPECTED_PAYLOAD_JSON || ""); }
catch { throw new Error("Explicit synthetic expected payload is required in process memory."); }
if (!expectedBundleId || !expectedRequestId || !expectedScopeRef || !expectedPayload ||
  typeof expectedPayload !== "object" || !process.env.REVIEWER_COUNTERPART_PERSON_REF) {
  throw new Error("Exact reviewer, request, scope and synthetic payload bindings are required.");
}

async function assertExactBrowserReadback(card) {
  await card.getByRole("button", { name: "JSON", exact: true }).click();
  const matches = await card.locator('pre[data-testid="person-profile-grant-value"]')
    .evaluate(matchesExpectedJson, expectedPayload);
  await card.getByRole("button", { name: "Formatted", exact: true }).click();
  if (!matches) throw new Error("Exact synthetic scoped payload mismatch.");
  return true;
}

await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({
  repoRoot,
  appOrigin,
  timeoutMs: 120000,
});
const browser = await reviewer.chromium.launch({ headless: true, timeout: 30000 });
let session;
let phase = "launch";
const startedAt = Date.now();
const responseSummary = [];
try {
  phase = "open-session";
  session = await reviewer.openSession(browser, "/");
  // Never retain console payloads: they may contain decrypted information.
  session.page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.includes("/kyc/client-connector") && !path.endsWith("/exports")) return;
    responseSummary.push({ path: path.includes("/kyc/client-connector") ? "client-connector" : "exports", status: response.status(), contentLength: (await response.body().catch(() => new Uint8Array())).byteLength });
  });
  const ownerRef = process.env.REVIEWER_COUNTERPART_PERSON_REF;
  phase = "navigate-profile";
  await reviewer.navigateInApp(session.page, `/people/${encodeURIComponent(ownerRef)}`);
  phase = "wait-profile";
  await session.page.getByTestId("person-profile-available").waitFor({ timeout: 120000 });
  phase = "fetch-profile";
  const token = await session.capture.identityToken();
  const response = await session.page.request.get(`/api/one/people/${encodeURIComponent(ownerRef)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => null);
  const grants = Array.isArray(payload?.grants) ? payload.grants : [];
  const history = Array.isArray(payload?.requestHistory) ? payload.requestHistory : [];
  if (!response.ok() || payload?.personRef !== ownerRef) throw new Error("Expected person profile unavailable.");
  const granted = grants.find(item => item?.status === "granted" && item.requestId === expectedRequestId
    && item.scopeRef === expectedScopeRef);
  if (!granted) throw new Error("No retained approved grant was available for readback.");
  phase = "match-history";
  const historyRow = history.find(item => item?.requestId === expectedRequestId && item?.status === "granted"
    && item.bundleId === expectedBundleId && item.scopeRef === expectedScopeRef);
  if (!historyRow) throw new Error("Approved grant history did not match the retained grant.");
  phase = "probe-export";
  const exportProbeStartedAt = Date.now();
  const ownerToken = await session.capture.ownerToken();
  const exportProbe = await session.page.request.get(
    `/api/one/information-requests/${encodeURIComponent(historyRow.bundleId)}/exports`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  const exportProbePayload = await exportProbe.json().catch(() => null);
  if (!exportProbe.ok()) {
    throw new Error(`Export probe failed with HTTP ${exportProbe.status()}.`);
  }
  const exportProbeSummary = {
    status: exportProbe.status(),
    elapsedMs: Date.now() - exportProbeStartedAt,
    count: Array.isArray(exportProbePayload?.exports) ? exportProbePayload.exports.length : -1,
  };
  phase = "wait-grant-card";
  const card = session.page.getByTestId(`grant-card-${granted.requestId}`);
  await card.waitFor({ state: "visible", timeout: 120000 });
  const rendered = card.getByTestId("person-profile-grant-value");
  try {
    phase = "wait-rendered-value";
    await rendered.first().waitFor({ timeout: 10000 });
  } catch {
    phase = "reveal-grant";
    const reveal = card.getByTestId("person-profile-grant-reveal");
    await reveal.waitFor({ state: "visible", timeout: 10000 });
    await reveal.click();
    await rendered.first().waitFor({ timeout: 10000 });
  }
  const expectedFixtureMatched = await assertExactBrowserReadback(card);
  phase = "vault-continuity";
  await reviewer.assertVaultContinuity(session.page, "approved grant readback");
  phase = "critical-api-check";
  session.capture.assertNoCriticalApiFailures("approved grant readback");
  phase = "cold-session-reunlock";
  await session.context.close();
  session = await reviewer.openSession(browser, "/");
  await reviewer.navigateInApp(session.page, `/people/${encodeURIComponent(ownerRef)}`);
  await session.page.getByTestId("person-profile-available").waitFor({ timeout: 120000 });
  const coldToken = await session.capture.identityToken();
  const coldProfile = await session.page.request.get(`/api/one/people/${encodeURIComponent(ownerRef)}`, {
    headers: { Authorization: `Bearer ${coldToken}` },
  });
  const coldPayload = await coldProfile.json().catch(() => null);
  if (!coldProfile.ok() || coldPayload?.personRef !== ownerRef) throw new Error("Cold recipient mismatch.");
  const coldGrant = (Array.isArray(coldPayload?.grants) ? coldPayload.grants : []).find(item =>
    item?.status === "granted" && item?.requestId === expectedRequestId && item.scopeRef === expectedScopeRef);
  const coldHistory = coldPayload.requestHistory?.find(item => item.requestId === expectedRequestId &&
    item.bundleId === expectedBundleId && item.scopeRef === expectedScopeRef && item.status === "granted");
  if (!coldHistory) throw new Error("Cold request binding mismatch.");
  if (!coldGrant) throw new Error("Approved grant was not restored after cold re-unlock.");
  const coldCard = session.page.getByTestId(`grant-card-${granted.requestId}`);
  await coldCard.waitFor({ state: "visible", timeout: 120000 });
  const coldRendered = coldCard.getByTestId("person-profile-grant-value");
  try {
    await coldRendered.first().waitFor({ timeout: 10000 });
  } catch {
    const coldReveal = coldCard.getByTestId("person-profile-grant-reveal");
    await coldReveal.waitFor({ state: "visible", timeout: 10000 });
    await coldReveal.click();
    await coldRendered.first().waitFor({ timeout: 10000 });
  }
  const coldFixtureMatched = await assertExactBrowserReadback(coldCard);
  await reviewer.assertVaultContinuity(session.page, "cold approved grant readback");
  session.capture.assertNoCriticalApiFailures("cold approved grant readback");
  console.log(JSON.stringify({
    passed: true,
    profileStatus: response.status(),
    grantedHistoryMatch: true,
    exportProbe: exportProbeSummary,
    renderedEncryptedReadback: true,
    expectedFixtureMatched,
    sameSessionVaultContinuity: true,
    coldSessionReunlock: true,
    coldFixtureMatched,
  }));
} catch {
  const ui = await session?.page.evaluate(() => ({
    alertCount: document.querySelectorAll('[role="alert"]').length,
    statusCount: document.querySelectorAll('[role="status"]').length,
    cardPresent: Boolean(document.querySelector('[data-testid^="grant-card-"]')),
    decryptButtonPresent: Boolean(document.querySelector('[data-testid="person-profile-grant-reveal"]')),
    visibleValueCount: [...document.querySelectorAll('[data-testid="person-profile-grant-value"]')]
      .filter(node => node.getClientRects().length > 0).length,
  })).catch(() => null);
  console.log(JSON.stringify({
    passed: false,
    errorCode: "READBACK_ASSERTION_FAILED",
    phase,
    elapsedMs: Date.now() - startedAt,
    ui,
    responseSummary,
  }));
  process.exitCode = 1;
} finally {
  await session?.context.close();
  await browser.close();
}
