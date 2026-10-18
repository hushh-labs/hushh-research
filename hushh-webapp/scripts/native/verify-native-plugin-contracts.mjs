#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const appRoot = process.cwd();

const tsPluginFiles = [
  "lib/capacitor/index.ts",
  "lib/capacitor/invitations.ts",
  "lib/capacitor/account.ts",
  "lib/capacitor/kai.ts",
  "lib/capacitor/personal-knowledge-model.ts",
  "lib/capacitor/one-voice-invocation.ts",
  "lib/capacitor/session-privacy.ts",
  "lib/capacitor/native-navigation.ts",
  "lib/capacitor/native-chrome.ts",
  "lib/capacitor/native-dock.ts",
  "lib/capacitor/native-drawers.ts",
  "lib/capacitor/stream.ts",
  "lib/capacitor/oauth-return.ts",
  "lib/capacitor/plaid-link.ts",
  "lib/capacitor/card-scanner.ts",
];

const iosPluginsDir = path.join(appRoot, "ios/App/App/Plugins");
const androidPluginsDir = path.join(appRoot, "android/app/src/main/java/com/hussh/app/plugins");
const iosControllerPath = path.join(appRoot, "ios/App/App/MyViewController.swift");
const androidActivityPath = path.join(appRoot, "android/app/src/main/java/com/hussh/app/MainActivity.kt");
const iosInfoPlistPath = path.join(appRoot, "ios/App/App/Info.plist");
const iosEntitlementsPath = path.join(appRoot, "ios/App/App/App.entitlements");
const iosReleaseEntitlementsPath = path.join(appRoot, "ios/App/App/AppRelease.entitlements");
const iosChatNotificationServiceEntitlementsPath = path.join(
  appRoot,
  "ios/App/ChatNotificationService/ChatNotificationService.entitlements",
);
const iosProjectPath = path.join(appRoot, "ios/App/App.xcodeproj/project.pbxproj");
const iosVoicePluginPath = path.join(
  appRoot,
  "ios/App/App/Plugins/HushhVoiceInvocationPlugin.swift",
);
const iosMicrophoneCapturePath = path.join(
  appRoot,
  "ios/App/App/Plugins/OneVoiceMicrophoneCapture.swift",
);

const webOnlyPlugins = new Set(["HushhDatabase", "HushhAgent"]);
// App Shortcuts are an Apple system surface, not an Android route-parity lane.
// The TypeScript adapter returns unsupported/no pending invocation elsewhere.
// (HushhPlaidLink is implemented on both platforms: LinkKit on iOS, Plaid's
// Link SDK on Android, so it is held to full parity like every other plugin.)
// Card scanning uses Apple Vision on iOS and the existing web worker elsewhere.
const androidOnlyPlugins = new Set(["HushhCardCapture"]);
const iosOnlyPlugins = new Set(["HushhNativeNavigation", "HushhNativeChrome", "HushhNativeDock", "HushhNativeDrawers", "HushhCardScanner"]);
const appleInvocationMethods = new Set([
  "getPendingInvocation", "claimInvocation", "reportInvocationProgress", "completeInvocation",
  "getPendingActionInvocation", "claimActionInvocation", "completeActionInvocation", "reportActionInvocationProgress",
  "updateActionEntityIndex", "clearActionState", "getPendingRequestInvocation", "claimRequestInvocation",
  "completeRequestInvocation", "reportRequestInvocationProgress", "cancelRequestInvocation",
  "addListener",
]);
const ignoredTsMethodsByPlugin = new Map([
  // Listener registration is inherited from CAPPlugin / Plugin, not a custom
  // @objc or @PluginMethod operation on these streaming/event plugins.
  ["Kai", new Set(["addListener"])],
  ["HushhVoiceInvocation", new Set(["addListener"])],
  ["HushhSessionPrivacy", new Set(["addListener"])],
  ["HushhNativeNavigation", new Set(["addListener"])],
  ["HushhNativeChrome", new Set(["addListener"])],
  ["HushhNativeDock", new Set(["addListener"])],
  ["HushhNativeDrawers", new Set(["addListener"])],
  ["HushhStream", new Set(["addListener"])],
  ["HushhPlaidLink", new Set(["addListener"])],
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

function extractInterfaceMethods(checker, sourceFile, interfaceName) {
  const declaration = sourceFile.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName,
  );
  if (!declaration) return null;
  const contract = checker.getTypeAtLocation(declaration);
  const methods = new Set();
  // Resolve inherited Partial ports and indexed callable properties as well as
  // method syntax. Regex over the local body silently drops those contracts.
  for (const property of checker.getPropertiesOfType(contract)) {
    const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, declaration));
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      fail(`${interfaceName}.${property.name}: unresolved TypeScript contract.`);
      continue;
    }
    if (type.getCallSignatures().length > 0) methods.add(property.name);
  }
  return methods;
}

function parseTsContracts() {
  const configPath = path.join(appRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  // This check has explicit roots below. Resolve compiler options without
  // walking every app/component glob just to discard that file list.
  const parsed = ts.parseJsonConfigFileContent({ ...config.config, files: tsPluginFiles, include: [] }, ts.sys, appRoot);
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  const program = ts.createProgram(tsPluginFiles.map((file) => path.join(appRoot, file)), {
    // Follow the contracts' actual imports and configured standard libraries,
    // not every unrelated ambient @types package installed by the web app.
    ...parsed.options, types: [], noEmit: true, incremental: false,
  });
  const checker = program.getTypeChecker();
  const byPlugin = new Map();
  for (const relativePath of tsPluginFiles) {
    const filePath = path.join(appRoot, relativePath);
    const source = read(filePath);
    const registerRegex =
      /registerPlugin<([A-Za-z_$][A-Za-z0-9_$]*)>\s*\(\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(registerRegex)) {
      const [, interfaceName, jsName] = match;
      const sourceFile = program.getSourceFile(filePath);
      const methods = sourceFile && extractInterfaceMethods(checker, sourceFile, interfaceName);
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

function verifyIosVaultAuthenticationConfiguration(iosContracts) {
  const keychain = iosContracts.get("HushhKeychain");
  const vault = iosContracts.get("HushhVault");
  if (!keychain || !vault) return;

  const infoPlist = read(iosInfoPlistPath);
  const entitlements = read(iosEntitlementsPath);

  if (!/<key>NSFaceIDUsageDescription<\/key>\s*<string>[^<]+<\/string>/.test(infoPlist)) {
    fail("iOS vault biometric unlock requires a non-empty NSFaceIDUsageDescription in Info.plist.");
  }

  if (!entitlements.includes("webcredentials:one.hushh.ai")) {
    fail("iOS native passkey unlock requires the canonical webcredentials:one.hushh.ai association.");
  }
}

function verifyIosCommunicationNotificationEntitlements() {
  const communicationNotificationsEntitlement =
    /<key>com\.apple\.developer\.usernotifications\.communication<\/key>\s*<true\s*\/>/;
  const chatNotificationServiceKeychainGroup =
    "$(AppIdentifierPrefix)com.hussh.app.chatnotifications";
  const parentEntitlements = [
    ["App.entitlements", read(iosEntitlementsPath)],
    ["AppRelease.entitlements", read(iosReleaseEntitlementsPath)],
  ];

  for (const [name, entitlements] of parentEntitlements) {
    if (!communicationNotificationsEntitlement.test(entitlements)) {
      fail(`${name} must enable the Communication Notifications entitlement for the parent app target.`);
    }
    if (!entitlements.includes(chatNotificationServiceKeychainGroup)) {
      fail(`${name} must retain the ChatNotificationService keychain access group.`);
    }
  }

  const serviceEntitlements = read(iosChatNotificationServiceEntitlementsPath);
  if (serviceEntitlements.includes("com.apple.developer.usernotifications.communication")) {
    fail("ChatNotificationService must not request the parent-only Communication Notifications entitlement.");
  }
  if (!serviceEntitlements.includes(chatNotificationServiceKeychainGroup)) {
    fail("ChatNotificationService must retain its shared keychain access group.");
  }

  const project = read(iosProjectPath);
  const serviceEntitlementsWiring =
    project.match(/CODE_SIGN_ENTITLEMENTS\s*=\s*ChatNotificationService\/ChatNotificationService\.entitlements;/g) || [];
  if (serviceEntitlementsWiring.length < 2) {
    fail("ChatNotificationService must use its dedicated entitlements file for Debug and Release signing.");
  }
}

function verifyIosCommandCaptureContract(iosContracts) {
  if (!iosContracts.has("HushhVoiceInvocation")) return;

  const source = read(iosVoicePluginPath);
  for (const fragment of ["startCommandCapture", "finishCommandCapture", "cancelCommandCapture", "OneCommandRecording", "UIApplication.shared.applicationState == .active"]) {
    if (!source.includes(fragment)) fail(`iOS command capture is missing ${fragment}.`);
  }
  if (/FluidAudio|SFSpeechRecognizer|startSpeechRecognition|startRealtimeAudioCapture/.test(source)) {
    fail("The command plugin must not expose a retired speech or realtime surface.");
  }

  const microphoneCapture = read(iosMicrophoneCapturePath);
  for (const fragment of [
    "private static var activeOwner",
    "claimGlobalOwnership()",
    "releaseGlobalOwnership()",
    "throw CaptureError.alreadyRunning",
    "onFirstPCMWrite",
    "firstPCMWrite?(sequence)",
    "wav.append(contentsOf: \"RIFF\".utf8)",
  ]) {
    if (!microphoneCapture.includes(fragment)) {
      fail(`iOS microphone capture is missing singular-owner protection: ${fragment}.`);
    }
  }
}

const tsContracts = parseTsContracts();
const iosContracts = parseIosContracts();
const androidContracts = parseAndroidContracts();
const iosRegistrations = parseIosRegistrations();
const androidRegistrations = parseAndroidRegistrations();

verifyIosVaultAuthenticationConfiguration(iosContracts);
verifyIosCommunicationNotificationEntitlements();
verifyIosCommandCaptureContract(iosContracts);

for (const pluginName of sorted(tsContracts.keys())) {
  if (webOnlyPlugins.has(pluginName)) continue;
  const tsContract = tsContracts.get(pluginName);
  const iosContract = iosContracts.get(pluginName);
  const androidContract = androidContracts.get(pluginName);

  if (!iosContract && !androidOnlyPlugins.has(pluginName)) {
    fail(`${pluginName}: TypeScript contract exists in ${tsContract.source}, but iOS plugin is missing.`);
  }
  if (!androidContract && !iosOnlyPlugins.has(pluginName)) {
    fail(`${pluginName}: TypeScript contract exists in ${tsContract.source}, but Android plugin is missing.`);
  }
  if (iosContract) {
    compareMethods(pluginName, tsContract.methods, iosContract.methods, "iOS");
    if (!iosRegistrations.has(iosContract.className)) {
      fail(`iOS ${pluginName}: ${iosContract.className} is not registered in MyViewController.swift.`);
    }
  }
  if (androidContract) {
    const androidMethods = pluginName === "HushhVoiceInvocation"
      ? new Set([...tsContract.methods].filter((method) => !appleInvocationMethods.has(method)))
      : tsContract.methods;
    compareMethods(pluginName, androidMethods, androidContract.methods, "Android");
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
  if (webOnlyPlugins.has(pluginName) || iosOnlyPlugins.has(pluginName) || androidOnlyPlugins.has(pluginName)) continue;
  if (!iosContracts.has(pluginName) || !androidContracts.has(pluginName)) continue;
  const iosMethods = new Set([...iosContracts.get(pluginName).methods].filter((method) =>
    pluginName !== "HushhVoiceInvocation" || !appleInvocationMethods.has(method)));
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
