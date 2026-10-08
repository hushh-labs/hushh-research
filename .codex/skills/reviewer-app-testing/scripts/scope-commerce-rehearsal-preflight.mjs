import { resolveReviewerAuthMode } from "../../../../hushh-webapp/lib/testing/reviewer-authentication-policy.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveReviewerTestIdentity, resolveReviewerCounterpartIdentity, defaultReviewerIdentityEnvFiles } from "../../../../hushh-webapp/scripts/testing/reviewer-test-identity.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { commerceEvidence, exactKeys, validateFixture, verifyProviderPreflight } from "./scope-commerce-rehearsal-contract.mjs";

const execute = promisify(execFile);

async function privateJson(filename) {
  const info = await fs.lstat(filename);
  commerceEvidence(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
    typeof process.getuid === "function" && info.uid === process.getuid() && info.size < 50_000,
    "PRIVATE_OPERATOR_CONFIGURATION_REQUIRED");
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

export async function providerPreflight(repoRoot, options) {
  const args = [path.join(repoRoot, "scripts/ops/scope_commerce_sandbox.py"), "preflight",
    "--account-id", options.accountId,
    "--reviewer-binding-file", options.reviewerBindingFile,
    "--isolation-evidence-file", options.isolationEvidenceFile,
    "--operation-state-file", options.operationStateFile];
  let output;
  try {
    ({ stdout: output } = await execute(path.join(repoRoot, "consent-protocol/.venv/bin/python"), args,
      { cwd: repoRoot, timeout: 55_000, maxBuffer: 1_000_000, encoding: "utf8" }));
  } catch {
    // A provider exception can include request identifiers or configuration;
    // report only this fixed boundary code, never subprocess stderr/stdout.
    commerceEvidence(false, "SANDBOX_PROVIDER_PREFLIGHT_REQUIRED");
  }
  const proof = verifyProviderPreflight(JSON.parse(output));
  commerceEvidence(proof.platformAccountId === options.accountId && proof.appOrigin === options.appOrigin,
    "PROVIDER_ACCOUNT_OR_ORIGIN_BINDING_MISMATCH");
  return proof;
}

export async function commercePreflight(repoRoot, options) {
  commerceEvidence(process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true", "BOUNDED_MUTATION_AUTHORITY_REQUIRED");
  commerceEvidence(/^acct_[A-Za-z0-9]+$/.test(options.accountId) &&
    /^https:\/\//.test(options.appOrigin) && new URL(options.appOrigin).origin === options.appOrigin,
  "EXPLICIT_SANDBOX_ORIGIN_REQUIRED");
  const authMode = resolveReviewerAuthMode(process.env.REVIEWER_AUTH_MODE);
  const humanAuthenticated = authMode === "human_authenticated";
  const identityOptions = { envFiles: humanAuthenticated ? [] : defaultReviewerIdentityEnvFiles({ repoRoot, webDir: path.join(repoRoot, "hushh-webapp") }),
    requireVaultPassphrase: !humanAuthenticated, required: true };
  const identities = { primary: resolveReviewerTestIdentity(identityOptions), counterpart: resolveReviewerCounterpartIdentity(identityOptions) };
  commerceEvidence(identities.primary.reviewerUid && identities.counterpart.reviewerUid &&
    identities.primary.reviewerUid !== identities.counterpart.reviewerUid &&
    (humanAuthenticated || identities.primary.reviewerVaultPassphrase && identities.counterpart.reviewerVaultPassphrase),
  "CANONICAL_REVIEWER_PAIR_REQUIRED");
  const bindings = await privateJson(options.reviewerBindingFile);
  commerceEvidence(bindings.schema_version === 1 && exactKeys(bindings.reviewers, ["primary", "counterpart"]), "OPERATOR_REVIEWER_BINDING_REQUIRED");
  for (const role of ["primary", "counterpart"]) {
    commerceEvidence(bindings.reviewers[role]?.user_id === identities[role].reviewerUid,
      "CANONICAL_REVIEWER_BINDING_MISMATCH");
  }
  const fixtures = await privateJson(options.fixturesFile);
  commerceEvidence(exactKeys(fixtures, ["primary", "counterpart"]), "TWO_SYNTHETIC_FIXTURES_REQUIRED");
  for (const role of ["primary", "counterpart"]) validateFixture(fixtures[role]);
  commerceEvidence(fixtures.primary.personRef !== fixtures.counterpart.personRef, "DISTINCT_FIXTURE_OWNERS_REQUIRED");
  // Configured identities already resolved: no Secret Manager or env-file writes.
  await prepareReviewerRehearsal({ repoRoot, appOrigin: options.appOrigin, secretProject: "" });
  const proof = await providerPreflight(repoRoot, options);
  const schema = JSON.parse(await fs.readFile(path.join(repoRoot, "consent-protocol/db/contracts/prod_core_schema.json"), "utf8"));
  commerceEvidence(Number.isSafeInteger(schema.expected_migration_version), "CANONICAL_SCHEMA_HEAD_REQUIRED");
  return { identities, fixtures, proof, authMode, schemaHead: schema.expected_migration_version };
}
