import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { resolveReviewerTestIdentity, resolveReviewerCounterpartIdentity, defaultReviewerIdentityEnvFiles } from "../../../../hushh-webapp/scripts/testing/reviewer-test-identity.mjs";
import { requireEvidence, createDraftAdmission, assertRequestState, matchesExpectedJson, safeFailureCode, matchesOwnerBinding, assertGrantTiming } from "./consent-rehearsal-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const appOrigin = process.env.REVIEWER_APP_ORIGIN || "http://localhost:3003";
let phase = "preflight", browser, bundle, requestId, violation = false;
const sessions = [];
const proof = {};
const purpose = `Synthetic consent acceptance ${randomUUID()}`;
const ownerRef = process.env.REVIEWER_PERSON_REF;
const scopeRef = process.env.REVIEWER_CONSENT_SCOPE_REF;
let allowSubmit = false, allowApproval = false;
let approvalExpiry = null;
let approvalStartedAt = null, approvalCompletedAt = null;

try {
  requireEvidence(process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true", "MUTATION_AUTHORITY_REQUIRED");
  requireEvidence(Boolean(ownerRef && scopeRef && process.env.REVIEWER_UID && process.env.REVIEWER_COUNTERPART_UID), "EXPLICIT_PAIR_AND_SCOPE_REQUIRED");
  const expectedPayload = JSON.parse(process.env.REVIEWER_EXPECTED_PAYLOAD_JSON || "null");
  requireEvidence(expectedPayload && typeof expectedPayload === "object" && !Array.isArray(expectedPayload)
    && Object.keys(expectedPayload).length > 0, "EXACT_SYNTHETIC_PAYLOAD_REQUIRED");
  await prepareReviewerRehearsal({ repoRoot, appOrigin });
  const options = { envFiles: defaultReviewerIdentityEnvFiles({ repoRoot, webDir: path.join(repoRoot, "hushh-webapp") }) };
  const identities = [resolveReviewerTestIdentity(options), resolveReviewerCounterpartIdentity(options)];
  requireEvidence(identities[0].reviewerUid === process.env.REVIEWER_UID && identities[1].reviewerUid === process.env.REVIEWER_COUNTERPART_UID
    && identities[0].reviewerUid !== identities[1].reviewerUid, "REVIEWER_PAIR_MISMATCH");
  const expected = { personRef: ownerRef, purpose, durationSeconds: 86400, scopeRefs: [scopeRef] };
  const admit = createDraftAdmission(expected);
  const harnesses = await Promise.all(identities.map((reviewerIdentity, index) => createReviewerSessionHarness({
    repoRoot, appOrigin, reviewerIdentity, timeoutMs: 120000,
    admitMutation: request => {
      const pathname = new URL(request.url()).pathname;
      if (index === 1 && allowSubmit && request.method() === "POST" && pathname === "/api/one/information-requests") {
        admit(request.postDataJSON());
        return true;
      }
      if (index === 0 && allowApproval && request.method() === "POST" && pathname === "/api/consent/pending/approve") {
        const body = request.postDataJSON();
        requireEvidence(body.requestId === requestId && body.userId === identities[0].reviewerUid
          && body.durationHours === 24, "APPROVAL_BINDING_MISMATCH");
        const expiry = body.exportEnvelope?.aad?.expires_at_ms;
        requireEvidence(Number.isFinite(expiry) && Math.abs(expiry - Date.now() - 86400000) < 60000,
          "APPROVAL_EXPIRY_MISMATCH");
        approvalExpiry = expiry;
        return true;
      }
      if (index === 0 && phase === "approve" && request.method() === "POST" && pathname === "/api/consent/pending/opened") {
        const body = request.postDataJSON();
        requireEvidence(body.userId === identities[0].reviewerUid && body.requestId === requestId
          && (!body.bundleId || body.bundleId === bundle.bundleId), "ACKNOWLEDGEMENT_BINDING_MISMATCH");
        return true;
      }
      violation = true;
      return false;
    },
  })));
  browser = await harnesses[0].chromium.launch({ headless: true });
  phase = "unlock";
  for (const harness of harnesses) {
    await harness.assertVisibleVaultChallenge(browser, "/one");
    sessions.push(await harness.openSession(browser, "/one"));
  }
  const [owner, requester] = sessions;
  // Use the existing permission-bounded connection projection, never a name
  // match or an operator-provided public reference alone.
  phase = "bind-owner";
  const requesterIdentityToken = await requester.capture.identityToken();
  let boundOwner = false;
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const response = await requester.page.request.get(`/api/one/connections?page=${pageNumber}&limit=50&audience=all`, {
      headers: { Authorization: `Bearer ${requesterIdentityToken}`, "Cache-Control": "no-store" }, timeout: 30000,
    });
    requireEvidence(response.ok(), "OWNER_BINDING_UNAVAILABLE");
    const connections = await response.json();
    if (matchesOwnerBinding(connections.items, identities[0].reviewerUid, ownerRef)) {
      boundOwner = true;
      break;
    }
    if (!connections.hasMore) break;
  }
  requireEvidence(boundOwner, "OWNER_BINDING_UNAVAILABLE");
  const origin = new URL(appOrigin).origin;
  const responseFor = (page, method, pathname) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === pathname && response.request().method() === method;
  }, { timeout: 120000 });
  const readState = async status => {
    const token = await requester.capture.ownerToken();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await requester.page.request.get(`/api/one/information-requests/${encodeURIComponent(bundle.bundleId)}`, { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" }, timeout: 30000 });
      const payload = await response.json().catch(() => null);
      const awaitingGrant = status === "granted" && attempt < 4 && payload?.items?.length > 0
        && payload.items.every(item => item.status === "pending");
      const checked = assertRequestState({ ok: response.ok(), payload }, {
        ...expected, bundleId: bundle.bundleId, requestIds: [requestId], status: awaitingGrant ? "pending" : status,
      });
      if (!awaitingGrant) return checked;
      await requester.page.waitForTimeout(500);
    }
  };

  phase = "discover";
  const profilePath = `/api/one/people/${encodeURIComponent(ownerRef)}`;
  const profileResponse = responseFor(requester.page, "GET", profilePath);
  await harnesses[1].navigateInApp(requester.page, `/people/${encodeURIComponent(ownerRef)}`);
  const first = await profileResponse;
  requireEvidence(first.ok(), "CATALOG_UNAVAILABLE");
  let page = await first.json();
  requireEvidence(page.personRef === ownerRef, "CATALOG_RECIPIENT_MISMATCH");
  const ownerDisplayName = page.displayName;
  requireEvidence(typeof ownerDisplayName === "string" && ownerDisplayName.length > 0, "OWNER_LABEL_UNAVAILABLE");
  const revision = page.scopeCatalog?.catalogRevision;
  requireEvidence(typeof revision === "string" && revision.length > 0, "CATALOG_REVISION_MISSING");
  let scope = page.requestableScopes?.find(item => item.scopeRef === scopeRef);
  const previousIds = new Set((page.requestHistory || []).map(item => item.requestId));
  for (let count = 0; !scope && page.scopeCatalog?.hasMore && count < 100; count += 1) {
    const next = responseFor(requester.page, "GET", profilePath);
    await requester.page.getByRole("button", { name: /^(Load more information|Load more fields)$/ }).click();
    const response = await next;
    requireEvidence(response.ok(), "CATALOG_PAGE_UNAVAILABLE");
    page = await response.json();
    requireEvidence(page.personRef === ownerRef && page.scopeCatalog?.catalogRevision === revision, "CATALOG_CHANGED");
    scope = page.requestableScopes?.find(item => item.scopeRef === scopeRef);
  }
  requireEvidence(scope, "EXACT_SYNTHETIC_SCOPE_UNAVAILABLE");
  proof.discovered = true;
  const available = requester.page.getByTestId("person-profile-available");
  await available.getByTestId("person-profile-scope-search").fill(scope.label);
  const toggle = available.getByTestId(`person-profile-scope-toggle-${scopeRef}`);
  for (let depth = 0; !(await toggle.count()) && depth < 12; depth += 1) {
    await available.getByRole("button", { name: /^Open / }).first().click();
  }
  await toggle.check();
  phase = "review";
  await requester.page.locator('[data-voice-control-id="person-profile-review-information"]').click();
  const dialog = requester.page.getByRole("dialog");
  requireEvidence(await dialog.getByRole("heading", { name: `Request information from ${ownerDisplayName}`, exact: true }).count() === 1, "REVIEW_RECIPIENT_MISSING");
  await dialog.getByTestId("person-profile-purpose").fill(purpose);
  await dialog.getByTestId("person-profile-duration-select").selectOption("24");
  requireEvidence(await dialog.getByText(scope.label, { exact: true }).count() > 0, "REVIEW_SCOPE_MISSING");
  requireEvidence(await dialog.getByTestId("person-profile-purpose").inputValue() === purpose
    && await dialog.getByTestId("person-profile-duration-select").inputValue() === "24", "REVIEW_DETAILS_MISMATCH");
  const send = dialog.getByRole("button", { name: "Send request", exact: true });
  await send.click({ trial: true });
  requester.readOnlyGuard.assertNoBlockedMutation();
  owner.readOnlyGuard.assertNoBlockedMutation();
  phase = "submit";
  const created = responseFor(requester.page, "POST", "/api/one/information-requests");
  allowSubmit = true;
  await send.click();
  const response = await created;
  allowSubmit = false;
  requireEvidence(response.ok() && !violation, "SUBMISSION_FAILED");
  bundle = await response.json();
  requestId = bundle.items?.[0]?.requestId;
  requireEvidence(Boolean(bundle.bundleId && requestId) && !previousIds.has(requestId), "FRESH_REQUEST_REQUIRED");
  await readState("pending");
  proof.submitted = true;

  phase = "approve";
  await harnesses[0].navigateInApp(owner.page, `/one/consent?tab=requests&requestId=${encodeURIComponent(requestId)}`);
  const approve = owner.page.locator('[data-voice-control-id="consent_approve"]');
  await approve.waitFor({ state: "visible", timeout: 120000 });
  requireEvidence(await approve.count() === 1, "APPROVAL_SELECTION_AMBIGUOUS");
  requireEvidence(await owner.page.getByText(purpose, { exact: true }).count() > 0, "APPROVAL_PURPOSE_MISSING");
  owner.readOnlyGuard.assertNoBlockedMutation();
  requester.readOnlyGuard.assertNoBlockedMutation();
  const approved = responseFor(owner.page, "POST", "/api/consent/pending/approve");
  approvalStartedAt = Date.now();
  allowApproval = true;
  await approve.click();
  const approval = await approved;
  approvalCompletedAt = Date.now();
  allowApproval = false;
  requireEvidence(approval.ok() && !violation, "APPROVAL_FAILED");
  await readState("granted");
  proof.approved = true;

  const readback = async (session, harness) => {
    await harness.navigateInApp(session.page, "/one");
    await harness.navigateInApp(session.page, `/people/${encodeURIComponent(ownerRef)}`);
    const token = await session.capture.identityToken();
    const response = await session.page.request.get(profilePath, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    const profile = await response.json();
    requireEvidence(response.ok() && profile.personRef === ownerRef, "READBACK_PERSON_MISMATCH");
    requireEvidence(profile.grants?.some(item => item.requestId === requestId && item.scopeRef === scopeRef && item.status === "granted")
      && profile.requestHistory?.some(item => item.requestId === requestId && item.bundleId === bundle.bundleId && item.scopeRef === scopeRef && item.status === "granted"), "READBACK_GRANT_MISMATCH");
    const grant = profile.grants.find(item => item.requestId === requestId && item.scopeRef === scopeRef);
    assertGrantTiming(grant, approvalExpiry, approvalStartedAt, approvalCompletedAt);
    const card = session.page.getByTestId(`grant-card-${requestId}`);
    await card.waitFor({ state: "visible", timeout: 120000 });
    if (await card.getByTestId("person-profile-grant-reveal").isVisible().catch(() => false)) await card.getByTestId("person-profile-grant-reveal").click();
    await card.getByRole("button", { name: "JSON", exact: true }).click({ timeout: 120000 });
    requireEvidence(await card.locator('pre[data-testid="person-profile-grant-value"]').evaluate(matchesExpectedJson, expectedPayload), "EXACT_READBACK_MISMATCH");
    await card.getByRole("button", { name: "Formatted", exact: true }).click();
    await harness.assertVaultContinuity(session.page, "exact profile readback");
    session.capture.assertNoCriticalApiFailures("exact profile readback");
    session.readOnlyGuard.assertNoBlockedMutation();
  };
  phase = "same-session-readback";
  await readback(requester, harnesses[1]);
  await harnesses[0].assertVaultContinuity(owner.page, "owner approval");
  owner.capture.assertNoCriticalApiFailures("owner approval");
  owner.readOnlyGuard.assertNoBlockedMutation();
  proof.sameSessionReadback = true;
  const firstKeyCommitment = harnesses[1].vaultKeyCommitment(await requester.capture.vaultState());
  await requester.context.close();
  phase = "cold-readback";
  await harnesses[1].assertVisibleVaultChallenge(browser, "/one");
  const cold = await harnesses[1].openSession(browser, "/one");
  sessions.push(cold);
  await readback(cold, harnesses[1]);
  requireEvidence(harnesses[1].vaultKeyCommitment(await cold.capture.vaultState()) === firstKeyCommitment, "COLD_VAULT_COMMITMENT_MISMATCH");
  proof.coldReadback = true;
  requireEvidence(!violation, "MUTATION_BINDING_VIOLATION");
  console.log(JSON.stringify({ passed: true, phase, ...proof, approvedGrantRetained: true }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, phase, code: safeFailureCode(error), ...proof, createdRequestRetained: Boolean(bundle) }));
  process.exitCode = 1;
} finally {
  for (const session of sessions) await session.context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
