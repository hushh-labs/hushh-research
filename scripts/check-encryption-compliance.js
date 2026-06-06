#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SCAN_ROOTS = [
  "data",
  "tests/fixtures",
  "consent-protocol/tests/fixtures",
  "hushh-webapp/__tests__/fixtures",
];

const PLAINTEXT_EXTENSIONS = new Set([
  ".raw_sql",
  ".unencrypted_log",
  ".cleartext_pkm",
]);

const MOCK_DATABASE_EXTENSIONS = new Set([
  ".db",
  ".sqlite",
  ".sqlite3",
]);

const PROTECTED_NAME_PATTERN =
  /(?:^|[-_.])(encrypted|cipher|ciphertext|vault|pkm|zk|zero[-_.]?knowledge)(?:[-_.]|$)/i;

function normalize(relativePath) {
  return relativePath.replace(/\\/g, "/");
}

function listFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];

  const stat = fs.statSync(rootPath);
  if (stat.isFile()) return [rootPath];

  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };

  visit(rootPath);
  return files;
}

function hasProtectedName(filePath) {
  return PROTECTED_NAME_PATTERN.test(path.basename(filePath));
}

function classifyFile(filePath) {
  const lowerName = path.basename(filePath).toLowerCase();

  for (const extension of PLAINTEXT_EXTENSIONS) {
    if (lowerName.endsWith(extension)) {
      return {
        ok: false,
        reason: `plaintext scratchpad extension ${extension}`,
      };
    }
  }

  for (const extension of MOCK_DATABASE_EXTENSIONS) {
    if (lowerName.endsWith(extension) && !hasProtectedName(filePath)) {
      return {
        ok: false,
        reason: `unprotected mock database extension ${extension}`,
      };
    }
  }

  return { ok: true, reason: "" };
}

function runComplianceCheck(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || path.join(__dirname, ".."));
  const scanRoots = options.scanRoots || DEFAULT_SCAN_ROOTS;
  const findings = [];
  let scannedFiles = 0;

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.resolve(workspaceRoot, scanRoot);
    for (const filePath of listFiles(absoluteRoot)) {
      scannedFiles += 1;
      const classification = classifyFile(filePath);
      if (!classification.ok) {
        findings.push({
          path: normalize(path.relative(workspaceRoot, filePath)),
          reason: classification.reason,
        });
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    scannedFiles,
    scanRoots,
    workspaceRoot,
  };
}

function printResult(result) {
  console.log("Hushh encryption compliance preflight");
  console.log(`Scanned ${result.scannedFiles} local data/test file(s).`);

  if (result.ok) {
    console.log(
      "Compliance check passed: local sandbox data follows zero-knowledge naming guardrails."
    );
    return;
  }

  console.error("Compliance check failed: unprotected local data footprint(s) detected.");
  for (const finding of result.findings) {
    console.error(`  - ${finding.path} (${finding.reason})`);
  }
  console.error(
    "Action: encrypt the fixture, rename it with an encrypted/vault/pkm/zk marker, or remove the plaintext scratchpad."
  );
}

function main() {
  const result = runComplianceCheck();
  printResult(result);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyFile,
  runComplianceCheck,
};
