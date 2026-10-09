import assert from "node:assert/strict";
import test from "node:test";

import { createReviewerSessionHarness, installReadOnlyMutationGuard } from "../scripts/reviewer-session-harness.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommerceMutationAdmission } from "../scripts/scope-commerce-rehearsal-admission.mjs";
import { newCommerceState, validateCommerceState, actionId, acquireCommerceStateLease, saveCommerceState, loadCommerceState } from "../scripts/scope-commerce-rehearsal-state.mjs";
import { verifyProviderPreflight, verifyApplicationReadiness, verifyPreparation, verifyQuote, unusedCalendarRefund } from "../scripts/scope-commerce-rehearsal-contract.mjs";
import { parseCommerceArguments } from "../scripts/verify-reviewer-scope-commerce.mjs";
import { createOperatorReviewerTokenProvider } from "../scripts/reviewer-operator-token-provider.mjs";

const APP_ORIGIN = "https://uat.one.hushh.ai";

test("operator token transport enforces its explicit finite budget without retaining private output", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hussh-operator-budget-"));
  const configuration = { repoRoot, appOrigin: APP_ORIGIN, reviewerBindingFile: "synthetic-binding" };
  try {
    for (const timeoutMs of [0, -1, NaN, Infinity, 180_001]) {
      assert.throws(() => createOperatorReviewerTokenProvider({ ...configuration, timeoutMs }), /budget refused/);
    }
    const executable = path.join(repoRoot, "consent-protocol/.venv/bin/python");
    const script = path.join(repoRoot, ".codex/skills/reviewer-app-testing/scripts/reviewer_operator_token.py");
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
    request: () => ({ method: () => method, url: () => url, postDataJSON: () => body }),
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

function sandboxProof() {
  return { readiness: true, sandbox: true, account_pin_verified: true, isolation_evidence_verified: true,
    isolated_environment: true, isolation_evidence_kind: "operator_attestation", isolation_source: "dashboard_general_sandbox", appOrigin: APP_ORIGIN,
    platformAccountId: "acct_synthetic", budgetPolicyActive: true, reviewerFundingCapCents: 2000,
    platformCapitalCapCents: 2500, reviewerFundingUsedCents: { primary: 1050, counterpart: 1050 },
    platformCapitalUsedCents: 2500, ledgerProviderMatches: true };
}

test("provider and application attestations must agree before mutations", () => {
  const proof = sandboxProof(); verifyProviderPreflight(proof);
  for (const patch of [{ sandbox: false }, { account_pin_verified: false }, { isolation_evidence_verified: false },
    { isolation_source: "stripe_cli_anonymous_sandbox" },
    { ledgerProviderMatches: false }, { reviewerFundingUsedCents: { primary: 2001, counterpart: 0 } },
    { reviewerFundingUsedCents: { primary: 0, counterpart: 2001 } }, { platformCapitalUsedCents: 2501 }]) {
    assert.throws(() => verifyProviderPreflight({ ...proof, ...patch }));
  }
  const app = { app_origin: APP_ORIGIN, environment: "sandbox", livemode: false, persisted_pin_matches: true,
    platform_account_id: proof.platformAccountId, reviewer_funding_cap_cents: 2000, operating_capital_cap_cents: 2500, schema_head: 283 };
  verifyApplicationReadiness(app, proof, APP_ORIGIN, 283);
  for (const patch of [{ app_origin: "https://one.hushh.ai" }, { livemode: true }, { platform_account_id: "acct_other" }, { schema_head: null }]) {
    assert.throws(() => verifyApplicationReadiness({ ...app, ...patch }, proof, APP_ORIGIN, 283));
  }
  assert.throws(() => verifyApplicationReadiness(app, { ...proof, appOrigin: "https://other.example" }, APP_ORIGIN, 283));
});

function syntheticState() {
  const fixture = () => ({ synthetic: true, personRef: randomUUID(), scopeRef: "synthetic", scopeHandle: "synthetic_value",
    machineScope: "attr.synthetic.value", expectedPayloadSha256: "a".repeat(64) });
  return newCommerceState({ appOrigin: APP_ORIGIN, platformAccountId: "acct_synthetic", schemaHead: 283,
    fixtures: { primary: fixture(), counterpart: fixture() } });
}

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
  assert.throws(() => unusedCalendarRefund(450, 0, 3_600_001, 60_000), /REFUND_TERM_INVALID/);
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
