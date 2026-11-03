#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh

import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MAX_CHANGED_FILE_BYTES = 256 * 1024;
const MAX_CHANGED_FILES = 500;
const MAX_SOURCE_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_GRAPH_STATES = 250_000;
const MAX_IMPORT_GRAPH_EDGES = 500_000;
const OTHER_OWNER_FILES = new Set([
  // This browser-flow harness is covered by the hosted browser contract lane.
  "scripts/testing/phone-conflict-flow.mjs",
]);
const REGISTERED_CONTRACT_INPUTS = new Set([
  "app/register-phone/page.voice-action-contract.json",
  "contracts/kai/kai-action-gateway.vnext.json",
  "contracts/kai/one-capability-graph.v1.json",
  "contracts/kai/one-route-orchestration-index.v1.json",
  "cache-coherence-screen-manifest.generated.json",
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
  return SOURCE_EXTENSIONS.has(path.extname(file)) &&
    !file.endsWith(".d.ts") &&
    /^(?:app|components|hooks|lib|utils)\//.test(file) &&
    !file.startsWith("__tests__/") &&
    !file.includes("/__tests__/");
}

function isSharedDependency(file) {
  return /^(?:package(?:-lock)?\.json|vitest\.config\.[jt]s|vite\.config\.[jt]s|tsconfig[^/]*\.json)$/.test(file) ||
    file === "__tests__/setup.ts" ||
    file === "app/layout.tsx" ||
    file === "app/providers.tsx" ||
    /^(?:components\/(?:app-ui|ui)|lib\/capacitor)\//.test(file) ||
    /^lib\/services\/(?:api-service|auth-service|account-service)\.ts$/.test(file);
}

function isRegisteredContractInput(file) {
  // All authored route action contracts share the UI compiler owner. Keep
  // these as graph inputs (not exclusions), so their consumers are tested.
  return REGISTERED_CONTRACT_INPUTS.has(file) ||
    /^app\/.+\/page\.voice-action-contract\.json$/.test(file);
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

function listTrackedFiles(repoRoot) {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
  return tracked;
}

const requireFromHere = createRequire(import.meta.url);
let cachedTypeScript;

function loadTypeScriptParser() {
  if (cachedTypeScript !== undefined) return cachedTypeScript;
  try {
    cachedTypeScript = requireFromHere("../architecture/ui-source-index.mjs").ts;
  } catch {
    cachedTypeScript = null;
  }
  return cachedTypeScript;
}

function isSourceDeclaration(node, ts) {
  return ts.isVariableDeclaration(node) || ts.isParameter(node) ||
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node) ||
    ts.isTypeParameterDeclaration(node) || ts.isImportClause(node) ||
    ts.isImportSpecifier(node) || ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node) || ts.isBindingElement(node);
}

function stringLiteralValue(node, ts) {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function constantStringBindings(sourceFile, ts) {
  const declarations = new Map();
  const topLevelStrings = new Map();
  const visit = (node) => {
    if (isSourceDeclaration(node, ts) && node.name && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, (declarations.get(node.name.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) ||
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      topLevelStrings.set(declaration.name.text, stringLiteralValue(declaration.initializer, ts));
    }
  }
  visit(sourceFile);
  return {
    declarations,
    resolve(identifier) {
      return declarations.get(identifier) === 1
        ? topLevelStrings.get(identifier) ?? null
        : null;
    },
  };
}

function isImportMetaUrl(node, ts) {
  return ts.isPropertyAccessExpression(node) && node.name.text === "url" &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta";
}

function createRequireBindings(sourceFile, bindings, ts) {
  const importedCreateRequire = new Set();
  const safeAliases = new Set();
  const unresolvedAliases = new Set();
  const safeInitializers = new Set();
  let unprovedAlias = false;
  const aliasCandidates = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !["module", "node:module"].includes(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if ((element.propertyName ?? element.name).text === "createRequire") {
        importedCreateRequire.add(element.name.text);
      }
    }
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer)) {
        aliasCandidates.push({ aliases: [node.name.text], source: node.initializer.text });
      } else if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === "resolve" && ts.isIdentifier(node.initializer.expression)) {
        aliasCandidates.push({ aliases: [node.name.text], source: node.initializer.expression.text });
      } else if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer)) {
        aliasCandidates.push({
          aliases: node.name.elements.flatMap((element) =>
            ts.isIdentifier(element.name) ? [element.name.text] : []),
          source: node.initializer.text,
        });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const alias = node.name.text;
      const initializer = node.initializer;
      const factoryExpression = ts.isCallExpression(initializer) ? initializer.expression : initializer;
      const createRequireName = ts.isIdentifier(factoryExpression) ? factoryExpression.text : null;
      const isFactoryCall = ts.isCallExpression(initializer) &&
        ((createRequireName === "createRequire" ||
          (createRequireName !== null && importedCreateRequire.has(createRequireName))) ||
          (ts.isPropertyAccessExpression(factoryExpression) && factoryExpression.name.text === "createRequire"));
      const isFactoryReference = ts.isIdentifier(initializer) &&
          (initializer.text === "createRequire" || importedCreateRequire.has(initializer.text)) ||
        ts.isPropertyAccessExpression(initializer) && initializer.name.text === "createRequire";
      if (isFactoryCall || isFactoryReference) {
        const trustedFactory = createRequireName !== null && importedCreateRequire.has(createRequireName) &&
          bindings.declarations.get(createRequireName) === 1;
        if (isFactoryCall && trustedFactory && bindings.declarations.get(alias) === 1 &&
            initializer.arguments.length === 1 && isImportMetaUrl(initializer.arguments[0], ts)) {
          safeAliases.add(alias);
          safeInitializers.add(initializer);
        } else {
          unresolvedAliases.add(alias);
          unprovedAlias = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const loaderAliases = new Set(["require", ...safeAliases, ...unresolvedAliases]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of aliasCandidates) {
      if (!loaderAliases.has(candidate.source)) continue;
      for (const alias of candidate.aliases) {
        if (loaderAliases.has(alias)) continue;
        loaderAliases.add(alias);
        unresolvedAliases.add(alias);
        unprovedAlias = true;
        changed = true;
      }
    }
  }
  return { safeAliases, unresolvedAliases, safeInitializers, importedCreateRequire, unprovedAlias };
}

function resolveImportTarget(specifier, importerPath, scan, ts) {
  let resolvedModule;
  try {
    resolvedModule = ts.resolveModuleName(
      specifier,
      importerPath,
      scan.compilerOptions,
      ts.sys,
      scan.resolutionCache,
    ).resolvedModule;
  } catch {
    return { error: "import_resolution_failed" };
  }
  if (!resolvedModule) {
    const specifierPath = specifier.split("?", 1)[0];
    const extension = path.extname(specifierPath);
    if (extension && !SOURCE_EXTENSIONS.has(extension) && extension !== ".json") {
      return { external: true };
    }
    const local = specifier.startsWith("./") || specifier.startsWith("../") ||
      specifier.startsWith("/") || Object.keys(scan.compilerOptions.paths ?? {}).some((alias) => {
        const [prefix, suffix] = alias.split("*");
        return specifier.startsWith(prefix) && (!suffix || specifier.endsWith(suffix));
      });
    return local ? { error: "unresolved_local_import" } : { external: true };
  }
  const absolutePath = path.resolve(resolvedModule.resolvedFileName);
  const repoPath = path.relative(scan.repoRoot, absolutePath).split(path.sep).join("/");
  if (repoPath.startsWith("../") || path.isAbsolute(repoPath)) {
    return absolutePath.split(path.sep).includes("node_modules")
      ? { external: true }
      : { error: "import_graph_escapes_repository" };
  }
  if (repoPath.split("/").some((part) => [".git", ".next", "node_modules"].includes(part))) {
    return { external: true };
  }
  if (!scan.tracked.has(repoPath)) return { error: "untracked_local_import" };
  const webPath = relativeWebPath(repoPath);
  return {
    repoPath,
    absolutePath,
    webPath,
    changed: webPath !== null && scan.changed.has(path.normalize(webPath)),
    source: SOURCE_EXTENSIONS.has(path.extname(repoPath)),
  };
}

function sourceImportGraphNode(repoPath, scan, ts) {
  if (scan.nodes.has(repoPath)) return scan.nodes.get(repoPath);
  const fullPath = path.join(scan.repoRoot, repoPath);
  let source;
  try {
    const size = statSync(fullPath).size;
    scan.bytesRead += size;
    if (scan.bytesRead > MAX_SOURCE_SCAN_BYTES) return { error: "import_scan_limit_exceeded" };
    source = readFileSync(fullPath, "utf8");
  } catch {
    return { error: "unable_to_read_import_graph" };
  }
  const extension = path.extname(fullPath);
  const scriptKind = extension === ".jsx" || extension === ".tsx"
    ? ts.ScriptKind.TSX
    : [".cjs", ".js", ".mjs"].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fullPath, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (sourceFile.parseDiagnostics.length > 0) return { error: "unable_to_parse_import_graph" };
  const bindings = constantStringBindings(sourceFile, ts);
  const requireBindings = createRequireBindings(sourceFile, bindings, ts);
  const edges = [];
  let unresolvedComputed = requireBindings.unprovedAlias;
  let error = null;
  const addSpecifier = (specifier, dynamic) => {
    scan.edgeCount += 1;
    if (scan.edgeCount > MAX_IMPORT_GRAPH_EDGES) {
      error = "import_graph_edge_limit_exceeded";
      return;
    }
    const target = resolveImportTarget(specifier, fullPath, scan, ts);
    if (target.error) {
      error = target.error;
      return;
    }
    if (target.external) return;
    edges.push({ dynamic, ...target });
  };
  const requireReceiverIsKnown = (name) => {
    if (requireBindings.safeAliases.has(name)) return true;
    if (requireBindings.unresolvedAliases.has(name)) return false;
    return name === "require" && !bindings.declarations.has(name);
  };
  const requireSpecifier = (call) => {
    if (call.arguments.length === 0) return null;
    const argument = call.arguments[0];
    const literal = stringLiteralValue(argument, ts);
    return literal ?? (ts.isIdentifier(argument) ? bindings.resolve(argument.text) : null);
  };
  const visit = (node) => {
    if (error) return;
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, false);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, false);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      addSpecifier(node.moduleReference.expression.text, false);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      const argument = node.arguments[0];
      let specifier = stringLiteralValue(argument, ts);
      if (specifier === null && ts.isIdentifier(argument)) specifier = bindings.resolve(argument.text);
      if (specifier === null) unresolvedComputed = true;
      else addSpecifier(specifier, true);
    } else if (ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) &&
          (node.expression.text === "createRequire" ||
            requireBindings.importedCreateRequire.has(node.expression.text))) ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire"))) {
      if (!requireBindings.safeInitializers.has(node)) unresolvedComputed = true;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || requireBindings.safeAliases.has(node.expression.text) ||
          requireBindings.unresolvedAliases.has(node.expression.text))) {
      if (!requireReceiverIsKnown(node.expression.text)) unresolvedComputed = true;
      else {
        const specifier = requireSpecifier(node);
        if (specifier === null) unresolvedComputed = true;
        else addSpecifier(specifier, true);
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "resolve" && ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === "require" ||
          requireBindings.safeAliases.has(node.expression.expression.text) ||
          requireBindings.unresolvedAliases.has(node.expression.expression.text))) {
      const receiver = node.expression.expression.text;
      if (!requireReceiverIsKnown(receiver)) unresolvedComputed = true;
      else {
        const specifier = requireSpecifier(node);
        if (specifier === null) unresolvedComputed = true;
        else addSpecifier(specifier, true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const node = error ? { error } : { edges, unresolvedComputed };
  scan.nodes.set(repoPath, node);
  return node;
}

function dynamicImportRisk(repoRoot, changedFiles) {
  const tracked = listTrackedFiles(repoRoot);
  if (!tracked) return { reason: "unable_to_inspect_import_graph", directTests: [] };
  const ts = loadTypeScriptParser();
  if (!ts) return { reason: "typescript_parser_unavailable", directTests: [] };
  const webRoot = path.join(repoRoot, "hushh-webapp");
  const configPath = path.join(webRoot, "tsconfig.json");
  let config;
  try {
    config = ts.readConfigFile(configPath, ts.sys.readFile);
  } catch {
    return { reason: "typescript_config_unavailable", directTests: [] };
  }
  if (config.error) return { reason: "typescript_config_unavailable", directTests: [] };
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, webRoot, { allowJs: true }, configPath);
  if (parsed.errors.length > 0) return { reason: "typescript_config_invalid", directTests: [] };
  const compilerOptions = { ...parsed.options, allowJs: true, resolveJsonModule: true };
  const trackedSet = new Set(tracked);
  const runtimeRoots = [];
  const unitRoots = [];
  for (const repoPath of tracked) {
    if (!SOURCE_EXTENSIONS.has(path.extname(repoPath)) ||
        repoPath.split("/").some((part) => [".git", ".next", "node_modules"].includes(part))) continue;
    const webPath = relativeWebPath(repoPath);
    if (webPath === null) continue;
    if (isRuntimeModule(webPath)) runtimeRoots.push(repoPath);
    else if (isVitestFile(webPath)) unitRoots.push(repoPath);
  }
  const changed = new Set(changedFiles.map((file) => path.normalize(file)));
  const scan = {
    repoRoot,
    tracked: trackedSet,
    changed,
    compilerOptions,
    resolutionCache: ts.createModuleResolutionCache(
      repoRoot,
      ts.sys.useCaseSensitiveFileNames ? (name) => name : (name) => name.toLowerCase(),
      compilerOptions,
    ),
    nodes: new Map(),
    bytesRead: 0,
    edgeCount: 0,
  };
  const graphQueue = [];
  const scheduled = new Set();
  const enqueue = (repoPath) => {
    if (scheduled.has(repoPath)) return true;
    if (scheduled.size >= MAX_IMPORT_GRAPH_STATES) return false;
    scheduled.add(repoPath);
    graphQueue.push(repoPath);
    return true;
  };
  for (const repoPath of [...runtimeRoots, ...unitRoots]) {
    if (!enqueue(repoPath)) {
      return { reason: "import_graph_state_limit_exceeded", directTests: [] };
    }
  }
  while (graphQueue.length > 0) {
    const repoPath = graphQueue.pop();
    const node = sourceImportGraphNode(repoPath, scan, ts);
    if (node.error) return { reason: node.error, directTests: [] };
    for (const edge of node.edges) {
      if (edge.source && !enqueue(edge.repoPath)) {
        return { reason: "import_graph_state_limit_exceeded", directTests: [] };
      }
    }
  }

  const reverseEdges = new Map();
  for (const [repoPath, node] of scan.nodes) {
    for (const edge of node.edges) {
      if (!edge.source) continue;
      const parents = reverseEdges.get(edge.repoPath) ?? [];
      parents.push(repoPath);
      reverseEdges.set(edge.repoPath, parents);
    }
  }

  const runtimeReachable = new Set();
  const runtimeQueue = [...runtimeRoots];
  while (runtimeQueue.length > 0) {
    const repoPath = runtimeQueue.pop();
    if (runtimeReachable.has(repoPath)) continue;
    runtimeReachable.add(repoPath);
    const node = scan.nodes.get(repoPath);
    if (node.unresolvedComputed) {
      return { reason: "computed_dynamic_import_dependency", directTests: [] };
    }
    for (const edge of node.edges) {
      if (edge.dynamic && edge.changed) {
        return { reason: "dynamic_import_dependency", directTests: [] };
      }
      if (edge.source) runtimeQueue.push(edge.repoPath);
    }
  }

  const unitRootSet = new Set(unitRoots);
  const triggers = new Set();
  for (const [repoPath, node] of scan.nodes) {
    if (runtimeReachable.has(repoPath)) continue;
    if (node.unresolvedComputed || node.edges.some((edge) => edge.dynamic && edge.changed)) {
      triggers.add(repoPath);
    }
  }
  const directTests = new Set();
  const ownerQueue = [...triggers];
  const ownerAncestors = new Set();
  while (ownerQueue.length > 0) {
    const repoPath = ownerQueue.pop();
    if (ownerAncestors.has(repoPath)) continue;
    ownerAncestors.add(repoPath);
    if (unitRootSet.has(repoPath)) directTests.add(relativeWebPath(repoPath));
    for (const parent of reverseEdges.get(repoPath) ?? []) ownerQueue.push(parent);
  }
  return { reason: null, directTests: [...directTests].sort() };
}

function sourceRisk(repoRoot, files, level) {
  for (const file of files) {
    if (isSharedDependency(file)) return { reason: "shared_dependency", directTests: [] };
    if (isVitestFile(file)) {
      const fullPath = path.join(repoRoot, "hushh-webapp", file);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return { reason: "missing_changed_test", directTests: [] };
      }
      continue;
    }
    if (isRegisteredContractInput(file)) {
      const fullPath = path.join(repoRoot, "hushh-webapp", file);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return { reason: "missing_changed_source", directTests: [] };
      }
      continue;
    }
    if (!isRuntimeModule(file)) return { reason: "unknown_changed_file_type", directTests: [] };
    const fullPath = path.join(repoRoot, "hushh-webapp", file);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return { reason: "missing_changed_source", directTests: [] };
    }
  }
  const sourceFiles = files.filter((file) =>
    isRuntimeModule(file) || isRegisteredContractInput(file));
  if (sourceFiles.length === 0) return { reason: null, directTests: [] };
  if (level === "focused" || level === "release") {
    return dynamicImportRisk(repoRoot, sourceFiles);
  }
  return { reason: null, directTests: [] };
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
    !file.endsWith(".md") && !file.endsWith(".css"));
  if (requestedLevel === "focused" && unitFiles.length === 0) {
    return { ...base, effectiveLevel: "focused", changedFiles: changed.files, noUnitImpact: true };
  }
  const risk = sourceRisk(repoRoot, unitFiles, requestedLevel);
  if (risk.reason) return { ...base, changedFiles: changed.files, fallbackReason: risk.reason };

  const directTests = [...new Set([
    ...unitFiles.filter(isVitestFile),
    ...risk.directTests,
  ])].sort();
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
