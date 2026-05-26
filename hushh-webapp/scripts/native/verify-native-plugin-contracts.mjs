#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const appRoot = process.cwd();

const tsPluginFiles = [
  "lib/capacitor/index.ts",
  "lib/capacitor/account.ts",
  "lib/capacitor/kai.ts",
  "lib/capacitor/personal-knowledge-model.ts",
];

const iosPluginsDir = path.join(appRoot, "ios/App/App/Plugins");
const androidPluginsDir = path.join(appRoot, "android/app/src/main/java/com/hushh/app/plugins");
const iosControllerPath = path.join(appRoot, "ios/App/App/MyViewController.swift");
const androidActivityPath = path.join(appRoot, "android/app/src/main/java/com/hushh/app/MainActivity.kt");

const webOnlyPlugins = new Set(["HushhDatabase", "HushhAgent"]);
const ignoredTsMethodsByPlugin = new Map([
  ["Kai", new Set(["addListener"])],
]);

const failures = [];

function fail(message) {
  failures.push(message);
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walkFiles(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, out);
    } else if (predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

function matchingBraceIndex(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractInterfaceMethods(source, interfaceName) {
  const marker = new RegExp(`export\\s+interface\\s+${interfaceName}\\b`);
  const match = marker.exec(source);
  if (!match) return null;
  const openIndex = source.indexOf("{", match.index);
  if (openIndex < 0) return null;
  const closeIndex = matchingBraceIndex(source, openIndex);
  if (closeIndex < 0) return null;
  const body = source.slice(openIndex + 1, closeIndex);
  return new Set(
    [...body.matchAll(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)].map(
      (methodMatch) => methodMatch[1]
    )
  );
}

function parseTsContracts() {
  const byPlugin = new Map();
  for (const relativePath of tsPluginFiles) {
    const filePath = path.join(appRoot, relativePath);
    const source = read(filePath);
    const registerRegex =
      /registerPlugin<([A-Za-z_$][A-Za-z0-9_$]*)>\s*\(\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(registerRegex)) {
      const [, interfaceName, jsName] = match;
      const methods = extractInterfaceMethods(source, interfaceName);
      if (!methods) {
        fail(`${relativePath}: could not find interface ${interfaceName} for ${jsName}.`);
        continue;
      }
      byPlugin.set(jsName, {
        interfaceName,
        jsName,
        methods,
        source: relativePath,
      });
    }
  }
  return byPlugin;
}

function parseIosContracts() {
  const byPlugin = new Map();
  for (const filePath of walkFiles(iosPluginsDir, (candidate) => candidate.endsWith("Plugin.swift"))) {
    const source = read(filePath);
    const jsName = source.match(/\bjsName\s*=\s*"([^"]+)"/)?.[1];
    if (!jsName) continue;
    const methods = new Set(
      [...source.matchAll(/CAPPluginMethod\(name:\s*"([^"]+)"/g)].map((match) => match[1])
    );
    byPlugin.set(jsName, {
      jsName,
      className: path.basename(filePath, ".swift"),
      methods,
      source: path.relative(appRoot, filePath),
    });
  }
  return byPlugin;
}

function parseAndroidContracts() {
  const byPlugin = new Map();
  for (const filePath of walkFiles(androidPluginsDir, (candidate) => candidate.endsWith("Plugin.kt"))) {
    const source = read(filePath);
    const jsName = source.match(/@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/)?.[1];
    if (!jsName) continue;
    const methods = [];
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes("@PluginMethod")) continue;
      for (let probe = index + 1; probe < Math.min(index + 10, lines.length); probe += 1) {
        const methodMatch = lines[probe].match(/\bfun\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
        if (methodMatch) {
          methods.push(methodMatch[1]);
          break;
        }
      }
    }
    byPlugin.set(jsName, {
      jsName,
      className: path.basename(filePath, ".kt"),
      methods: new Set(methods),
      source: path.relative(appRoot, filePath),
    });
  }
  return byPlugin;
}

function parseIosRegistrations() {
  const source = read(iosControllerPath);
  return new Set(
    [...source.matchAll(/registerPluginInstance\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map(
      (match) => match[1]
    )
  );
}

function parseAndroidRegistrations() {
  const source = read(androidActivityPath);
  return new Set(
    [...source.matchAll(/registerPlugin\(\s*([A-Za-z_$][A-Za-z0-9_$]*)::class\.java\s*\)/g)].map(
      (match) => match[1]
    )
  );
}

function sorted(setLike) {
  return [...setLike].sort((left, right) => left.localeCompare(right));
}

function diff(left, right) {
  return sorted(left).filter((item) => !right.has(item));
}

function compareMethods(pluginName, tsMethods, nativeMethods, platform) {
  const ignored = ignoredTsMethodsByPlugin.get(pluginName) || new Set();
  const expected = new Set([...tsMethods].filter((method) => !ignored.has(method)));
  const missing = diff(expected, nativeMethods);
  const extra = diff(nativeMethods, expected);
  if (missing.length > 0) {
    fail(`${platform} ${pluginName}: missing method(s): ${missing.join(", ")}.`);
  }
  if (extra.length > 0) {
    fail(`${platform} ${pluginName}: extra native method(s) not declared in TypeScript: ${extra.join(", ")}.`);
  }
}

const tsContracts = parseTsContracts();
const iosContracts = parseIosContracts();
const androidContracts = parseAndroidContracts();
const iosRegistrations = parseIosRegistrations();
const androidRegistrations = parseAndroidRegistrations();

for (const pluginName of sorted(tsContracts.keys())) {
  if (webOnlyPlugins.has(pluginName)) continue;
  const tsContract = tsContracts.get(pluginName);
  const iosContract = iosContracts.get(pluginName);
  const androidContract = androidContracts.get(pluginName);

  if (!iosContract) {
    fail(`${pluginName}: TypeScript contract exists in ${tsContract.source}, but iOS plugin is missing.`);
  }
  if (!androidContract) {
    fail(`${pluginName}: TypeScript contract exists in ${tsContract.source}, but Android plugin is missing.`);
  }
  if (iosContract) {
    compareMethods(pluginName, tsContract.methods, iosContract.methods, "iOS");
    if (!iosRegistrations.has(iosContract.className)) {
      fail(`iOS ${pluginName}: ${iosContract.className} is not registered in MyViewController.swift.`);
    }
  }
  if (androidContract) {
    compareMethods(pluginName, tsContract.methods, androidContract.methods, "Android");
    if (!androidRegistrations.has(androidContract.className)) {
      fail(`Android ${pluginName}: ${androidContract.className} is not registered in MainActivity.kt.`);
    }
  }
}

for (const pluginName of sorted(iosContracts.keys())) {
  if (!tsContracts.has(pluginName)) {
    fail(`iOS ${pluginName}: native plugin has no TypeScript registerPlugin contract.`);
  }
}

for (const pluginName of sorted(androidContracts.keys())) {
  if (!tsContracts.has(pluginName)) {
    fail(`Android ${pluginName}: native plugin has no TypeScript registerPlugin contract.`);
  }
}

for (const pluginName of sorted(tsContracts.keys())) {
  if (webOnlyPlugins.has(pluginName)) continue;
  if (!iosContracts.has(pluginName) || !androidContracts.has(pluginName)) continue;
  const iosMethods = iosContracts.get(pluginName).methods;
  const androidMethods = androidContracts.get(pluginName).methods;
  const iosOnly = diff(iosMethods, androidMethods);
  const androidOnly = diff(androidMethods, iosMethods);
  if (iosOnly.length > 0 || androidOnly.length > 0) {
    fail(
      `${pluginName}: iOS/Android method drift. iOS-only=[${iosOnly.join(", ")}], Android-only=[${androidOnly.join(", ")}].`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`native-plugin-contracts: ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Native plugin contract parity passed (${tsContracts.size - webOnlyPlugins.size} native plugins, ${webOnlyPlugins.size} web-only plugins classified).`
);
