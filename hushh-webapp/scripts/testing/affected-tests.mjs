#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const CORE_SCRIPT_NAMES = [
  "verify:account-session",
  "verify:vault-unlock",
  "test:consent-memory-parity",
  "verify:agent-chat-protocol",
];
const WEB_CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const MAX_CHANGED_FILE_BYTES = 256 * 1024;
const MAX_CHANGED_FILES = 500;
const MAX_SOURCE_SCAN_BYTES = 64 * 1024 * 1024;
const OTHER_OWNER_FILES = new Set([
  // This browser-flow harness is covered by the hosted browser contract lane.
  "scripts/testing/phone-conflict-flow.mjs",
]);
const REGISTERED_CONTRACT_INPUTS = new Set([
  "app/register-phone/page.voice-action-contract.json",
  "contracts/kai/kai-action-gateway.vnext.json",
  "contracts/kai/one-capability-graph.v1.json",
  "frontend-native-surface-map.generated.json",
  "lib/navigation/app-route-layout.contract.json",
]);

function relativeWebPath(repoPath) {
  if (!repoPath.startsWith("hushh-webapp/")) return null;
  return repoPath.slice("hushh-webapp/".length);
}

function isVitestFile(file) {
  return /^__(?:tests)__\/.+\.test\.[jt]sx?$/.test(file) ||
    /^(?:lib|components|app)\/.+\/__tests__\/.+\.test\.[jt]sx?$/.test(file);
}

function isRuntimeModule(file) {
  return WEB_CODE_EXTENSIONS.has(path.extname(file)) &&
    !file.endsWith(".d.ts") &&
    /^(?:app|components|hooks|lib|utils)\//.test(file) &&
    !file.startsWith("__tests__/") &&
    !file.includes("/__tests__/");
}

function isSharedDependency(file) {
  return /^(?:package(?:-lock)?\.json|vitest\.config\.[jt]s|vite\.config\.[jt]s|tsconfig[^/]*\.json)$/.test(file) ||
    file === "__tests__/setup.ts" ||
    file === "app/globals.css" ||
    file === "app/layout.tsx" ||
    file === "app/providers.tsx" ||
    /^(?:components\/(?:app-ui|ui)|lib\/capacitor)\//.test(file) ||
    /^lib\/services\/(?:api-service|auth-service|account-service)\.ts$/.test(file);
}

function isRegisteredContractInput(file) {
  return REGISTERED_CONTRACT_INPUTS.has(file);
}

function isOtherOwnerFile(file) {
  // The native job owns all iOS Swift sources; Vitest cannot exercise them.
  return OTHER_OWNER_FILES.has(file) || (file.startsWith("ios/") && file.endsWith(".swift"));
}

function readChangedFiles(env) {
  const inline = env.CI_CHANGED_FILES;
  const filePath = env.CI_CHANGED_FILES_FILE;
  if (inline && filePath) return { ok: false, reason: "ambiguous_changed_file_inputs" };

  let raw;
  if (filePath) {
    try {
      const fileInfo = lstatSync(filePath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_CHANGED_FILE_BYTES) {
        return { ok: false, reason: "invalid_changed_files_file" };
      }
      raw = readFileSync(filePath, "utf8");
    } catch {
      return { ok: false, reason: "missing_changed_files_file" };
    }
  } else if (typeof inline === "string" && inline.length > 0) {
    if (Buffer.byteLength(inline, "utf8") > MAX_CHANGED_FILE_BYTES) {
      return { ok: false, reason: "changed_file_list_too_large" };
    }
    raw = inline;
  } else {
    return { ok: false, reason: "missing_changed_files" };
  }

  if (raw.includes("\0")) return { ok: false, reason: "malformed_changed_file_list" };
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length > MAX_CHANGED_FILES) {
    return { ok: false, reason: lines.length === 0 ? "empty_changed_file_list" : "too_many_changed_files" };
  }

  const webFiles = new Set();
  for (const line of lines) {
    if (line !== line.trim() || line.includes("\\") || path.posix.isAbsolute(line) || /[\x00-\x1f\x7f]/.test(line)) {
      return { ok: false, reason: "malformed_changed_file_list" };
    }
    const normalized = path.posix.normalize(line);
    if (normalized !== line || normalized === "." || normalized.startsWith("../")) {
      return { ok: false, reason: "malformed_changed_file_list" };
    }
    const webFile = relativeWebPath(normalized);
    if (webFile) webFiles.add(webFile);
  }
  return { ok: true, files: [...webFiles].sort() };
}

function scriptTestFiles(script) {
  const vitestStart = script.indexOf("vitest run");
  if (vitestStart < 0) return [];
  const command = script.slice(vitestStart + "vitest run".length).split(/\s&&\s/, 1)[0];
  return [...command.matchAll(/(?:^|\s)(__tests__\/[A-Za-z0-9_./-]+\.test\.[jt]sx?)(?=\s|$)/g)]
    .map((match) => match[1]);
}

function coreTestFiles(repoRoot) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(repoRoot, "hushh-webapp/package.json"), "utf8"));
  } catch {
    return { ok: false, reason: "invalid_web_package_manifest" };
  }
  const tests = new Set();
  for (const name of CORE_SCRIPT_NAMES) {
    const script = packageJson.scripts?.[name];
    if (typeof script !== "string") return { ok: false, reason: `missing_core_script_${name}` };
    const files = scriptTestFiles(script);
    if (files.length === 0) return { ok: false, reason: `missing_core_tests_${name}` };
    for (const file of files) {
      if (!existsSync(path.join(repoRoot, "hushh-webapp", file))) {
        return { ok: false, reason: `missing_core_test_file_${name}` };
      }
    }
    for (const file of files) tests.add(file);
  }
  return { ok: true, files: [...tests].sort() };
}

function accountDeletionClientFiles(repoRoot) {
  let script;
  try {
    script = readFileSync(path.join(repoRoot, "scripts/ci/account-deletion-check.sh"), "utf8");
  } catch {
    return { ok: false, reason: "missing_account_deletion_owner" };
  }
  const match = script.match(/vitest run[ \t]*\\\r?\n([\s\S]*?)--maxWorkers=2/);
  if (!match) return { ok: false, reason: "invalid_account_deletion_owner" };
  const files = [...match[1].matchAll(/(__tests__\/[A-Za-z0-9_./-]+\.test\.[jt]sx?)/g)]
    .map((entry) => entry[1]);
  if (files.length === 0 || new Set(files).size !== files.length) {
    return { ok: false, reason: "invalid_account_deletion_test_list" };
  }
  return { ok: true, files };
}

function listTrackedSources(repoRoot) {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "--", "hushh-webapp"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
  const files = [];
  for (const repoFile of tracked) {
    const webFile = relativeWebPath(repoFile);
    if (!webFile || !WEB_CODE_EXTENSIONS.has(path.extname(webFile))) continue;
    if (webFile.includes("/node_modules/") || webFile.includes("/.next/")) continue;
    files.push(webFile);
  }
  return files;
}

function pathCandidates(base) {
  return [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
    path.join(base, "index.ts"), path.join(base, "index.tsx"),
    path.join(base, "index.js"), path.join(base, "index.jsx"),
  ].map((candidate) => path.normalize(candidate));
}

function resolveDynamicSpecifier(specifier, importer, webRoot) {
  if (specifier.startsWith("@/")) return pathCandidates(path.join(webRoot, specifier.slice(2)));
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return pathCandidates(path.resolve(webRoot, path.dirname(importer), specifier));
  }
  return [];
}

function dynamicImportRisk(repoRoot, changedFiles) {
  const tracked = listTrackedSources(repoRoot);
  if (!tracked) return "unable_to_inspect_import_graph";
  let bytesRead = 0;
  const changed = new Set(changedFiles.map((file) => path.normalize(file)));
  for (const importer of tracked) {
    const fullPath = path.join(repoRoot, "hushh-webapp", importer);
    let source;
    try {
      const info = statSync(fullPath);
      bytesRead += info.size;
      if (bytesRead > MAX_SOURCE_SCAN_BYTES) return "import_scan_limit_exceeded";
      source = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    const calls = source.matchAll(/\bimport\s*\(([^)]{1,500})\)/g);
    for (const call of calls) {
      const arg = call[1].trim();
      const literal = arg.match(/^(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)\s*$/);
      const specifier = literal?.[1] ?? literal?.[2] ?? literal?.[3];
      if (specifier && !specifier.includes("${")) {
        const candidates = resolveDynamicSpecifier(specifier, importer, path.join(repoRoot, "hushh-webapp"));
        if (candidates.some((candidate) => changed.has(path.normalize(path.relative(path.join(repoRoot, "hushh-webapp"), candidate))))) {
          return "dynamic_import_dependency";
        }
      } else {
        const referenced = [...changed].some((file) => {
          const base = path.basename(file, path.extname(file));
          return source.includes(file) || source.includes(base);
        });
        if (referenced) return "computed_dynamic_import_dependency";
      }
    }
  }
  return null;
}

function sourceRisk(repoRoot, files, level) {
  for (const file of files) {
    if (isSharedDependency(file)) return "shared_dependency";
    if (isVitestFile(file)) {
      const fullPath = path.join(repoRoot, "hushh-webapp", file);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return "missing_changed_test";
      continue;
    }
    if (isRegisteredContractInput(file)) {
      const fullPath = path.join(repoRoot, "hushh-webapp", file);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return "missing_changed_source";
      continue;
    }
    if (!isRuntimeModule(file)) return "unknown_changed_file_type";
    const fullPath = path.join(repoRoot, "hushh-webapp", file);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return "missing_changed_source";
  }
  const sourceFiles = files.filter((file) =>
    isRuntimeModule(file) || isRegisteredContractInput(file));
  if (sourceFiles.length === 0) return null;
  if (level === "focused" || level === "release") {
    return dynamicImportRisk(repoRoot, sourceFiles);
  }
  return null;
}

function buildPlan({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const rawLevel = env.CI_VALIDATION_LEVEL;
  const requestedLevel = rawLevel || "diagnostic";
  const base = {
    requestedLevel,
    effectiveLevel: "diagnostic",
    fallbackReason: null,
    changedFiles: [],
    relatedFiles: [],
    directFiles: [],
    coreFiles: [],
    excludeFiles: [],
    accountDeletionClientOwner: false,
    noUnitImpact: false,
  };

  if (!["focused", "release", "diagnostic"].includes(requestedLevel)) {
    return { ...base, fallbackReason: "unknown_validation_level" };
  }
  if (requestedLevel === "diagnostic") {
    return { ...base, fallbackReason: null };
  }

  const changed = readChangedFiles(env);
  if (!changed.ok) return { ...base, fallbackReason: changed.reason };
  // Browser fixtures, review receipts and local styling have another required
  // owner; mixing them into a source change must not expand all unit tests.
  const unitFiles = changed.files.filter((file) =>
    !/^(?:contracts\/ui-review\/|docs\/|e2e\/)/.test(file) &&
    !isOtherOwnerFile(file) &&
    !file.endsWith(".md") && !(file.endsWith(".css") && file !== "app/globals.css"));
  if (requestedLevel === "focused" && unitFiles.length === 0) {
    return { ...base, effectiveLevel: "focused", changedFiles: changed.files, noUnitImpact: true };
  }
  const risk = sourceRisk(repoRoot, unitFiles, requestedLevel);
  if (risk) return { ...base, changedFiles: changed.files, fallbackReason: risk };

  const directTests = unitFiles.filter(isVitestFile);
  const relatedFiles = unitFiles.filter(
    (file) => isRuntimeModule(file) || isRegisteredContractInput(file),
  );
  if (requestedLevel === "focused" && relatedFiles.length === 0 && directTests.length === 0) {
    return { ...base, changedFiles: changed.files, fallbackReason: "no_related_test_inputs" };
  }

  const accountOwner = env.CI === "true" && env.CI_ACCOUNT_DELETION_CLIENT_OWNED === "1";
  const deletion = accountDeletionClientFiles(repoRoot);
  if (!deletion.ok) return { ...base, changedFiles: changed.files, fallbackReason: deletion.reason };
  const deletionSet = new Set(deletion.files);
  const changedTests = directTests.filter((file) => !accountOwner || !deletionSet.has(file));
  const excluded = accountOwner ? deletion.files : [];
  let coreFiles = [];

  if (requestedLevel === "release") {
    const core = coreTestFiles(repoRoot);
    if (!core.ok) return { ...base, changedFiles: changed.files, fallbackReason: core.reason };
    coreFiles = core.files.filter((file) => !accountOwner || !deletionSet.has(file));
    if (!accountOwner) {
      coreFiles = [...new Set([...coreFiles, ...deletion.files])].sort();
    }
    if (coreFiles.length === 0) {
      return { ...base, changedFiles: changed.files, fallbackReason: "empty_release_core" };
    }
  }

  return {
    ...base,
    effectiveLevel: requestedLevel,
    changedFiles: changed.files,
    relatedFiles,
    directFiles: changedTests,
    coreFiles,
    excludeFiles: [...new Set([...excluded, ...changedTests])].sort(),
    accountDeletionClientOwner: accountOwner,
    noUnitImpact: requestedLevel === "focused" && relatedFiles.length === 0 && changedTests.length === 0 && accountOwner,
  };
}

function readRelatedReport(reportPath, repoRoot = REPO_ROOT) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!Array.isArray(report.testResults)) return null;
    const testFiles = new Set();
    for (const result of report.testResults) {
      if (typeof result.name !== "string") return null;
      const absolute = path.resolve(WEB_ROOT, result.name);
      const relative = path.relative(path.join(repoRoot, "hushh-webapp"), absolute).split(path.sep).join("/");
      if (!isVitestFile(relative)) return null;
      testFiles.add(relative);
    }
    return { hasTests: testFiles.size > 0, testFiles: [...testFiles] };
  } catch {
    return null;
  }
}

function runVitest(args, { cwd, env = process.env }) {
  return spawnSync("npm", args, { cwd, env, stdio: "inherit" });
}

function runFull({ maxWorkers, shard }) {
  const args = ["run", "test:ci", "--"];
  if (shard) args.push(`--shard=${shard}`);
  args.push(`--maxWorkers=${maxWorkers}`);
  return runVitest(args, { cwd: WEB_ROOT });
}

function executePlan(plan, {
  maxWorkers = "2",
  shard = "",
  runVitestCommand = runVitest,
  runFullSuite = runFull,
} = {}) {
  if (!/^[1-9][0-9]*$/.test(maxWorkers)) {
    console.error("HUSHH_WEB_TEST_MAX_WORKERS must be a positive integer.");
    return 2;
  }
  const validLevels = ["focused", "release", "diagnostic"];
  if (!plan || !validLevels.includes(plan.effectiveLevel) ||
      !["relatedFiles", "directFiles", "coreFiles", "excludeFiles"].every((field) => Array.isArray(plan[field]))) {
    console.error("Affected Vitest plan is invalid; running the full diagnostic suite.");
    const full = runFullSuite({ maxWorkers, shard: "" });
    return full.status ?? 1;
  }
  if (plan.effectiveLevel === "diagnostic") {
    if (plan.fallbackReason) {
      console.log(`Affected Vitest selection unavailable (${plan.fallbackReason}); running the full diagnostic suite.`);
    } else {
      console.log("CI_VALIDATION_LEVEL=diagnostic; running the historical full Vitest suite.");
    }
    const result = runFullSuite({ maxWorkers, shard });
    return result.status ?? 1;
  }

  if (plan.effectiveLevel === "focused" && plan.noUnitImpact === true &&
      plan.relatedFiles.length === 0 && plan.directFiles.length === 0 && plan.coreFiles.length === 0) {
    console.log("No unit-runtime impact: required browser/integration owners cover this change.");
    return 0;
  }

  const excludes = plan.excludeFiles.flatMap((file) => ["--exclude", `**/${file}`]);
  let relatedTestsRan = false;
  let relatedTestFiles = [];
  if (plan.relatedFiles.length > 0) {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hushh-vitest-related-"));
    const reportPath = path.join(tempDir, "related.json");
    try {
      console.log(`Running ${plan.effectiveLevel} Vitest selection for ${plan.relatedFiles.length} changed file(s).`);
      const result = runVitestCommand([
        "exec", "--", "vitest", "related", "--run", "--passWithNoTests",
        `--maxWorkers=${maxWorkers}`, "--reporter=default", "--reporter=json",
        `--outputFile.json=${reportPath}`,
        ...excludes,
        ...plan.relatedFiles,
      ], { cwd: WEB_ROOT });
      if (result.status !== 0) return result.status ?? 1;
      const report = readRelatedReport(reportPath);
      if (!report?.hasTests) {
        console.log("Vitest related selected no test files; running the full diagnostic suite.");
        const full = runFullSuite({ maxWorkers, shard: "" });
        return full.status ?? 1;
      }

      relatedTestsRan = true;
      relatedTestFiles = report.testFiles;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const selectedFiles = [...new Set([
    ...(plan.effectiveLevel === "release" ? plan.coreFiles : []),
    ...plan.directFiles,
  ])].filter((file) => !relatedTestFiles.includes(file)).sort();
  if (selectedFiles.length > 0) {
    if (plan.effectiveLevel === "release" && plan.coreFiles.length === 0) {
      console.log("Release core selection was empty; running the full diagnostic suite.");
      const full = runFullSuite({ maxWorkers, shard: "" });
      return full.status ?? 1;
    }
    console.log(`Running ${selectedFiles.length} selected core or directly changed Vitest file(s).`);
    const result = runVitestCommand([
      "run", "test:ci", "--", `--maxWorkers=${maxWorkers}`, ...selectedFiles,
    ], { cwd: WEB_ROOT });
    return result.status ?? 1;
  }
  if (relatedTestsRan) return 0;
  console.log("Affected Vitest selection was empty; running the full diagnostic suite.");
  const full = runFullSuite({ maxWorkers, shard: "" });
  return full.status ?? 1;
}

function main(argv) {
  const [command, planPath, ...options] = argv;
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(buildPlan())}\n`);
    return 0;
  }
  if (command === "run" && planPath) {
    let plan;
    try {
      plan = JSON.parse(readFileSync(planPath, "utf8"));
    } catch {
      console.error("Affected Vitest plan is missing or invalid; running the full diagnostic suite.");
      const fallback = runFull({ maxWorkers: process.env.HUSHH_WEB_TEST_MAX_WORKERS || "2", shard: "" });
      return fallback.status ?? 1;
    }
    const optionArgs = Object.fromEntries(options.map((arg) => arg.split("=", 2)));
    return executePlan(plan, {
      maxWorkers: optionArgs["--max-workers"] || process.env.HUSHH_WEB_TEST_MAX_WORKERS || "2",
      shard: optionArgs["--shard"] || process.env.WEB_FULL_SUITE_SHARD || "",
    });
  }
  console.error("Usage: affected-tests.mjs plan | run <plan-file> [--max-workers=N] [--shard=I/T]");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export {
  accountDeletionClientFiles,
  buildPlan,
  coreTestFiles,
  dynamicImportRisk,
  executePlan,
  isSharedDependency,
  readRelatedReport,
  readChangedFiles,
  scriptTestFiles,
};
