#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultReviewerIdentityEnvFiles,
  resolveReviewerTestIdentity,
} from "../testing/reviewer-test-identity.mjs";
import {
  assertNativeArtifactSafe,
  sanitizeNativeArtifact,
} from "./native-report-sanitizer.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..", "..");
const monorepoRoot = path.resolve(webDir, "..");
const reportFiles = [
  "native-android-parity-report.json",
  "native-android-ui-interaction-report.json",
  "native-ios-parity-report.json",
  "native-ios-ui-interaction-report.json",
];
const write = process.argv.includes("--write");
const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir }),
});
const forbiddenValues = [
  reviewerIdentity.reviewerUid,
  reviewerIdentity.reviewerVaultPassphrase,
];

for (const relativePath of reportFiles) {
  const reportPath = path.join(webDir, relativePath);
  if (!fs.existsSync(reportPath)) continue;
  const payload = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const sanitized = sanitizeNativeArtifact(payload);
  assertNativeArtifactSafe(sanitized, forbiddenValues);
  const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
  if (write) {
    fs.writeFileSync(reportPath, serialized);
  } else if (serialized !== fs.readFileSync(reportPath, "utf8")) {
    throw new Error(`${relativePath} is not sanitized; rerun with --write`);
  }
}

console.log(`==> native report artifacts ${write ? "sanitized" : "verified"}`);
