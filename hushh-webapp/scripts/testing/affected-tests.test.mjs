// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPlan, executePlan } from "./affected-tests.mjs";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const DELETE_TEST = "__tests__/lib/flows/delete-account.test.ts";
const DIRECT_TEST = "__tests__/services/agent-chat-client.test.ts";

test("missing or unknown selection metadata keeps the diagnostic suite", () => {
  assert.equal(buildPlan({ env: { CI_VALIDATION_LEVEL: "focused" } }).effectiveLevel, "diagnostic");
  const plan = buildPlan({
    env: { CI_VALIDATION_LEVEL: "unrecognized", CI_CHANGED_FILES: `hushh-webapp/${DIRECT_TEST}` },
  });
  assert.equal(plan.effectiveLevel, "diagnostic");
  assert.equal(plan.fallbackReason, "unknown_validation_level");
});

test("release keeps the named account-deletion owner unless this attempt owns it separately", () => {
  const pathInRepo = `hushh-webapp/${DELETE_TEST}`;
  const baseEnv = { CI_VALIDATION_LEVEL: "release", CI_CHANGED_FILES: pathInRepo };
  const ordinary = buildPlan({ env: baseEnv });
  assert.ok(ordinary.coreFiles.includes(DELETE_TEST));
  assert.ok(ordinary.directFiles.includes(DELETE_TEST));

  const untrustedOwnerFlag = buildPlan({
    env: { ...baseEnv, CI_ACCOUNT_DELETION_CLIENT_OWNED: "1" },
  });
  assert.equal(untrustedOwnerFlag.accountDeletionClientOwner, false);
  assert.ok(untrustedOwnerFlag.directFiles.includes(DELETE_TEST));

  const integrationOwned = buildPlan({
    env: { ...baseEnv, CI: "true", CI_ACCOUNT_DELETION_CLIENT_OWNED: "1" },
  });
  assert.equal(integrationOwned.accountDeletionClientOwner, true);
  assert.ok(integrationOwned.excludeFiles.includes(DELETE_TEST));
  assert.ok(!integrationOwned.coreFiles.includes(DELETE_TEST));
  assert.ok(!integrationOwned.directFiles.includes(DELETE_TEST));
});

test("focused related tests count as completed work when no direct tests remain", () => {
  const plan = {
    effectiveLevel: "focused",
    fallbackReason: null,
    relatedFiles: ["lib/services/agent-chat-client.ts"],
    directFiles: [],
    coreFiles: [],
    excludeFiles: [],
  };
  let commands = 0;
  let fullRuns = 0;
  const status = executePlan(plan, {
    runVitestCommand(args) {
      commands += 1;
      const reportPath = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
      writeFileSync(reportPath, JSON.stringify({ testResults: [{ name: path.join(WEB_ROOT, DIRECT_TEST) }] }));
      return { status: 0 };
    },
    runFullSuite() {
      fullRuns += 1;
      return { status: 1 };
    },
  });
  assert.equal(status, 0);
  assert.equal(commands, 1);
  assert.equal(fullRuns, 0);
});

test("release deduplicates tests already selected by related imports", () => {
  const plan = {
    effectiveLevel: "release",
    fallbackReason: null,
    relatedFiles: ["lib/services/agent-chat-client.ts"],
    directFiles: [],
    coreFiles: [DIRECT_TEST, DELETE_TEST],
    excludeFiles: [],
  };
  const explicitRuns = [];
  const status = executePlan(plan, {
    runVitestCommand(args) {
      if (args.includes("related")) {
        const reportPath = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
        writeFileSync(reportPath, JSON.stringify({ testResults: [{ name: path.join(WEB_ROOT, DIRECT_TEST) }] }));
      } else {
        explicitRuns.push(args.slice(args.indexOf("--") + 1));
      }
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(explicitRuns, [["--maxWorkers=2", DELETE_TEST]]);
});

test("empty related selection fails closed to the full diagnostic suite", () => {
  const plan = {
    effectiveLevel: "focused",
    fallbackReason: null,
    relatedFiles: ["lib/services/unknown-module.ts"],
    directFiles: [],
    coreFiles: [],
    excludeFiles: [],
  };
  let fullArgs;
  const status = executePlan(plan, {
    shard: "2/3",
    runVitestCommand(args) {
      const reportPath = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
      writeFileSync(reportPath, JSON.stringify({ testResults: [] }));
      return { status: 0 };
    },
    runFullSuite(args) {
      fullArgs = args;
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(fullArgs, { maxWorkers: "2", shard: "" });
});

test("affected shard exits before npm setup; diagnostic shard still reaches its owner", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hushh-web-early-shard-"));
  try {
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const npmLog = path.join(tmp, "npm.log");
    writeFileSync(npmLog, "");
    writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_TEST_LOG\"\nexit 0\n", { mode: 0o755 });
    const run = (level) => spawnSync("bash", ["scripts/ci/web-full-suite-check.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        NPM_TEST_LOG: npmLog,
        CI_VALIDATION_LEVEL: level,
        CI_CHANGED_FILES: `hushh-webapp/${DIRECT_TEST}`,
        CI_CHANGED_FILES_FILE: "",
        WEB_FULL_SUITE_SHARD: "2/3",
      },
      timeout: 15_000,
    });

    const focused = run("focused");
    assert.equal(focused.status, 0, focused.stderr);
    assert.match(focused.stdout, /shard 2\/3 is not scheduled/);
    assert.equal(readFileSync(npmLog, "utf8").trim(), "");

    const diagnostic = run("diagnostic");
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    const calls = readFileSync(npmLog, "utf8");
    assert.match(calls, /ci --prefer-offline/);
    assert.match(calls, /run test:ci -- --shard=2\/3 --maxWorkers=2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("document CI modes install and check only their assigned browser", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hushh-document-mode-"));
  try {
    const repo = path.join(tmp, "repo");
    const bin = path.join(tmp, "bin");
    const consentPython = path.join(repo, "consent-protocol/.venv/bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(repo, "scripts/ci"), { recursive: true });
    mkdirSync(path.join(repo, "hushh-webapp"), { recursive: true });
    mkdirSync(consentPython, { recursive: true });
    copyFileSync(path.join(REPO_ROOT, "scripts/ci/document-delivery-check.sh"), path.join(repo, "scripts/ci/document-delivery-check.sh"));

    const log = path.join(tmp, "commands.log");
    const stub = (name, body) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("git", 'printf "%s\\n" "$DOCUMENT_TEST_ROOT"');
    stub("timeout", 'printf "timeout %s\\n" "$*" >> "$DOCUMENT_TEST_LOG"; exit 0');
    stub("npx", 'printf "npx %s\\n" "$*" >> "$DOCUMENT_TEST_LOG"; exit 0');
    stub("node", 'printf "node %s\\n" "$*" >> "$DOCUMENT_TEST_LOG"; exit 0');
    stub("sudo", 'exit 0');
    writeFileSync(path.join(consentPython, "python"), '#!/bin/sh\nprintf "python %s\\n" "$*" >> "$DOCUMENT_TEST_LOG"\nexit 0\n', { mode: 0o755 });

    const run = (mode, ci, osName) => {
      writeFileSync(log, "");
      const proc = spawnSync("bash", [path.join(repo, "scripts/ci/document-delivery-check.sh"), mode], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          DOCUMENT_TEST_ROOT: repo,
          DOCUMENT_TEST_LOG: log,
          CI: ci,
          RUNNER_OS: osName,
        },
        timeout: 15_000,
      });
      assert.equal(proc.status, 0, proc.stderr);
      return readFileSync(log, "utf8");
    };

    const linux = run("--ci-linux-document", "true", "Linux");
    assert.match(linux, /npx playwright install --with-deps chromium\n/);
    assert.match(linux, /; chromium\n/);
    assert.doesNotMatch(linux, /install --with-deps[^\n]*webkit|; chromium webkit\n/);
    assert.match(linux, /python .*--deselect .*\[webkit\]/);

    const mac = run("--ci-macos-webkit", "true", "macOS");
    assert.doesNotMatch(mac, /npx .*playwright install/);
    assert.match(mac, /; webkit\n/);
    assert.doesNotMatch(mac, /; chromium webkit\n/);
    assert.match(mac, /python .*test_protected_document_browser_payment_preview_download_revoke\[webkit\]/);

    const local = run("all", "", "");
    assert.doesNotMatch(local, /npx .*playwright install/);
    assert.match(local, /; chromium webkit\n/);
    assert.match(local, /python .*test_account_phone_browser.py/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("review receipts do not expand a directly changed unit test into diagnostics", () => {
  const plan = buildPlan({ env: { CI_VALIDATION_LEVEL: "focused", CI_CHANGED_FILES:
    `hushh-webapp/${DIRECT_TEST}\nhushh-webapp/contracts/ui-review/back/review.json` } });
  assert.equal(plan.effectiveLevel, "focused");
  assert.deepEqual(plan.directFiles, [DIRECT_TEST]);
});

test("backend-only release still runs its named frontend core", () => {
  const plan = buildPlan({ env: { CI_VALIDATION_LEVEL: "release", CI_CHANGED_FILES:
    "consent-protocol/api/routes/health.py" } });
  assert.equal(plan.effectiveLevel, "release");
  assert.ok(plan.coreFiles.length > 0);
  assert.equal(plan.noUnitImpact, false);
});

test("presentation-only changes retain their browser owner without a full unit sweep", () => {
  const plan = buildPlan({ env: { CI_VALIDATION_LEVEL: "focused", CI_CHANGED_FILES:
    "hushh-webapp/components/agent/chat.module.css" } });
  assert.equal(plan.effectiveLevel, "focused");
  let full = 0;
  assert.equal(executePlan(plan, { runFullSuite() { full += 1; return { status: 1 }; } }), 0);
  assert.equal(full, 0);
});
