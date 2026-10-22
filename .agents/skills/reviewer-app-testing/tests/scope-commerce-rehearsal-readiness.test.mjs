import assert from "node:assert/strict";
import test from "node:test";
import { verifyProviderPreflight, verifyApplicationReadiness } from "../scripts/scope-commerce-rehearsal-contract.mjs";
import { verifySharedDevReadiness } from "../scripts/scope-commerce-rehearsal-dev-readiness.mjs";
import { validateCommerceState } from "../scripts/scope-commerce-rehearsal-state.mjs";
import { syntheticState } from "./fixtures/synthetic-commerce-state.mjs";
const APP_ORIGIN = "https://uat.one.hushh.ai";

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

test("shared Dev accepts only fresh complete canonical schema evidence and binds resume identity", () => {
  const origin = "https://dev.one.hussh.ai", now = Date.now();
  const binding = { kind: "shared_dev_minimum_schema", sourceSha: "a".repeat(40),
    databaseBinding: "b".repeat(64), configurationSha256: "e".repeat(64),
    contractSha256: "c".repeat(64), checkerSha256: "d".repeat(64) };
  const expected = { appOrigin: origin, platformAccountId: "acct_synthetic", schemaHead: 406,
    contractSha256: binding.contractSha256, checkerSha256: binding.checkerSha256 };
  const contract = { contract_name: "dev_minimum_schema", migration_version_policy: "minimum",
    expected_migration_version: 406, required_tables: { scope_commerce_purchases: ["id"] }, required_functions: ["commit_scope"] };
  const evidence = { ...expected, binding, configurationVersion: "2", startedAt: new Date(now - 1000).toISOString(), verifiedAt: new Date(now).toISOString(),
    report: { checked_at: new Date(now - 500).toISOString(), status: "ok", policy: { skip_db_check: false, migration_version_policy: "minimum" },
      migrations: { expected_contract_version: 406 }, violations: [],
      db_contract: { tables: { scope_commerce_purchases: { exists: true, missing_columns: [] } }, functions: { commit_scope: true } } } };
  assert.deepEqual(verifySharedDevReadiness(evidence, expected, contract, now), binding);
  // Pausing new provider admission creates a secret version, not a new financial policy.
  assert.deepEqual(verifySharedDevReadiness({ ...evidence, configurationVersion: "3" }, expected, contract, now), binding);
  for (const mutate of [e => { e.appOrigin = APP_ORIGIN; }, e => { e.platformAccountId = "acct_other"; },
    e => { e.startedAt = new Date(now - 300_001).toISOString(); }, e => { e.verifiedAt = new Date(now + 1).toISOString(); },
    e => { e.binding.contractSha256 = "e".repeat(64); }, e => { e.binding.checkerSha256 = "e".repeat(64); },
    e => { e.binding.databaseBinding = ""; }, e => { e.report.policy.skip_db_check = true; },
    e => { e.report.db_contract = {}; }, e => { delete e.report.db_contract.tables.scope_commerce_purchases; },
    e => { e.report.db_contract.tables.scope_commerce_purchases.missing_columns = ["id"]; },
    e => { e.report.db_contract.functions.commit_scope = false; }, e => { e.report.violations = ["missing"]; }]) {
    const invalid = structuredClone(evidence); mutate(invalid);
    assert.throws(() => verifySharedDevReadiness(invalid, expected, contract, now));
  }
  const proof = { ...sandboxProof(), appOrigin: origin };
  const app = { app_origin: origin, environment: "sandbox", livemode: false, persisted_pin_matches: true,
    platform_account_id: proof.platformAccountId, reviewer_funding_cap_cents: 2000, operating_capital_cap_cents: 2500, schema_head: null };
  verifyApplicationReadiness(app, proof, origin, 406, binding);
  for (const invalid of [false, 0, "", {}]) {
    assert.throws(() => verifyApplicationReadiness(app, proof, origin, 406, invalid));
  }
  assert.throws(() => verifyApplicationReadiness(app, proof, origin, 406));
  assert.throws(() => verifyApplicationReadiness({ ...app, schema_head: 405 }, proof, origin, 406, binding));
  assert.throws(() => verifyApplicationReadiness({ ...app, app_origin: APP_ORIGIN }, { ...proof, appOrigin: APP_ORIGIN }, APP_ORIGIN, 406, binding));
  const state = { ...syntheticState(), appOrigin: origin, schemaHead: 406, readinessBinding: binding, observedSchemaHead: null };
  validateCommerceState(state);
  assert.throws(() => validateCommerceState({ ...state, observedSchemaHead: 405 }), /CHECKPOINT_READINESS/);
  assert.throws(() => validateCommerceState({ ...state, readinessBinding: { ...binding, ownerToken: "forbidden" } }), /BINDING_INVALID/);
});

