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

process.stdout.write(`export REVIEWER_UID=${JSON.stringify(identity.reviewerUid)}\n`);
process.stdout.write(`export NEXT_PUBLIC_REVIEWER_UID=${JSON.stringify(identity.reviewerUid)}\n`);
process.stdout.write(`export NEXT_PUBLIC_KAI_TEST_USER_ID=${JSON.stringify(identity.reviewerUid)}\n`);
process.stdout.write(
  `export REVIEWER_VAULT_PASSPHRASE=${JSON.stringify(identity.reviewerVaultPassphrase)}\n`
);
process.stdout.write(
  `export HUSHH_UI_TEST_REVIEWER_UID=${JSON.stringify(identity.reviewerUid)}\n`
);
process.stdout.write(
  `export HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE=${JSON.stringify(identity.reviewerVaultPassphrase)}\n`
);
