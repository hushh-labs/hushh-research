#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultReviewerIdentityEnvFiles,
  resolveReviewerTestIdentity,
} from "./reviewer-test-identity.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(webDir, "..");

const identity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot, webDir }),
});

// This output is a private shell pipe, never a diagnostic. JSON double quotes
// still execute shell substitutions; POSIX single quoting preserves literals.
const shellLiteral = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
for (const [key, value] of Object.entries({
  REVIEWER_UID: identity.reviewerUid,
  NEXT_PUBLIC_REVIEWER_UID: identity.reviewerUid,
  NEXT_PUBLIC_KAI_TEST_USER_ID: identity.reviewerUid,
  REVIEWER_VAULT_PASSPHRASE: identity.reviewerVaultPassphrase,
  HUSHH_UI_TEST_REVIEWER_UID: identity.reviewerUid,
  HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE: identity.reviewerVaultPassphrase,
})) {
  process.stdout.write(`export ${key}=${shellLiteral(value)}\n`);
}
