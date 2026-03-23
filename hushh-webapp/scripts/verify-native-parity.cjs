#!/usr/bin/env node
/*
 * verify-native-parity.cjs
 *
 * Fast parity check for:
 * - TS plugin registration names
 * - iOS + Android native plugin registration
 * - jsName/name alignment
 * - Key Next.js proxy routes existence (web parity)
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const webappRoot = path.resolve(repoRoot, "hushh-webapp");

function readText(relPath) {
  return fs.readFileSync(path.resolve(repoRoot, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.resolve(repoRoot, relPath));
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

const REQUIRED_PLUGINS = [
  // Core plugins
  "HushhAuth",
  "HushhVault",
  "HushhConsent",
  "Kai",
  "HushhSync",
  "HushhSettings",
  "HushhKeychain", // iOS keystore uses jsName HushhKeychain
  "PersonalKnowledgeModel",
  // Extra
  "HushhAccount",
  "HushhNotifications",
];

const REQUIRED_WEB_ROUTES = [
  "hushh-webapp/app/api/notifications/register/route.ts",
  "hushh-webapp/app/api/notifications/unregister/route.ts",
  "hushh-webapp/app/api/pkm/[...path]/route.ts",
  "hushh-webapp/app/api/kai/[...path]/route.ts",
  "hushh-webapp/app/api/consent/pending/route.ts",
  "hushh-webapp/app/api/consent/revoke/route.ts",
];

function checkWebRoutes() {
  for (const rel of REQUIRED_WEB_ROUTES) {
    if (!exists(rel)) fail(`Missing Next.js route file: ${rel}`);
  }
  ok("Required Next.js proxy routes exist");
}

function checkTsRegistrations() {
  const ts = readText("hushh-webapp/lib/capacitor/index.ts");
  // Kai is registered in lib/capacitor/kai.ts
  const kaiTs = readText("hushh-webapp/lib/capacitor/kai.ts");
  const pkmTs = readText("hushh-webapp/lib/capacitor/personal-knowledge-model.ts");
  const accountTs = readText("hushh-webapp/lib/capacitor/account.ts");

  const combined = `${ts}\n${kaiTs}\n${pkmTs}\n${accountTs}`;

  for (const name of REQUIRED_PLUGINS) {
    if (!combined.includes(`\"${name}\"`) && !combined.includes(`'${name}'`)) {
      fail(`TS does not reference plugin name "${name}" (registerPlugin/export missing?)`);
    }
  }
  ok("TS plugin registration names present");
}

function checkIosRegistration() {
  const vc = readText("hushh-webapp/ios/App/App/MyViewController.swift");
  for (const name of REQUIRED_PLUGINS) {
    // iOS registration uses class instances, but verify list uses plugin(withName:)
    if (!vc.includes(`\"${name}\"`)) {
      fail(`iOS MyViewController.swift does not verify plugin name: ${name}`);
    }
  }
  ok("iOS registration verification list contains all required plugin names");
}

function checkAndroidRegistrationAndNames() {
  const main = readText(
    "hushh-webapp/android/app/src/main/java/com/hushh/app/MainActivity.kt"
  );

  // Ensure each plugin is registered in MainActivity (best-effort string check)
  const expectedClassHints = [
    "HushhAuthPlugin",
    "HushhVaultPlugin",
    "HushhConsentPlugin",
    "KaiPlugin",
    "HushhSyncPlugin",
    "HushhSettingsPlugin",
    "HushhKeystorePlugin",
    "PersonalKnowledgeModelPlugin",
    "HushhAccountPlugin",
    "HushhNotificationsPlugin",
  ];

  for (const hint of expectedClassHints) {
    if (!main.includes(hint)) {
      fail(`Android MainActivity.kt missing plugin registration/import: ${hint}`);
    }
  }

  // Ensure @CapacitorPlugin name alignment for selected plugins
  const androidPluginFiles = [
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhNotifications/HushhNotificationsPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhAccount/HushhAccountPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/PersonalKnowledgeModel/PersonalKnowledgeModelPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/Kai/KaiPlugin.kt",
  ];

  for (const rel of androidPluginFiles) {
    if (!exists(rel)) {
      fail(`Missing Android plugin file: ${rel}`);
      continue;
    }
    const txt = readText(rel);
    const match = txt.match(/@CapacitorPlugin\(name\s*=\s*\"([^\"]+)\"\)/);
    if (!match) {
      fail(`Android plugin missing @CapacitorPlugin(name=...): ${rel}`);
      continue;
    }
    const name = match[1];
    if (!REQUIRED_PLUGINS.includes(name)) {
      fail(`Android plugin name not in required list: ${name} (${rel})`);
    }
  }

  ok("Android plugin registrations and @CapacitorPlugin names look consistent");
}

function assertMethodsPresent(label, files, methods) {
  const fileContents = files.map((rel) => {
    if (!exists(rel)) {
      fail(`${label}: missing file ${rel}`);
      return "";
    }
    return readText(rel);
  });

  for (const method of methods) {
    for (let i = 0; i < files.length; i += 1) {
      const rel = files[i];
      const src = fileContents[i];
      if (!src.includes(method)) {
        fail(`${label}: missing method "${method}" in ${rel}`);
      }
    }
  }

  ok(`${label}: required methods present across TS/iOS/Android`);
}

function assertPathsPresent(label, files, pathFragments) {
  for (const rel of files) {
    if (!exists(rel)) {
      fail(`${label}: missing file ${rel}`);
      continue;
    }
    const src = readText(rel);
    for (const fragment of pathFragments) {
      if (!src.includes(fragment)) {
        fail(`${label}: missing endpoint fragment "${fragment}" in ${rel}`);
      }
    }
  }
  ok(`${label}: endpoint fragments present`);
}

function checkBackendResolverUsage() {
  const iosNetworkPlugins = [
    "hushh-webapp/ios/App/App/Plugins/HushhVaultPlugin.swift",
    "hushh-webapp/ios/App/App/Plugins/HushhConsentPlugin.swift",
    "hushh-webapp/ios/App/App/Plugins/KaiPlugin.swift",
    "hushh-webapp/ios/App/App/Plugins/PersonalKnowledgeModelPlugin.swift",
    "hushh-webapp/ios/App/App/Plugins/HushhNotificationsPlugin.swift",
    "hushh-webapp/ios/App/App/Plugins/HushhAccountPlugin.swift",
  ];

  for (const rel of iosNetworkPlugins) {
    if (!exists(rel)) {
      fail(`iOS resolver usage: missing file ${rel}`);
      continue;
    }
    const src = readText(rel);
    if (!src.includes("HushhProxyClient.resolveBackendUrl")) {
      fail(
        `iOS resolver usage: ${rel} must resolve backend via HushhProxyClient.resolveBackendUrl`
      );
    }
  }
  ok("iOS network plugins resolve backend URL via HushhProxyClient");

  const androidNetworkPlugins = [
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhVault/HushhVaultPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhConsent/HushhConsentPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/Kai/KaiPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/PersonalKnowledgeModel/PersonalKnowledgeModelPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhNotifications/HushhNotificationsPlugin.kt",
    "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhAccount/HushhAccountPlugin.kt",
  ];

  for (const rel of androidNetworkPlugins) {
    if (!exists(rel)) {
      fail(`Android resolver usage: missing file ${rel}`);
      continue;
    }
    const src = readText(rel);
    if (!src.includes("BackendUrl.resolve(")) {
      fail(
        `Android resolver usage: ${rel} must resolve backend via BackendUrl.resolve(...)`
      );
    }
  }
  ok("Android network plugins resolve backend URL via BackendUrl.resolve");
}

function checkFirebaseAnalyticsNativeParity() {
  const packageJson = readText("hushh-webapp/package.json");
  if (!packageJson.includes("\"@capacitor-firebase/analytics\"")) {
    fail("package.json missing @capacitor-firebase/analytics dependency");
  }

  const iosSpm = readText("hushh-webapp/ios/App/CapApp-SPM/Package.swift");
  if (!iosSpm.includes("CapacitorFirebaseAnalytics")) {
    fail("iOS Package.swift missing CapacitorFirebaseAnalytics package/product linkage");
  }

  const androidSettings = readText("hushh-webapp/android/capacitor.settings.gradle");
  if (!androidSettings.includes(":capacitor-firebase-analytics")) {
    fail("android/capacitor.settings.gradle missing capacitor-firebase-analytics include");
  }

  const androidPlugins = readText("hushh-webapp/android/app/src/main/assets/capacitor.plugins.json");
  if (!androidPlugins.includes("@capacitor-firebase/analytics")) {
    fail("android capacitor.plugins.json missing @capacitor-firebase/analytics registration");
  }

  ok("Firebase Analytics plugin is present in native iOS/Android Capacitor manifests");
}

function checkMethodLevelParity() {
  assertMethodsPresent(
    "HushhVault multi-wrapper parity",
    [
      "hushh-webapp/lib/capacitor/index.ts",
      "hushh-webapp/ios/App/App/Plugins/HushhVaultPlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhVault/HushhVaultPlugin.kt",
    ],
    ["getVault", "setupVault", "upsertVaultWrapper", "setPrimaryVaultMethod"]
  );

  assertMethodsPresent(
    "HushhKeychain biometric parity",
    [
      "hushh-webapp/lib/capacitor/index.ts",
      "hushh-webapp/ios/App/App/Plugins/HushhKeystorePlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhKeystore/HushhKeystorePlugin.kt",
    ],
    ["isBiometricAvailable", "setBiometric", "getBiometric"]
  );

  assertMethodsPresent(
    "Kai streaming parity",
    [
      "hushh-webapp/lib/capacitor/kai.ts",
      "hushh-webapp/ios/App/App/Plugins/KaiPlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/Kai/KaiPlugin.kt",
    ],
    ["streamPortfolioImport", "streamPortfolioAnalyzeLosers", "streamKaiAnalysis"]
  );

  assertMethodsPresent(
    "PersonalKnowledgeModel critical parity",
    [
      "hushh-webapp/lib/capacitor/personal-knowledge-model.ts",
      "hushh-webapp/ios/App/App/Plugins/PersonalKnowledgeModelPlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/PersonalKnowledgeModel/PersonalKnowledgeModelPlugin.kt",
    ],
    ["getMetadata", "getEncryptedData", "storeDomainData", "getDomainData", "clearDomain"]
  );

  assertPathsPresent(
    "HushhVault endpoint parity",
    [
      "hushh-webapp/ios/App/App/Plugins/HushhVaultPlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/HushhVault/HushhVaultPlugin.kt",
    ],
    ["/db/vault/check", "/db/vault/get", "/db/vault/setup", "/db/vault/wrapper/upsert", "/db/vault/primary/set"]
  );

  assertPathsPresent(
    "Kai endpoint parity",
    [
      "hushh-webapp/ios/App/App/Plugins/KaiPlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/Kai/KaiPlugin.kt",
    ],
    ["/api/kai/analyze", "/api/kai/analyze/stream", "/api/kai/portfolio/import", "/api/kai/portfolio/import/stream"]
  );

  assertPathsPresent(
    "PersonalKnowledgeModel endpoint parity",
    [
      "hushh-webapp/ios/App/App/Plugins/PersonalKnowledgeModelPlugin.swift",
      "hushh-webapp/android/app/src/main/java/com/hushh/app/plugins/PersonalKnowledgeModel/PersonalKnowledgeModelPlugin.kt",
    ],
    ["/api/pkm/metadata/", "/api/pkm/store-domain", "/api/pkm/domain-data/"]
  );
}

function main() {
  checkWebRoutes();
  checkTsRegistrations();
  checkIosRegistration();
  checkAndroidRegistrationAndNames();
  checkFirebaseAnalyticsNativeParity();
  checkBackendResolverUsage();
  checkMethodLevelParity();

  if (process.exitCode) {
    console.error("\nParity check FAILED");
    process.exit(1);
  }
  console.log("\nParity check PASSED");
}

main();
