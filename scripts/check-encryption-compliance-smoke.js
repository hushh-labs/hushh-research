#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runComplianceCheck } = require("./check-encryption-compliance");

function writeFixture(root, relativePath) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "fixture\n", "utf8");
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Encryption compliance smoke failed: ${message}`);
    process.exit(1);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-encryption-compliance-"));

try {
  writeFixture(tempRoot, "clean-data/encrypted-vault.sqlite");
  writeFixture(tempRoot, "bad-data/customer-snapshot.sqlite");
  writeFixture(tempRoot, "bad-data/export.cleartext_pkm");

  const cleanResult = runComplianceCheck({
    workspaceRoot: tempRoot,
    scanRoots: ["clean-data"],
  });
  assert(cleanResult.ok, "expected encrypted/vault-named fixture to pass");

  const badResult = runComplianceCheck({
    workspaceRoot: tempRoot,
    scanRoots: ["bad-data"],
  });
  assert(!badResult.ok, "expected unprotected fixtures to fail");
  assert(
    badResult.findings.some((finding) => finding.path.endsWith("customer-snapshot.sqlite")),
    "expected unprotected sqlite fixture finding"
  );
  assert(
    badResult.findings.some((finding) => finding.path.endsWith("export.cleartext_pkm")),
    "expected cleartext PKM fixture finding"
  );

  console.log("Encryption compliance smoke passed: clean fixture passes and bad fixtures fail.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
