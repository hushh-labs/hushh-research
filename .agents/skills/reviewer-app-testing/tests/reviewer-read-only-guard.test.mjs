import assert from "node:assert/strict";
import { borrowedPage } from "./fixtures/borrowed-reviewer-page.mjs";
import test from "node:test";
import vm from "node:vm";

import { createReviewerSessionHarness, installReadOnlyMutationGuard, installReviewerBridge } from "../scripts/reviewer-session-harness.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommerceMutationAdmission } from "../scripts/scope-commerce-rehearsal-admission.mjs";
import { validateCommerceState, actionId, acquireCommerceStateLease, saveCommerceState, loadCommerceState } from "../scripts/scope-commerce-rehearsal-state.mjs";
import { verifyPreparation, verifyQuote, unusedCalendarRefund, commerceMoneyButtonName } from "../scripts/scope-commerce-rehearsal-contract.mjs";
import { syntheticState } from "./fixtures/synthetic-commerce-state.mjs";
import { parseCommerceArguments } from "../scripts/verify-reviewer-scope-commerce.mjs";
import { createOperatorReviewerTokenProvider } from "../scripts/reviewer-operator-token-provider.mjs";
import { exactCommerceReadback } from "../scripts/scope-commerce-rehearsal-browser.mjs";

const APP_ORIGIN = "https://uat.one.hushh.ai";

test("explicit-login bridge leaves logout landing anonymous without unlock material", () => {
  for (const [pathname, origin, frame, permitted] of [
    ["/login", APP_ORIGIN, false, true], ["/", APP_ORIGIN, false, false],
    ["/one/pkm", APP_ORIGIN, false, false], ["/login", "https://other.example", false, false],
    ["/login", APP_ORIGIN, true, false],
  ]) {
    const window = { __HUSHH_NATIVE_TEST__: { vaultPassphrase: "old", reviewerSessionPassphrase: "old" } };
    window.top = frame ? {} : window;
    vm.runInNewContext(`(${installReviewerBridge.toString()})(config)`, { window,
      location: { pathname, origin }, config: { explicitLoginOnly: true, appOrigin: APP_ORIGIN,
        expectedUserId: "reviewer", vaultPassphrase: "test-unlock", reviewerSessionPassphrase: "test-mint",
        reviewerMutationPolicy: "bounded_mutation", reviewerAuthMode: "custom_token" } });
    const bridge = window.__HUSHH_NATIVE_TEST__;
    assert.equal(bridge.autoReviewerLogin, permitted);
    assert.equal(bridge.vaultPassphrase, permitted ? "test-unlock" : undefined);
    assert.equal(bridge.reviewerSessionPassphrase, permitted ? "test-mint" : undefined);
  }
});


test("secure paid readback requires a visible current card and every exact-proof assertion", async () => {
  const originalDocument = globalThis.document;
  const record = { requestId: "synthetic-request" }, fixture = { personRef: "synthetic-person", scopeRef: "synthetic-scope" };
  const complete = { passed: true, canonical_recipient_decryption: true, exact_projected_payload: true,
    current_grant: true, current_paid_term: true };
  try {
    for (const failure of [null, ...Object.keys(complete), "unready", "hidden", "representative", "representativeRevoked", "representativeWithoutAdapter", "wrongPerson", "wrongScope"]) {
      let invoked = false;
      const proof = { ...complete, ...(failure in complete ? { [failure]: false } : {}), ...(failure === "representativeRevoked" ? { current_grant: false } : {}) };
      const representativeId = failure?.startsWith("representative") ? "synthetic-representative" : record.requestId;
      globalThis.document = { getElementById: () => ({ closest: () => ({
        dataset: { itemState: failure === "unready" ? "loading" : "ready" },
        querySelector: () => ({ getAttribute: () => failure === "hidden" ? "true" : "false" }),
      }) }) };
      const actor = {
        harness: { navigateInApp: async () => {}, assertVaultContinuity: async () => {} },
        session: { page: { evaluate: async () => ({ ok: true, value: { personRef: failure === "wrongPerson" ? "another-person" : fixture.personRef,
          grants: [{ requestId: representativeId, scopeRef: failure === "wrongScope" ? "another-scope" : fixture.scopeRef, status: "granted" }] } }),
          locator: () => ({ waitFor: async () => {} }),
          waitForFunction: async (predicate, id) => { if (!predicate(id)) throw Error("CARD_NOT_READY"); } },
          capture: { identityToken: async () => "synthetic-token", assertNoCriticalApiFailures() {} },
          readOnlyGuard: { assertNoBlockedMutation() {} } },
        assertCommerce() {},
        verifyExactReadback: async (_actor, original, originalFixture, presentedRequestId) => {
          assert.equal(original, record); assert.equal(originalFixture, fixture);
          assert.equal(presentedRequestId, representativeId); invoked = true; return proof;
        },
      };
      if (failure === "representativeWithoutAdapter") delete actor.verifyExactReadback;
      if (failure === null || failure === "representative") await exactCommerceReadback(actor, record, fixture);
      else await assert.rejects(exactCommerceReadback(actor, record, fixture),
        /EXACT_PAID_BROWSER_READBACK_MISMATCH|CARD_NOT_READY|PAID_ACTIVE_PROFILE_BINDING_MISMATCH/);
      assert.equal(invoked, !["unready", "hidden", "wrongPerson", "wrongScope", "representativeWithoutAdapter"].includes(failure));
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("operator token transport enforces its explicit finite budget without retaining private output", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hussh-operator-budget-"));
  const configuration = { repoRoot, appOrigin: APP_ORIGIN, reviewerBindingFile: "synthetic-binding" };
  try {
    for (const timeoutMs of [0, -1, NaN, Infinity, 180_001]) {
      assert.throws(() => createOperatorReviewerTokenProvider({ ...configuration, timeoutMs }), /budget refused/);
    }
    const executable = path.join(repoRoot, "consent-protocol/.venv/bin/python");
    const script = path.join(repoRoot, ".agents/skills/reviewer-app-testing/scripts/reviewer_operator_token.py");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o700 });
    await fs.writeFile(script, `let input = ""; process.stdin.on("data", part => input += part); process.stdin.on("end", () => {
      const binding = JSON.parse(input);
      if (binding.requested_uid !== "synthetic-owner" || binding.app_origin !== "${APP_ORIGIN}") process.exit(1);
      process.stderr.write("synthetic-private-diagnostic");
      setTimeout(() => process.stdout.write("synthetic-token"), 100);
    });`);
    assert.equal(await createOperatorReviewerTokenProvider({ ...configuration, timeoutMs: 5_000 })("synthetic-owner"), "synthetic-token");
    await assert.rejects(createOperatorReviewerTokenProvider({ ...configuration, timeoutMs: 1 })("synthetic-owner"), /^Error: Operator reviewer token unavailable\.$/);
    const pidFile = path.join(repoRoot, "synthetic-issuer-pid");
    await fs.writeFile(script, `const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.stdout.write("synthetic-private-partial-token");
      process.stderr.write("synthetic-private-diagnostic");
      setInterval(() => process.stdout.write("synthetic-private-late-output"), 50);
    `);
    let issuerPid;
    try {
      await assert.rejects(createOperatorReviewerTokenProvider({ ...configuration, timeoutMs: 2_000 })("synthetic-owner"), /^Error: Operator reviewer token unavailable\.$/);
      issuerPid = Number(await fs.readFile(pidFile, "utf8"));
      assert.throws(() => process.kill(issuerPid, 0), { code: "ESRCH" });
      issuerPid = 0;
    } finally {
      issuerPid ??= Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
      if (issuerPid > 0) {
        try { process.kill(issuerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  } finally { await fs.rm(repoRoot, { recursive: true, force: true }); }
});

test("cold operator admission waits for the owner-bound challenge without injecting a passphrase", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hussh-cold-admission-"));
  const previousMode = process.env.REVIEWER_AUTH_MODE;
  let now = 0;
  let closed = false;
  t.mock.method(Date, "now", () => now);
  try {
    process.env.REVIEWER_AUTH_MODE = "operator_issued_token";
    const webDir = path.join(repoRoot, "hushh-webapp");
    await fs.mkdir(path.join(webDir, "node_modules/playwright"), { recursive: true });
    await fs.mkdir(path.join(webDir, "scripts/testing"), { recursive: true });
    await fs.writeFile(path.join(webDir, "package.json"), "{}");
    await fs.writeFile(path.join(webDir, "node_modules/playwright/index.js"), "module.exports = { chromium: {} };");
    await fs.writeFile(path.join(webDir, "scripts/testing/reviewer-test-identity.mjs"), "export {};");
    const harness = await createReviewerSessionHarness({ repoRoot, appOrigin: APP_ORIGIN, timeoutMs: 180_000,
      reviewerIdentity: { reviewerUid: "synthetic-owner", reviewerVaultPassphrase: "synthetic-private-phrase" },
      reviewerTokenProvider: async () => "synthetic-token" });
    const events = new Map();
    const page = {
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on: (name, callback) => events.set(name, callback), exposeBinding: async () => {},
      addInitScript: async (_script, args) => assert.equal(args.vaultPassphrase, ""),
      goto: async () => {}, waitForFunction: async () => {},
      getByRole: () => ({ isVisible: async () => false, first() { return this; } }),
      getByTestId: id => { assert.equal(id, "vault-use-passphrase-instead"); return { isVisible: async () => false }; },
      locator: selector => { assert.ok(["#unlock-passphrase", '[data-testid="vault-use-passphrase-instead"]'].includes(selector)); return { isVisible: async () => selector === "#unlock-passphrase" }; },
      evaluate: async (_script, expectedUid) => {
        if (expectedUid === undefined) return { path: "/login", title: "Synthetic admission", bootstrapState: "authenticating" };
        assert.equal(expectedUid, "synthetic-owner");
        return { matches: now >= 88_000, userMatches: now >= 88_000, state: now >= 88_000 ? "authenticated" : "authenticating" };
      },
      waitForTimeout: async delay => { now += delay; },
    };
    await harness.assertVisibleVaultChallenge({ newContext: async () => ({
      newPage: async () => page, route: async () => {}, close: async () => { closed = true; },
    }) }, "/one");
    assert.equal(now, 88_000);
    assert.equal(closed, true);
    const session = await harness.openSession({ newContext: async () => ({
      newPage: async () => page, route: async () => {}, close: async () => {},
    }) }, "/one/setup", { requireVaultUnlocked: false, allowFirstRunSetupRedirect: true });
    const request = async (origin, pathname, token) => events.get("request")({
      url: () => origin + pathname, allHeaders: async () => ({ authorization: "Bearer " + token }),
    });
    await request(APP_ORIGIN, "/api/vault/bootstrap-state", "synthetic-identity-token");
    await request(APP_ORIGIN, "/api/pkm/manifest", "synthetic-owner-token");
    await request("https://foreign.example", "/api/vault/bootstrap-state", "synthetic-foreign-token");
    await request("https://foreign.example", "/api/pkm/manifest", "synthetic-foreign-token");
    assert.equal(await session.capture.identityToken(), "synthetic-identity-token");
    assert.equal(await session.capture.ownerToken(), "synthetic-owner-token");
    for (const [origin, commitment] of [[APP_ORIGIN, "synthetic-real-commitment"], ["https://foreign.example", "synthetic-foreign-commitment"]]) {
      events.get("response")({ url: () => origin + "/api/vault/get", status: () => 200, ok: () => true,
        json: async () => ({ vaultKeyHash: commitment }) });
    }
    assert.equal((await session.capture.vaultState()).vaultKeyHash, "synthetic-real-commitment");
  } finally {
    if (previousMode === undefined) delete process.env.REVIEWER_AUTH_MODE;
    else process.env.REVIEWER_AUTH_MODE = previousMode;
    t.mock.restoreAll();
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

function requestFor(handler, method, url, body = undefined) {
  const result = { forwarded: false, response: null };
  return handler({
    request: () => ({ method: () => method, url: () => url, postDataJSON: () => body, isNavigationRequest: () => false }),
    continue: async () => { result.forwarded = true; },
    fulfill: async (response) => { result.response = response; },
  }).then(() => result);
}

async function guardedContext() {
  let handler;
  const guard = await installReadOnlyMutationGuard({
    route: async (_pattern, callback) => { handler = callback; },
  }, { appOrigin: APP_ORIGIN });
  return { guard, handler };
}

test("optional first-connection insight does not mutate the shared reviewer", async () => {
  const { guard, handler } = await guardedContext();
  const result = await requestFor(handler, "POST", `${APP_ORIGIN}/api/one/first-connect-insights`);
  assert.equal(result.forwarded, false);
  assert.equal(result.response?.status, 200);
  assert.deepEqual(JSON.parse(result.response.body), { status: "unavailable" });
  assert.doesNotThrow(() => guard.assertNoBlockedMutation());
});

test("the exception does not admit a foreign origin or another POST", async () => {
  const { guard, handler } = await guardedContext();
  const foreign = await requestFor(handler, "POST", "https://other.example/api/one/first-connect-insights");
  const unrelated = await requestFor(handler, "POST", `${APP_ORIGIN}/api/one/other-write`);
  assert.equal(foreign.forwarded, false);
  assert.equal(foreign.response?.status, 409);
  assert.equal(unrelated.forwarded, false);
  assert.equal(unrelated.response?.status, 409);
  assert.throws(() => guard.assertNoBlockedMutation(), /blocked state-changing request/);
});

function commercialRequest(pathname, body, origin = APP_ORIGIN) {
  return { method: () => "POST", url: () => `${origin}${pathname}`, postDataJSON: () => body };
}

test("paid quote authority is exact and cannot escape the canonical browser guard", async () => {
  const previous = process.env.REVIEWER_ALLOW_SHARED_MUTATIONS;
  process.env.REVIEWER_ALLOW_SHARED_MUTATIONS = "true";
  try {
    const policy = createCommerceMutationAdmission({ appOrigin: APP_ORIGIN, role: "primary" });
    const quoteId = randomUUID();
    policy.permit({ type: "purchase", pathname: "/api/scope-commerce/purchases", expected: { quoteId } });
    const body = { quote_id: quoteId, confirmed: true, idempotency_key: randomUUID() };
    assert.equal(await policy.admit(commercialRequest("/api/scope-commerce/purchases", body)), true);
    await assert.rejects(policy.admit(commercialRequest("/api/scope-commerce/purchases", { ...body, quote_id: randomUUID() })), /BINDING_MISMATCH/);
    await assert.rejects(policy.admit(commercialRequest("/api/scope-commerce/purchases", { ...body, confirmed: false })), /BINDING_MISMATCH/);
    let handler;
    const guard = await installReadOnlyMutationGuard({ route: async (_pattern, callback) => { handler = callback; } },
      { appOrigin: APP_ORIGIN, admitMutation: request => policy.admit(request) });
    const admitted = await requestFor(handler, "POST", `${APP_ORIGIN}/api/scope-commerce/purchases`, body);
    assert.equal(admitted.forwarded, true);
    process.env.REVIEWER_ALLOW_SHARED_MUTATIONS = "false";
    const paused = await requestFor(handler, "POST", `${APP_ORIGIN}/api/scope-commerce/purchases`, body);
    assert.equal(paused.forwarded, false);
    assert.equal(paused.response.status, 409);
    process.env.REVIEWER_ALLOW_SHARED_MUTATIONS = "true";
    const foreign = await requestFor(handler, "POST", "https://checkout.stripe.com/pay");
    assert.equal(foreign.forwarded, false);
    assert.equal(foreign.response.status, 409);
    assert.throws(() => guard.assertNoBlockedMutation(), /blocked state-changing request/);
    for (const modelProcessingAllowed of [false, true]) {
      const pathname = "/api/scope-commerce/requests/synthetic/approve";
      policy.replace({ type: "approval", pathname, expected: { modelProcessingAllowed } });
      const approval = { idempotency_key: randomUUID(), duration_seconds: 3600, model_processing_allowed: modelProcessingAllowed };
      assert.equal(await policy.admit(commercialRequest(pathname, approval)), true);
      for (const changed of [!modelProcessingAllowed, String(modelProcessingAllowed), undefined]) {
        await assert.rejects(policy.admit(commercialRequest(pathname, { ...approval, model_processing_allowed: changed })), /BINDING_MISMATCH/);
      }
      await assert.rejects(policy.admit(commercialRequest(pathname, { ...approval, unapproved_permission: true })), /BINDING_MISMATCH/);
    }
  } finally {
    if (previous === undefined) delete process.env.REVIEWER_ALLOW_SHARED_MUTATIONS;
    else process.env.REVIEWER_ALLOW_SHARED_MUTATIONS = previous;
  }
});

test("a financial intent is durable before forwarding, including simultaneous retries", async () => {
  const policy = createCommerceMutationAdmission({ appOrigin: APP_ORIGIN, role: "primary" });
  let release, writes = 0, completed = 0;
  const durable = new Promise(resolve => { release = resolve; });
  const previewToken = "a".repeat(64);
  policy.permit({ type: "withdrawal", pathname: "/api/scope-commerce/withdrawals", expected: { previewToken },
    beforeForward: async () => { writes += 1; await durable; } });
  const body = { idempotency_key: randomUUID(), preview_token: previewToken };
  const first = policy.admit(commercialRequest("/api/scope-commerce/withdrawals", body)).then(() => { completed += 1; });
  const duplicate = policy.admit(commercialRequest("/api/scope-commerce/withdrawals", body)).then(() => { completed += 1; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(writes, 1); assert.equal(completed, 0);
  release(); await Promise.all([first, duplicate]);
  assert.equal(completed, 2);
  await assert.rejects(policy.admit(commercialRequest("/api/scope-commerce/withdrawals", { ...body, idempotency_key: randomUUID() })), /REPLAY_CHANGED/);
});

test("the runner admits no automatic funding and cannot reuse another role's quote capability", async () => {
  const primary = createCommerceMutationAdmission({ appOrigin: APP_ORIGIN, role: "primary" });
  const counterpart = createCommerceMutationAdmission({ appOrigin: APP_ORIGIN, role: "counterpart" });
  const quoteId = randomUUID();
  primary.permit({ type: "purchase", pathname: "/api/scope-commerce/purchases", expected: { quoteId } });
  const purchase = { idempotency_key: randomUUID(), quote_id: quoteId, confirmed: true };
  assert.equal(await primary.admit(commercialRequest("/api/scope-commerce/purchases", purchase)), true);
  assert.equal(await counterpart.admit(commercialRequest("/api/scope-commerce/purchases", purchase)), false);
  for (const amountCents of [50, 1000]) {
    assert.equal(await primary.admit(commercialRequest("/api/scope-commerce/funding/checkout", { idempotency_key: randomUUID(), amount_cents: amountCents })), false);
  }
});

function leaseFixture() {
  return { preparation_id: randomUUID(), grant_id: randomUUID(), buyer_app_id: "agent_one", export_id: "export_1", export_revision: 1,
    machine_scope: "attr.synthetic.value", scope_handle: "synthetic_value", recipient_key_fingerprint: `sha256:${"a".repeat(64)}`,
    starts_at_ms: 300_000, expires_at_ms: 3_900_000, connector_key_id: "reviewer_key",
    source_revisions: { content_revision: 2, manifest_revision: 3 } };
}

test("sealed staging preserves the real lease, recipient, exact scope and source revision", async () => {
  const lease = leaseFixture();
  const policy = createCommerceMutationAdmission({ appOrigin: APP_ORIGIN, role: "primary" });
  policy.permit({ type: "stage", pathname: "/api/scope-commerce/purchases/current/stage", expected: { lease } });
  const aad = { app_id: lease.buyer_app_id, grant_id: lease.grant_id, export_id: lease.export_id, revision: 1,
    machine_scope: lease.machine_scope, scope_handle: lease.scope_handle, recipient_key_fingerprint: lease.recipient_key_fingerprint,
    expires_at_ms: lease.expires_at_ms };
  const body = { preparation_id: lease.preparation_id, envelope: { exportEnvelope: { aad },
    wrappedKey: { connector_key_id: lease.connector_key_id }, sourceRevisions: { contentRevision: 2, manifestRevision: 3 } } };
  assert.equal(await policy.admit(commercialRequest("/api/scope-commerce/purchases/current/stage", body)), true);
  for (const patch of [{ expires_at_ms: aad.expires_at_ms + 1 }, { machine_scope: "attr.synthetic.*" },
    { recipient_key_fingerprint: `sha256:${"b".repeat(64)}` }]) {
    const changed = structuredClone(body); Object.assign(changed.envelope.exportEnvelope.aad, patch);
    await assert.rejects(policy.admit(commercialRequest("/api/scope-commerce/purchases/current/stage", changed)), /BINDING_MISMATCH/);
  }
  const revision = structuredClone(body); revision.envelope.sourceRevisions.contentRevision = 4;
  await assert.rejects(policy.admit(commercialRequest("/api/scope-commerce/purchases/current/stage", revision)), /BINDING_MISMATCH/);
  verifyPreparation(lease, { requestId: lease.grant_id, recipientFingerprint: lease.recipient_key_fingerprint },
    { machineScope: lease.machine_scope, scopeHandle: lease.scope_handle }, 0, 0);
  assert.throws(() => verifyPreparation({ ...lease, expires_at_ms: lease.expires_at_ms + 1000 },
    { requestId: lease.grant_id, recipientFingerprint: lease.recipient_key_fingerprint },
    { machineScope: lease.machine_scope, scopeHandle: lease.scope_handle }, 0, 0), /FIXED_ACTIVATION_WINDOW/);
});

test("resume checkpoints reject protected contents and altered paid scenarios", () => {
  const state = syntheticState(); validateCommerceState(state);
  state.records[0].requestId = `one_person_${randomUUID().replaceAll("-", "")}`;
  validateCommerceState(state);
  for (const key of ["ownerToken", "vaultKey", "plaintext", "encryptedExport", "reviewerUid", "checkoutUrl"]) {
    assert.throws(() => validateCommerceState({ ...state, [key]: "forbidden" }), /CHECKPOINT_INVALID/);
  }
  const nested = structuredClone(state); nested.records[0].wrappedKey = {};
  assert.throws(() => validateCommerceState(nested), /CHECKPOINT_RECORD_INVALID/);
  const increased = structuredClone(state); increased.records[0].priceCents = 450;
  assert.throws(() => validateCommerceState(increased), /SCENARIO_CHANGED/);
  const record = state.records[0];
  const original = actionId(state, "confirmQuote", record.buyer, randomUUID(), 1);
  assert.notEqual(original, actionId(state, "confirmQuote", record.buyer, randomUUID(), 1));
  assert.notEqual(actionId(state, "sourceRefund", "primary", "fixed", 50), actionId(state, "sourceRefund", "counterpart", "fixed", 50));
});

test("unused calendar refunds retain half-up cents and a real partial term", () => {
  assert.equal(unusedCalendarRefund(450, 0, 3_600_000, 60_000), 443);
  assert.equal(unusedCalendarRefund(1, 0, 3_600_000, 1_800_000), 1);
  assert.equal(unusedCalendarRefund(450, 0, 3_600_000, 3_600_001), 0);
  assert.equal(unusedCalendarRefund(451, 0, 3_600_000, 67_500), 442);
  assert.equal(unusedCalendarRefund(450, 0, 3_600_000, "1970-01-01T00:01:00.000001+00:00"), 442);
  assert.equal(unusedCalendarRefund(450, 0, 3_600_000, "1970-01-01T00:01:00.000000+00:00"), 443);
  assert.throws(() => unusedCalendarRefund(450, 0, 3_600_000, "invalid"), /REFUND_TIMESTAMP_INVALID/);
  assert.throws(() => unusedCalendarRefund(450, 0, 3_600_001, 60_000), /REFUND_TERM_INVALID/);
});

test("financial buttons bind the reviewed USD amount while displaying coins", () => {
  const purchase = commerceMoneyButtonName("purchase", 1);
  assert.match("Confirm 1 Hussh coin ($0.01) from balance", purchase);
  assert.doesNotMatch("Confirm 999 Hussh coins ($0.01) from balance", purchase);
  assert.doesNotMatch("Confirm 2 Hussh coins ($0.02) from balance", purchase);
  assert.doesNotMatch("Confirm free access", purchase);
  assert.doesNotMatch("Confirm 1 Hussh coin ($0x01) from balance", purchase);
  assert.match("Review refund of 50 Hussh coins ($0.50)", commerceMoneyButtonName("refund", 50));
  assert.match("Review refund of 100,000 Hussh coins ($1,000.00)", commerceMoneyButtonName("refund", 100_000));
  assert.doesNotMatch("Review refund of 50 Hussh coins ($0.50) extra", commerceMoneyButtonName("refund", 50));
  for (const cents of [0, -1, 0.5, 100_001, NaN]) assert.throws(() => commerceMoneyButtonName("purchase", cents));
  assert.throws(() => commerceMoneyButtonName("withdrawal", 50));
});

test("the accepted human quote freezes exact buyer, recipient, amount and calendar expiry", () => {
  const requestId = `one_person_${randomUUID().replaceAll("-", "")}`;
  const quote = { id: randomUUID(), request_id: requestId, machine_scope: "attr.synthetic.value", scope_handle: "synthetic_value",
    duration_seconds: 3600, base_duration_seconds: 3600, amount_cents: 1, base_price_cents: 1, currency: "USD",
    purpose: "Synthetic purpose", buyer_app_id: "agent_one", recipient_key_fingerprint: `sha256:${"a".repeat(64)}`,
    expires_at: new Date(900_000).toISOString() };
  const expected = { requestId, priceCents: 1, purpose: quote.purpose, recipientFingerprint: quote.recipient_key_fingerprint };
  const fixture = { machineScope: quote.machine_scope, scopeHandle: quote.scope_handle };
  verifyQuote(quote, expected, fixture, 0, 1000);
  for (const patch of [{ amount_cents: 2 }, { buyer_app_id: "developer_app" },
    { recipient_key_fingerprint: `sha256:${"b".repeat(64)}` }, { duration_seconds: 7200 }, { purpose: "Changed purpose" }]) {
    assert.throws(() => verifyQuote({ ...quote, ...patch }, expected, fixture, 0, 1000), /QUOTE_BINDING_MISMATCH/);
  }
  assert.throws(() => verifyQuote(quote, expected, fixture, 0, 900_001), /QUOTE_CALENDAR_WINDOW/);
});

test("private resume files resist concurrent processes, unsafe paths and symlinks", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hussh-commerce-contract-"));
  const filename = path.join(repo, "tmp/scope-commerce-rehearsal/run.json");
  let release;
  try {
    release = await acquireCommerceStateLease(repo, filename);
    await assert.rejects(acquireCommerceStateLease(repo, filename), /ALREADY_RUNNING/);
    const state = syntheticState(); await saveCommerceState(repo, filename, state);
    assert.deepEqual(await loadCommerceState(repo, filename), state);
    assert.equal((await fs.stat(filename)).mode & 0o077, 0);
    await fs.chmod(filename, 0o644);
    await assert.rejects(loadCommerceState(repo, filename), /PRIVATE_CHECKPOINT_REQUIRED/);
    await assert.rejects(saveCommerceState(repo, path.join(repo, "AGENTS.json"), state), /IGNORED_CHECKPOINT_PATH_REQUIRED/);
    await fs.unlink(filename); await fs.symlink(path.join(repo, "outside.json"), filename);
    await assert.rejects(saveCommerceState(repo, filename, state), /CHECKPOINT_SYMLINK_DENIED/);
  } finally { await release?.(); await fs.rm(repo, { recursive: true, force: true }); }
});

test("the rehearsal entrypoint cannot gain blanket spending or choose ambient defaults", () => {
  const argumentsList = ["--app-origin", APP_ORIGIN, "--account-id", "acct_synthetic", "--state", "run.json",
    "--fixtures-file", "fixture.json", "--reviewer-binding-file", "bindings.json",
    "--isolation-evidence-file", "isolation.json", "--operation-state-file", "operations.json"];
  assert.equal(parseCommerceArguments(argumentsList).appOrigin, APP_ORIGIN);
  assert.throws(() => parseCommerceArguments([]), /EXPLICIT_REHEARSAL_ARGUMENTS_REQUIRED/);
  assert.throws(() => parseCommerceArguments([...argumentsList, "--allow-all", "true"]), /EXPLICIT_REHEARSAL_ARGUMENTS_REQUIRED/);
  assert.throws(() => parseCommerceArguments([...argumentsList, "--approve-action", "all"]), /EXACT_OPERATOR_ACTION_INVALID/);
});

test("human authentication admits exact provider exchanges but never custom-token minting or payments", async () => {
  let handler;
  const guard = await installReadOnlyMutationGuard({ route: async (_pattern, callback) => { handler = callback; } },
    { appOrigin: APP_ORIGIN, reviewerAuthMode: "human_authenticated" });
  for (const url of ["https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=public-synthetic", "https://identitytoolkit.googleapis.com/v1/accounts:lookup", "https://securetoken.googleapis.com/v1/token"]) {
    assert.equal((await requestFor(handler, "POST", url)).forwarded, true);
  }
  assert.doesNotThrow(() => guard.assertNoBlockedMutation());
  for (const url of ["https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken", "https://identitytoolkit.googleapis.com/v1/accounts:delete", "https://identitytoolkit.googleapis.com.attacker.example/v1/accounts:signInWithIdp", "http://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp", "https://checkout.stripe.com/pay", `${APP_ORIGIN}/api/app-config/review-mode/session`]) {
    assert.equal((await requestFor(handler, "POST", url)).forwarded, false);
  }
  assert.throws(() => guard.assertNoBlockedMutation(), /blocked state-changing request/);
});


test("borrowed reviewer sessions preserve other clients and permanently retire on owner or vault generation changes", async () => {
  const previousMode = process.env.REVIEWER_AUTH_MODE;
  process.env.REVIEWER_AUTH_MODE = "human_authenticated";
  const fixture = borrowedPage(APP_ORIGIN);
  const harness = await createReviewerSessionHarness({ repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    appOrigin: APP_ORIGIN, reviewerIdentity: { reviewerUid: "synthetic-owner", reviewerVaultPassphrase: "" } });
  try {
    const session = await harness.attachExistingSession(fixture.page);
    assert.equal(session.evidence, "warm_only");
    await session.navigateInApp("/one/pkm");
    assert.equal(fixture.routes.size, 2);
    await assert.rejects(harness.attachExistingSession(fixture.page), /already owned/);
    fixture.state.authGeneration += 2; // A → B → A is still a different session.
    await assert.rejects(session.assertCurrent(), /retired/);
    fixture.state.authGeneration = 1;
    await assert.rejects(session.assertCurrent(), /retired/);
    await session.dispose();
    assert.deepEqual([...fixture.routes], ["another-agent-handler"]);
    assert.ok([...fixture.events.values()].every(handlers => handlers.size === 0));
    await assert.rejects(harness.attachExistingSession(fixture.page, { evidence: "visible_unlock" }), /Visible vault challenge/);
    const next = await harness.attachExistingSession(fixture.page);
    fixture.state.vaultEpoch += 1;
    await assert.rejects(next.assertCurrent(), /retired/);
    const handler = [...fixture.routes].find(value => typeof value === "function");
    let forwarded = false;
    await assert.doesNotReject(handler({
      request: () => ({ method: () => "POST", url: () => `${APP_ORIGIN}/api/scope-commerce/purchases` }),
      continue: async () => { forwarded = true; },
      fulfill: async () => { throw new Error("Route is already handled!"); },
    }));
    assert.equal(forwarded, false);
    await assert.rejects(next.assertCurrent(), /retired/);
    await next.dispose();
    fixture.state.ownerMatches = false;
    await assert.rejects(harness.attachExistingSession(fixture.page), /retired/);
    window.location = new URL("https://other.example/one");
    await assert.rejects(harness.attachExistingSession(fixture.page), /refused/);
    assert.deepEqual([...fixture.routes], ["another-agent-handler"]);
  } finally {
    fixture.restore();
    if (previousMode === undefined) delete process.env.REVIEWER_AUTH_MODE;
    else process.env.REVIEWER_AUTH_MODE = previousMode;
  }
});

for (const [label, pathname, port] of [
  ["mutation", "/api/scope-commerce/purchases", "admitMutation"],
  ["private preparation", "/api/one/pod/memory/proposals", "admitOwnerPodMemoryPreparation"],
  ["private connector", "/api/one/pod/agent-chat/connectors/custom_" + "a".repeat(32) + "/mcp/verify", "admitOwnerPodConnectorOperation"],
]) test(`a retired borrowed session cannot publish deferred evidence or forward deferred ${label} approval`, async () => {
  const previousMode = process.env.REVIEWER_AUTH_MODE, previousWrites = process.env.REVIEWER_ALLOW_SHARED_MUTATIONS;
  process.env.REVIEWER_AUTH_MODE = "human_authenticated"; process.env.REVIEWER_ALLOW_SHARED_MUTATIONS = "true";
  const fixture = borrowedPage(APP_ORIGIN);
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const admit = async request => { assert.equal(new URL(request.url()).pathname, pathname); entered(); await pending; return true; };
  const harness = await createReviewerSessionHarness({ repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    appOrigin: APP_ORIGIN, reviewerIdentity: { reviewerUid: "synthetic-owner", reviewerVaultPassphrase: "" },
    allowMemoryPreparation: port === "admitOwnerPodMemoryPreparation", admitMutation: () => false, [port]: admit });
  const closeObservation = () => { for (const handler of fixture.events.get("close")) handler(); };
  try {
    const session = await harness.attachExistingSession(fixture.page);
    const handler = [...fixture.routes].find(value => typeof value === "function");
    const request = requestFor(handler, "POST", (port === "admitMutation" ? APP_ORIGIN : "https://owner-pod.example") + pathname);
    await started; closeObservation(); release();
    assert.equal((await request).forwarded, false);
    await assert.rejects(session.assertCurrent(), /retired/);
    await session.dispose();
    const next = await harness.attachExistingSession(fixture.page);
    let readStarted, finishRead;
    const reading = new Promise(resolve => { readStarted = resolve; }), gate = new Promise(resolve => { finishRead = resolve; });
    const original = fixture.page.evaluate;
    fixture.page.evaluate = async (fn, args) => { const value = await original(fn, args); readStarted(); await gate; return value; };
    const assertion = assert.rejects(next.assertCurrent(), /retired/);
    await reading; closeObservation(); finishRead(); await assertion;
    fixture.page.evaluate = original;
    await next.dispose();
    assert.deepEqual([...fixture.routes], ["another-agent-handler"]);
  } finally {
    fixture.restore();
    for (const [name, previous] of [["REVIEWER_AUTH_MODE", previousMode], ["REVIEWER_ALLOW_SHARED_MUTATIONS", previousWrites]]) {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  }
});

// Both real-session modes keep unlock material out of the document bridge.
test("human and operator bridges never retain reviewer credentials", () => {
  for (const reviewerAuthMode of ["human_authenticated", "operator_issued_token"]) {
    const window = { __HUSHH_NATIVE_TEST__: { vaultPassphrase: "old", reviewerSessionPassphrase: "old" } };
    window.top = window;
    vm.runInNewContext(`(${installReviewerBridge.toString()})(config)`, { window,
      location: { pathname: "/login", origin: APP_ORIGIN }, config: {
        explicitLoginOnly: true, appOrigin: APP_ORIGIN, reviewerAuthMode,
        expectedUserId: "reviewer", vaultPassphrase: "test-unlock", reviewerSessionPassphrase: "test-mint",
      } });
    assert.equal(window.__HUSHH_NATIVE_TEST__.vaultPassphrase, undefined);
    assert.equal(window.__HUSHH_NATIVE_TEST__.reviewerSessionPassphrase, undefined);
    assert.equal(typeof window.__HUSHH_NATIVE_TEST__.requestOperatorReviewerToken,
      reviewerAuthMode === "operator_issued_token" ? "function" : "undefined");
  }
});
