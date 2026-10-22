#!/usr/bin/env node
/** Emit public sandbox artifacts only. Never build, register, deploy, or edit env. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactSandboxFrontendOrigin } from "../../lib/capacitor/scope-commerce-sandbox-links.mjs";
export { exactSandboxFrontendOrigin } from "../../lib/capacitor/scope-commerce-sandbox-links.mjs";
import {
  COMMERCE_ACCOUNT_PATH, SANDBOX_ANDROID_APP_ID, SANDBOX_IOS_APP_ID,
  sandboxAndroidManifest, sandboxAssociationDocuments, sandboxGradleInit, sandboxReadinessGuide,
} from "./scope-commerce-sandbox-artifacts.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function publicAppleTeam(project) {
  const teams = new Set([...project.matchAll(/\bDEVELOPMENT_TEAM\s*=\s*([A-Z0-9]{10})\s*;/g)].map(match => match[1]));
  if (teams.size !== 1) throw new Error("A single configured public Apple development team is required.");
  return [...teams][0];
}

function explicitFingerprints(values) {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string" || !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(value))) {
    throw new Error("Explicit SHA-256 Android signing certificate fingerprints are required.");
  }
  return [...new Set(values.map(value => value.toUpperCase()))];
}

function publicBuildPlan(origin, output, teamId) {
  return {
    version: 1, frontendOrigin: origin, iosApplicationId: SANDBOX_IOS_APP_ID, androidApplicationId: SANDBOX_ANDROID_APP_ID,
    environment: { NEXT_PUBLIC_APP_URL: origin, NEXT_PUBLIC_SCOPE_COMMERCE_SANDBOX_ORIGIN: origin,
      NEXT_PUBLIC_IOS_BUNDLE_ID: SANDBOX_IOS_APP_ID, NEXT_PUBLIC_ANDROID_APP_ID: SANDBOX_ANDROID_APP_ID },
    requiredReadiness: ["SANDBOX_FIREBASE_REGISTRATIONS", "SANDBOX_IOS_PROVISIONING", "SANDBOX_OAUTH_CLIENTS", "ANDROID_CERTIFICATE_MATCH", "BUNDLED_RUNTIME_IDENTITY", "OS_LINK_VERIFICATION", "PHYSICAL_REVIEWER_ADMISSION"],
    iosDebugTargetSettings: {
      App: { PRODUCT_BUNDLE_IDENTIFIER: SANDBOX_IOS_APP_ID, DEVELOPMENT_TEAM: teamId, CODE_SIGN_ENTITLEMENTS: path.join(output, "ios/ScopeCommerceSandbox.entitlements") },
      AppTests: { PRODUCT_BUNDLE_IDENTIFIER: `${SANDBOX_IOS_APP_ID}.tests` },
      AppUITests: { PRODUCT_BUNDLE_IDENTIFIER: `${SANDBOX_IOS_APP_ID}.uitests` },
    },
    commandsAfterReadiness: {
      webBuild: ["npm", "run", "cap:build"],
      nativeSync: ["node", "./scripts/native/with-ios-native-env.mjs", "npx", "cap", "sync"],
      iosBuild: ["xcodebuild", "-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Debug", "build"],
      androidBuild: ["./android/gradlew", "-p", "android", "--init-script", path.join(output, "android/sandbox.init.gradle"), ":app:assembleDebug", "--no-daemon"],
    },
    instructions: "Read README.md and satisfy registration/signing prerequisites in a disposable sandbox checkout before any build. No command is executed by generation.",
  };
}

export function buildScopeCommerceSandboxArtifacts({ frontendOrigin, androidFingerprints, outputDir, sourceRoot = appRoot }) {
  const origin = exactSandboxFrontendOrigin(frontendOrigin);
  const host = new URL(origin).hostname;
  const fingerprints = explicitFingerprints(androidFingerprints);
  const teamId = publicAppleTeam(fs.readFileSync(path.join(sourceRoot, "ios/App/App.xcodeproj/project.pbxproj"), "utf8"));
  const routes = fs.readFileSync(path.join(sourceRoot, "lib/navigation/routes.ts"), "utf8");
  const inventory = JSON.parse(fs.readFileSync(path.join(sourceRoot, "native-route-inventory.json"), "utf8"));
  if (!routes.includes(`PROFILE_ACCOUNT: "${COMMERCE_ACCOUNT_PATH}"`) ||
      !inventory.routes.some(row => row.route === COMMERCE_ACCOUNT_PATH && row.classification.startsWith("native-required"))) {
    throw new Error("The commerce account route must remain owned by the canonical native route contract.");
  }
  const output = path.resolve(outputDir);
  if (/[\r\n\x00"\\$]/.test(output)) throw new Error("The artifact output path cannot contain build-setting syntax.");
  const documents = sandboxAssociationDocuments({ host, teamId, fingerprints });
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  return {
    ".well-known/apple-app-site-association": json(documents.aasa),
    ".well-known/assetlinks.json": json(documents.assetlinks),
    "ios/ScopeCommerceSandbox.entitlements": documents.entitlements,
    "ios/ScopeCommerceSandbox.xcconfig": `// Reference for App Debug target settings only. Never pass via xcodebuild -xcconfig.\nPRODUCT_BUNDLE_IDENTIFIER = ${SANDBOX_IOS_APP_ID}\nDEVELOPMENT_TEAM = ${teamId}\nCODE_SIGN_ENTITLEMENTS = ${path.join(output, "ios/ScopeCommerceSandbox.entitlements")}\n`,
    "android/AndroidManifest.xml": sandboxAndroidManifest(fs.readFileSync(path.join(sourceRoot, "android/app/src/main/AndroidManifest.xml"), "utf8"), host),
    "android/sandbox.init.gradle": sandboxGradleInit(path.join(output, "android/AndroidManifest.xml")),
    "build-plan.json": json(publicBuildPlan(origin, output, teamId)),
    "README.md": sandboxReadinessGuide({ frontendOrigin: origin, teamId }),
  };
}

export function writeScopeCommerceSandboxArtifacts(options) {
  const output = path.resolve(options.outputDir);
  // Follow existing ancestor symlinks before checking the write boundary.
  let ancestor = path.dirname(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualOutput = path.join(fs.realpathSync(ancestor), path.relative(ancestor, output));
  const relative = path.relative(path.dirname(appRoot), actualOutput);
  if (!relative.startsWith("../") && relative !== ".." && !relative.startsWith(`tmp${path.sep}`)) {
    throw new Error("Repository artifacts must be written under ignored tmp, never production or generated sources.");
  }
  if (fs.existsSync(output)) throw new Error("Use a fresh caller-owned output directory; existing artifacts will not be overwritten.");
  const files = buildScopeCommerceSandboxArtifacts(options);
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(output, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, { flag: "wx", mode: 0o644 });
  }
  return { filesWritten: Object.keys(files).length, readinessVerified: false };
}

function main(args) {
  const options = {};
  const keys = new Map([["--frontend-origin", "frontendOrigin"], ["--android-cert-sha256", "androidFingerprints"], ["--output-dir", "outputDir"]]);
  for (let index = 0; index < args.length; index += 2) {
    const key = keys.get(args[index]);
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Usage: --frontend-origin HTTPS_ORIGIN --android-cert-sha256 SHA256[:...] --output-dir FRESH_DIRECTORY");
    options[key] = key === "androidFingerprints" ? args[index + 1].split(",") : args[index + 1];
  }
  if (!options.outputDir) throw new Error("A fresh caller-owned output directory is required.");
  const result = writeScopeCommerceSandboxArtifacts(options);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof Error ? error.message : "Sandbox artifact preparation failed.");
    process.exitCode = 1;
  }
}
