import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { createCommerceMutationAdmission } from "./scope-commerce-rehearsal-admission.mjs";
import { commerceEvidence, verifyApplicationReadiness, opaqueId } from "./scope-commerce-rehearsal-contract.mjs";
import { matchesOwnerBinding, matchesExpectedJsonDigest } from "./consent-rehearsal-contract.mjs";

/** Browser fetches keep mutations inside the canonical context.route guard. */
export async function commerceCall(session, pathname, body, { owner = false } = {}) {
  const token = owner ? await session.capture.ownerToken() : await session.capture.identityToken();
  commerceEvidence(typeof token === "string" && token.length > 0, "AUTHENTICATED_REVIEWER_TOKEN_REQUIRED");
  return session.page.evaluate(async ({ pathname, body, token }) => {
    const response = await fetch(pathname, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ok: response.ok, status: response.status, value: await response.json().catch(() => null) };
  }, { pathname, body, token });
}

export async function checkedCall(session, pathname, body, options) {
  const response = await commerceCall(session, pathname, body, options);
  commerceEvidence(response.ok, "COMMERCIAL_API_BOUNDARY_FAILED");
  return response.value;
}

export function commercialResponse(page, origin, method, pathname) {
  const waiting = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === pathname && response.request().method() === method;
  }, { timeout: 45_000 });
  // A failed click may close the browser before its pending response arrives.
  // Retain rejection for the caller without an unhandled diagnostic dump.
  void waiting.catch(() => {});
  return waiting;
}

function installCommerceObserver(page) {
  const failures = [];
  page.on("response", response => {
    if (new URL(response.url()).pathname.startsWith("/api/scope-commerce/") && response.status() >= 500) failures.push(response.status());
  });
  return () => commerceEvidence(failures.length === 0, "COMMERCIAL_CRITICAL_API_FAILURE");
}

export async function openCommerceBrowsers(repoRoot, options, preflight) {
  const actors = {};
  let browser;
  try {
    for (const role of ["primary", "counterpart"]) {
      const admission = createCommerceMutationAdmission({ appOrigin: options.appOrigin, role });
      const harness = await createReviewerSessionHarness({ repoRoot, appOrigin: options.appOrigin, timeoutMs: preflight.authMode === "human_authenticated" ? 360_000 : 90_000,
        reviewerIdentity: preflight.identities[role], admitMutation: request => admission.admit(request),
        reviewerTokenProvider: preflight.authMode === "operator_issued_token"
          ? uid => options.reviewerTokenProvider(role, uid) : null });
      if (!browser) browser = await harness.chromium.launch({ headless: preflight.authMode !== "human_authenticated" });
      if (preflight.authMode !== "human_authenticated") await harness.assertVisibleVaultChallenge(browser, "/one");
      const session = await harness.openSession(browser, "/one");
      actors[role] = { role, harness, session, admission, authMode: preflight.authMode,
        verifyExactReadback: options.verifyExactReadback, assertCommerce: installCommerceObserver(session.page) };
      await harness.navigateInApp(session.page, "/one/connect");
      await session.capture.identityToken();
      const readiness = await checkedCall(session, `/api/scope-commerce/sandbox-readiness?app_origin=${encodeURIComponent(options.appOrigin)}`);
      verifyApplicationReadiness(readiness, preflight.proof, options.appOrigin, preflight.schemaHead, preflight.readinessBinding);
      actors[role].observedSchemaHead = readiness.schema_head;
      commerceEvidence(typeof readiness.new_activity_enabled === "boolean", "APPLICATION_ADMISSION_STATE_REQUIRED");
      actors[role].newActivityEnabled = readiness.new_activity_enabled;
    }
    return { browser, actors };
  } catch (error) { await browser?.close(); throw error; }
}

export async function coldCommerceRecovery(runtime, role, destination) {
  const actor = runtime.actors[role];
  const commitment = actor.harness.vaultKeyCommitment(await actor.session.capture.vaultState());
  await actor.session.context.close();
  // The canonical entry owns cold authentication/unlock. A public person route
  // does not automatically mount that challenge; reach it by client navigation.
  if (actor.authMode !== "human_authenticated") await actor.harness.assertVisibleVaultChallenge(runtime.browser, "/one");
  actor.session = await actor.harness.openSession(runtime.browser, "/one");
  actor.assertCommerce = installCommerceObserver(actor.session.page);
  commerceEvidence(actor.harness.vaultKeyCommitment(await actor.session.capture.vaultState()) === commitment,
    "COLD_VAULT_COMMITMENT_MISMATCH");
  await actor.harness.navigateInApp(actor.session.page, destination);
  await actor.harness.assertVaultContinuity(actor.session.page, "cold paid destination");
  await actor.harness.navigateInApp(actor.session.page, "/one/connect");
  await actor.session.capture.identityToken();
}

export async function bindCommerceFixtures(actors, identities, fixtures) {
  for (const [seller, buyer] of [["primary", "counterpart"], ["counterpart", "primary"]]) {
    const session = actors[buyer].session;
    let bound = false;
    for (let number = 1; number <= 100; number += 1) {
      const page = await checkedCall(session, `/api/one/connections?page=${number}&limit=50&audience=all`);
      if (matchesOwnerBinding(page.items, identities[seller].reviewerUid, fixtures[seller].personRef)) { bound = true; break; }
      if (!page.hasMore) break;
    }
    commerceEvidence(bound, "SYNTHETIC_OWNER_CONNECTION_REQUIRED");
    const connector = await checkedCall(session, `/api/one/kyc/client-connector?user_id=${encodeURIComponent(identities[buyer].reviewerUid)}`, undefined, { owner: true });
    commerceEvidence(opaqueId(connector.connector?.connector_key_id), "EXISTING_REGISTERED_RECIPIENT_REQUIRED");
    actors[buyer].connectorKeyId = connector.connector.connector_key_id;
  }
}

export async function assertNoExport(actor, record) {
  const token = await actor.session.capture.ownerToken();
  const evidence = await actor.session.page.evaluate(async ({ bundleId, token, requestId }) => {
    const response = await fetch(`/api/one/information-requests/${encodeURIComponent(bundleId)}/exports`, {
      cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    const exports = Array.isArray(body?.exports) ? body.exports : [];
    return { denied: response.status === 403 || response.status === 404 ||
      response.ok && Array.isArray(body?.exports) && !exports.some(item => item.request_id === requestId || item.requestId === requestId),
    };
  }, { bundleId: record.bundleId, token, requestId: record.requestId });
  commerceEvidence(evidence.denied, "INACTIVE_EXPORT_WAS_DELIVERED");
}

export async function exactCommerceReadback(actor, record, fixture) {
  await actor.harness.navigateInApp(actor.session.page, `/people/${encodeURIComponent(fixture.personRef)}`);
  const profile = await checkedCall(actor.session, `/api/one/people/${encodeURIComponent(fixture.personRef)}`);
  // Profile intentionally lists one representative per shared section. Its
  // presentation never substitutes for the original purchase's exact proof.
  const exactAdapter = typeof actor.verifyExactReadback === "function";
  const representative = profile.grants?.find(grant =>
    grant.scopeRef === fixture.scopeRef && grant.status === "granted" && opaqueId(grant.requestId) &&
    (exactAdapter || grant.requestId === record.requestId));
  commerceEvidence(profile.personRef === fixture.personRef && representative, "PAID_ACTIVE_PROFILE_BINDING_MISMATCH");
  const headingId = `shared-item-${representative.requestId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const secureCard = actor.session.page.locator(`article[aria-labelledby="${headingId}"]`);
  if (typeof actor.verifyExactReadback === "function") {
    await secureCard.waitFor({ state: "visible", timeout: 45_000 });
    await actor.session.page.waitForFunction(id => {
      const article = document.getElementById(id)?.closest("article");
      return article?.dataset.itemState === "ready" &&
        article.querySelector('[data-testid="shared-with-you-values"]')?.getAttribute("data-hidden") === "false";
    }, headingId, { timeout: 45_000 });
    // The formatted card is intentionally lossy. It proves reachable delivery;
    // a separately source-bound browser crypto adapter proves exact projected JSON.
    const proof = await actor.verifyExactReadback(actor, record, fixture, representative.requestId);
    commerceEvidence(proof?.passed === true && proof.canonical_recipient_decryption === true &&
      proof.exact_projected_payload === true && proof.current_grant === true &&
      proof.current_paid_term === true, "EXACT_PAID_BROWSER_READBACK_MISMATCH");
  } else {
    const card = actor.session.page.getByTestId(`grant-card-${record.requestId}`);
    await card.waitFor({ state: "visible", timeout: 45_000 });
    if (await card.getByTestId("person-profile-grant-reveal").isVisible().catch(() => false)) await card.getByTestId("person-profile-grant-reveal").click();
    await card.getByRole("button", { name: "JSON", exact: true }).click();
    const matched = await card.locator('pre[data-testid="person-profile-grant-value"]').evaluate(matchesExpectedJsonDigest, fixture.expectedPayloadSha256);
    commerceEvidence(matched, "EXACT_PAID_BROWSER_READBACK_MISMATCH");
    await card.getByRole("button", { name: "Formatted", exact: true }).click();
  }
  await actor.harness.assertVaultContinuity(actor.session.page, "paid exact readback");
  actor.session.capture.assertNoCriticalApiFailures("paid exact readback");
  actor.session.readOnlyGuard.assertNoBlockedMutation(); actor.assertCommerce();
}

export function assertCommerceSessions(actors) {
  for (const actor of Object.values(actors)) {
    actor.session.readOnlyGuard.assertNoBlockedMutation();
    actor.session.capture.assertNoCriticalApiFailures("paid rehearsal");
    actor.assertCommerce();
  }
}
