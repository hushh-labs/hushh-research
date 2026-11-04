// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPlan, dynamicImportRisk, executePlan } from "./affected-tests.mjs";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const DELETE_TEST = "__tests__/lib/flows/delete-account.test.ts";
const DIRECT_TEST = "__tests__/services/agent-chat-client.test.ts";

function buildImportGraphFixture(files, changedPaths) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hushh-import-graph-"));
  const repo = path.join(tmp, "repo");
  const bin = path.join(tmp, "bin");
  const originalPath = process.env.PATH;
  const fixtureFiles = {
    "hushh-webapp/tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        baseUrl: ".",
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        paths: { "@/*": ["./*"] },
      },
    }),
    "hushh-webapp/lib/fixture.ts": "export {};\n",
    "scripts/ci/account-deletion-check.sh": "vitest run \\\n  __tests__/services/account-deletion.test.ts \\\n  --maxWorkers=2\n",
    ...files,
  };
  try {
    mkdirSync(bin);
    for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
      const fullPath = path.join(repo, relativePath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, contents);
    }
    writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${Object.keys(fixtureFiles).join("\0")}\0`)});\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${originalPath || ""}`;
    const plan = buildPlan({
      env: {
        CI_VALIDATION_LEVEL: "focused",
        CI_CHANGED_FILES: changedPaths.map((file) => `hushh-webapp/${file}`).join("\n"),
      },
      repoRoot: repo,
    });
    return plan;
  } finally {
    process.env.PATH = originalPath;
    rmSync(tmp, { recursive: true, force: true });
  }
}

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
  assert.equal(plan.effectiveLevel, "focused", plan.fallbackReason);
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

test("known native and browser harness inputs stay with their other owner", () => {
  const plan = buildPlan({ env: {
    CI_VALIDATION_LEVEL: "focused",
    CI_CHANGED_FILES: [
      "hushh-webapp/ios/App/AppTests/NativeSupportTests.swift",
      "hushh-webapp/ios/App/AppTests/AccountFlowTests.swift",
      "hushh-webapp/scripts/testing/phone-conflict-flow.mjs",
    ].join("\n"),
  } });
  assert.equal(plan.effectiveLevel, "focused");
  assert.equal(plan.noUnitImpact, true);
  assert.deepEqual(plan.relatedFiles, []);
  assert.deepEqual(plan.directFiles, []);
});

test("registered generated contracts feed Vitest related selection", () => {
  const contracts = [
    `app/register-phone/${["page.voice", "-action-contract.json"].join("")}`,
    `contracts/kai/${["kai-action-gateway", ".vnext.json"].join("")}`,
    `contracts/kai/${["one-capability-graph", ".v1.json"].join("")}`,
    ["frontend-native-surface-map", ".generated.json"].join(""),
    `lib/navigation/${["app-route-layout", ".contract.json"].join("")}`,
  ];
  const plan = buildImportGraphFixture(
    Object.fromEntries(contracts.map((file) => [`hushh-webapp/${file}`, "{}\n"])),
    contracts,
  );
  assert.equal(plan.effectiveLevel, "focused", plan.fallbackReason);
  assert.equal(plan.fallbackReason, null);
  assert.deepEqual(plan.relatedFiles, contracts.sort());
  assert.deepEqual(plan.directFiles, []);
});

test("AST import graph ignores comments and E2E-only dynamic fixtures", () => {
  const changed = "app/register-phone/page.tsx";
  const plan = buildImportGraphFixture({
    "hushh-webapp/app/register-phone/page.tsx": "export const page = true;\n",
    "hushh-webapp/components/kai/kai-flow.tsx": "// Handle re-import (upload new statement)\nexport {};\n",
    "hushh-webapp/e2e/layout.spec.ts": "export const load = () => import(path.join(root, 'tailwindcss'));\n",
  }, [changed]);
  assert.equal(plan.effectiveLevel, "focused");
  assert.equal(plan.fallbackReason, null);
  assert.deepEqual(plan.relatedFiles, [changed]);
});

test("computed unit-test imports select the importer when they resolve to changed input", () => {
  const contract = `contracts/kai/${["one-capability-graph", ".v1.json"].join("")}`;
  const testFile = "__tests__/contracts/graph-loader.test.ts";
  const plan = buildImportGraphFixture({
    [`hushh-webapp/${contract}`]: "{}\n",
    [`hushh-webapp/${testFile}`]:
      `const MODULE_PATH = "@/${contract}"; await import(MODULE_PATH);\n`,
  }, [contract]);
  assert.equal(plan.effectiveLevel, "focused");
  assert.equal(plan.fallbackReason, null);
  assert.deepEqual(plan.directFiles, [testFile]);
});

test("unit-only computed-import helpers select every whole Vitest owner", () => {
  const cases = [
    ["hushh-webapp/e2e/unit-helper.ts", "../e2e/unit-helper"],
    ["scripts/ci/unit-helper.ts", "../../scripts/ci/unit-helper"],
  ];
  for (const [helper, specifier] of cases) {
    const owners = ["__tests__/unit-a.test.ts", "__tests__/unit-b.test.ts"];
    const plan = buildImportGraphFixture({
      "hushh-webapp/lib/changed.ts": "export const changed = true;\n",
      ...Object.fromEntries(owners.map((owner) => [
        `hushh-webapp/${owner}`,
        `import { load } from "${specifier}"; void load;\n`,
      ])),
      [helper]: "export const load = (target: string) => import(target);\n",
    }, ["lib/changed.ts"]);
    assert.equal(plan.effectiveLevel, "focused", helper);
    assert.equal(plan.fallbackReason, null, helper);
    assert.deepEqual(plan.directFiles, owners, helper);
  }
});

test("literal CommonJS require and proven createRequire aliases follow local modules", () => {
  const owner = "__tests__/require-owners.test.ts";
  const cases = [
    ["scripts/ci/require-helper.cjs", `module.exports = require("../../hushh-webapp/lib/changed");\n`, "../../scripts/ci/require-helper.cjs"],
    [
      "scripts/ci/create-require-helper.mjs",
      'import { createRequire } from "node:module"; const requireWeb = createRequire(import.meta.url); export const load = () => requireWeb("../../hushh-webapp/lib/changed");\n',
      "../../scripts/ci/create-require-helper.mjs",
    ],
    [
      "scripts/ci/aliased-create-require-helper.mjs",
      'import { createRequire as makeRequire } from "node:module"; const requireWeb = makeRequire(import.meta.url); export const load = () => requireWeb("../../hushh-webapp/lib/changed");\n',
      "../../scripts/ci/aliased-create-require-helper.mjs",
    ],
  ];
  for (const [helper, contents, specifier] of cases) {
    const plan = buildImportGraphFixture({
      "hushh-webapp/lib/changed.js": "export const changed = true;\n",
      [`hushh-webapp/${owner}`]: `import helper from "${specifier}"; void helper;\n`,
      [helper]: contents,
    }, ["lib/changed.js"]);
    assert.equal(plan.effectiveLevel, "focused", helper);
    assert.equal(plan.fallbackReason, null, helper);
    assert.deepEqual(plan.directFiles, [owner], `${helper}: ${JSON.stringify(plan)}`);
  }
});

test("unresolved CommonJS and unproved createRequire calls retain their unit owners", () => {
  const owner = "__tests__/computed-require.test.ts";
  const cases = [
    ["scripts/ci/computed-require.cjs", "module.exports = (target) => require(target);\n"],
    [
      "scripts/ci/custom-base-require.mjs",
      'import { createRequire } from "node:module"; const requireWeb = createRequire(new URL("./package.json", import.meta.url)); export const load = () => requireWeb("./changed");\n',
    ],
    [
      "scripts/ci/namespace-create-require.mjs",
      'import * as nodeModule from "node:module"; const requireWeb = nodeModule.createRequire(import.meta.url); export const load = () => requireWeb("./changed");\n',
    ],
    [
      "scripts/ci/aliased-factory-require.mjs",
      'import { createRequire } from "node:module"; const makeRequire = createRequire; const requireWeb = makeRequire(import.meta.url); export const load = () => requireWeb("./changed");\n',
    ],
  ];
  for (const [helper, contents] of cases) {
    const plan = buildImportGraphFixture({
      "hushh-webapp/lib/changed.ts": "export const changed = true;\n",
      [`hushh-webapp/${owner}`]: `import helper from "../../${helper}"; void helper;\n`,
      [helper]: contents,
    }, ["lib/changed.ts"]);
    assert.equal(plan.effectiveLevel, "focused", helper);
    assert.equal(plan.fallbackReason, null, helper);
    assert.deepEqual(plan.directFiles, [owner], helper);
  }
});

test("a CommonJS helper with a computed require stays diagnostic if runtime also imports it", () => {
  const plan = buildImportGraphFixture({
    "hushh-webapp/lib/changed.ts": "export const changed = true;\n",
    "hushh-webapp/__tests__/unit.test.ts": 'import load from "../../scripts/ci/computed-require.cjs"; void load;\n',
    "hushh-webapp/components/runtime.ts": 'import load from "../../scripts/ci/computed-require.cjs"; void load;\n',
    "scripts/ci/computed-require.cjs": "module.exports = (target) => require(target);\n",
  }, ["lib/changed.ts"]);
  assert.equal(plan.effectiveLevel, "diagnostic");
  assert.equal(plan.fallbackReason, "computed_dynamic_import_dependency");
});

test("require aliases select whole unit owners but remain diagnostic when runtime-reachable", () => {
  const helper = "scripts/ci/loader-alias.cjs";
  const owner = "__tests__/loader-alias.test.ts";
  const files = {
    "hushh-webapp/lib/changed.js": "export const changed = true;\n",
    [`hushh-webapp/${owner}`]: 'import load from "../../scripts/ci/loader-alias.cjs"; void load;\n',
    [helper]: "const req = require; const req2 = req; const { resolve } = req2; module.exports = (target) => req2(target);\n",
  };
  const unitOnly = buildImportGraphFixture(files, ["lib/changed.js"]);
  assert.equal(unitOnly.effectiveLevel, "focused");
  assert.equal(unitOnly.fallbackReason, null);
  assert.deepEqual(unitOnly.directFiles, [owner]);

  const runtimeReachable = buildImportGraphFixture({
    ...files,
    "hushh-webapp/components/runtime.ts": 'import load from "../../scripts/ci/loader-alias.cjs"; void load;\n',
  }, ["lib/changed.js"]);
  assert.equal(runtimeReachable.effectiveLevel, "diagnostic");
  assert.equal(runtimeReachable.fallbackReason, "computed_dynamic_import_dependency");
});

test("a computed-import helper reachable from runtime still selects diagnostics", () => {
  const plan = buildImportGraphFixture({
    "hushh-webapp/lib/changed.ts": "export const changed = true;\n",
    "hushh-webapp/__tests__/unit.test.ts": 'import { load } from "../../scripts/ci/unit-helper"; void load;\n',
    "hushh-webapp/components/runtime.ts": 'import { load } from "../../scripts/ci/unit-helper"; void load;\n',
    "scripts/ci/unit-helper.ts": "export const load = (target: string) => import(target);\n",
  }, ["lib/changed.ts"]);
  assert.equal(plan.effectiveLevel, "diagnostic");
  assert.equal(plan.fallbackReason, "computed_dynamic_import_dependency");
});

test("shadowed unit imports select their whole owner and runtime imports remain conservative", () => {
  const shadowed = buildImportGraphFixture({
    "hushh-webapp/lib/changed.ts": "export const changed = true;\n",
    "hushh-webapp/lib/other.ts": "export const other = true;\n",
    "hushh-webapp/__tests__/shadowed.test.ts":
      'const MODULE_PATH = "@/lib/other"; function load(MODULE_PATH: string) { return import(MODULE_PATH); }\n',
  }, ["lib/changed.ts"]);
  assert.equal(shadowed.effectiveLevel, "focused");
  assert.equal(shadowed.fallbackReason, null);
  assert.deepEqual(shadowed.directFiles, ["__tests__/shadowed.test.ts"]);

  const runtime = buildImportGraphFixture({
    "hushh-webapp/lib/changed.ts": "export const changed = true;\n",
    "hushh-webapp/components/runtime-loader.ts":
      'const MODULE_PATH = "@/lib/changed"; export const load = () => import(MODULE_PATH);\n',
  }, ["lib/changed.ts"]);
  assert.equal(runtime.effectiveLevel, "diagnostic");
  assert.equal(runtime.fallbackReason, "dynamic_import_dependency");

  const cjsRuntime = buildImportGraphFixture({
    "hushh-webapp/lib/changed.js": "export const changed = true;\n",
    "hushh-webapp/components/runtime-loader.cjs": "module.exports = (target) => require(target);\n",
  }, ["lib/changed.js"]);
  assert.equal(cjsRuntime.effectiveLevel, "diagnostic");
  assert.equal(cjsRuntime.fallbackReason, "computed_dynamic_import_dependency");
});

test("changed JSON test fixtures retain their importing tests without diagnostic expansion", () => {
  const fixture = "__tests__/fixtures/calendar-chat-controlled-results.json";
  const owner = "__tests__/components/calendar-chat-controlled-flow.test.tsx";
  const plan = buildImportGraphFixture({
    [`hushh-webapp/${fixture}`]: '{"status":"review_required"}\n',
    [`hushh-webapp/${owner}`]: 'import result from "../fixtures/calendar-chat-controlled-results.json"; void result;\n',
  }, [fixture]);
  assert.equal(plan.effectiveLevel, "focused");
  assert.equal(plan.fallbackReason, null);
  assert.deepEqual(plan.relatedFiles, [fixture]);
  assert.equal(plan.noUnitImpact, false);

  const missing = buildImportGraphFixture({}, [fixture]);
  assert.equal(missing.effectiveLevel, "diagnostic");
  assert.equal(missing.fallbackReason, "missing_changed_source");
});

test("other-owner inputs do not hide changed unit tests or unknown runtime JSON", () => {
  const registered = `contracts/kai/${["kai-action-gateway", ".vnext.json"].join("")}`;
  const mixed = buildImportGraphFixture({
    [`hushh-webapp/${DIRECT_TEST}`]: "import { expect, test } from 'vitest'; test('selected', () => expect(true).toBe(true));\n",
    [`hushh-webapp/${registered}`]: "{}\n",
  }, [
    "ios/App/AppTests/NativeSupportTests.swift",
    "ios/App/AppTests/AccountFlowTests.swift",
    "scripts/testing/phone-conflict-flow.mjs",
    registered,
    DIRECT_TEST,
  ]);
  assert.equal(mixed.effectiveLevel, "focused");
  assert.deepEqual(mixed.directFiles, [DIRECT_TEST]);
  assert.deepEqual(mixed.relatedFiles, [registered]);

  for (const path of [
    "hushh-webapp/lib/vault/passkey-domain-aliases.json",
    "hushh-webapp/lib/unregistered-runtime.json",
  ]) {
    const unknown = buildPlan({ env: {
      CI_VALIDATION_LEVEL: "focused",
      CI_CHANGED_FILES: path,
    } });
    assert.equal(unknown.effectiveLevel, "diagnostic", path);
    assert.equal(unknown.fallbackReason, "unknown_changed_file_type", path);
  }
});

test("dynamic import scanning retains a finite 64 MiB fail-closed limit", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hushh-dynamic-import-limit-"));
  const repo = path.join(tmp, "repo");
  const source = path.join(repo, "hushh-webapp/lib/large-source.ts");
  const bin = path.join(tmp, "bin");
  const originalPath = process.env.PATH;
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    mkdirSync(path.dirname(path.join(repo, "hushh-webapp/tsconfig.json")), { recursive: true });
    mkdirSync(bin);
    writeFileSync(path.join(repo, "hushh-webapp/tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }));
    writeFileSync(source, "");
    truncateSync(source, 64 * 1024 * 1024 + 1);
    writeFileSync(
      path.join(bin, "git"),
      "#!/usr/bin/env node\nprocess.stdout.write('hushh-webapp/lib/large-source.ts\\0');\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${originalPath || ""}`;
    assert.equal(
      dynamicImportRisk(repo, ["lib/large-source.ts"]).reason,
      "import_scan_limit_exceeded",
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});
