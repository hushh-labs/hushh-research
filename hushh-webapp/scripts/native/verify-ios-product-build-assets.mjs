#!/usr/bin/env node

/**
 * Verify that the native product contains the declarations and generated
 * assets required by the private agent voice entrypoint.
 *
 * This is deliberately an asset/build check, not a second authority check.
 * Agent One's generated gateway, consent policy, directive ledger, and
 * verified settlement remain the only action authority and are verified by the
 * existing voice/plugin contracts before this script runs.
 *
 * Usage:
 *   node scripts/native/verify-ios-product-build-assets.mjs
 *   IOS_APP_BUNDLE_PATH=/path/to/App.app node scripts/native/verify-ios-product-build-assets.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceInfoPlistPath = path.join(appRoot, "ios/App/App/Info.plist");
const sourcePrivacyManifestPath = path.join(appRoot, "ios/App/App/PrivacyInfo.xcprivacy");
const sourceModelNoticesPath = path.join(appRoot, "ios/App/App/OneVoiceModelNotices.json");
const sourceVoicePrivacyContractPath = path.join(
  appRoot,
  "ios/App/App/OneVoicePrivacyContract.v1.json",
);
const sourceWebManifestPath = path.join(appRoot, "public/manifest.webmanifest");
const stagedWebManifestPath = path.join(appRoot, "ios/App/App/public/manifest.webmanifest");
const xcodeProjectPath = path.join(appRoot, "ios/App/App.xcodeproj/project.pbxproj");
const requiredIosUsageDescriptionKeys = [
  "NSMicrophoneUsageDescription",
  "NSSpeechRecognitionUsageDescription",
  "NSFaceIDUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSContactsUsageDescription",
  "NSPhotoLibraryUsageDescription",
  "NSCameraUsageDescription",
];

function fail(message) {
  console.error(`ios-product-build-assets: ${message}`);
  process.exitCode = 1;
}

function read(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`missing or unreadable file: ${path.relative(appRoot, filePath)} (${error.message})`);
    return "";
  }
}

function readPlistXml(filePath) {
  try {
    return execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", filePath], {
      encoding: "utf8",
    });
  } catch {
    // Source plists are tracked as XML. The fallback keeps source-only checks
    // runnable on non-macOS hosts; built iOS bundles are verified on macOS.
    return read(filePath);
  }
}

function requireFile(filePath, label = path.relative(appRoot, filePath)) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`required ${label} is not present.`);
    return false;
  }
  return true;
}

function requireDirectory(directoryPath, label = path.relative(appRoot, directoryPath)) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    fail(`required ${label} is not present.`);
    return false;
  }
  return true;
}

function requirePlistString(plist, key, label) {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`),
  );
  if (!match?.[1]?.trim()) {
    fail(`${label} must contain a non-empty ${key}.`);
  }
}

function plistBoolean(plist, key) {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`),
  );
  return match?.[1] ?? null;
}

function plistStringArray(plist, key) {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`),
  );
  return match ? [...match[1].matchAll(/<string>([^<]+)<\/string>/g)].map((entry) => entry[1].trim()) : [];
}

function readJson(filePath, label) {
  if (!requireFile(filePath, label)) return null;
  try {
    return JSON.parse(read(filePath));
  } catch (error) {
    fail(`${label} is not valid JSON (${error.message}).`);
    return null;
  }
}

function findNotice(notices, noticeId) {
  return notices?.artifacts?.find?.(
    (artifact) => artifact?.notice_id === noticeId,
  );
}

function verifyOneVoiceReleaseAssets({
  infoPlist,
  noticesPath,
  privacyContractPath,
  label,
}) {
  const notices = readJson(noticesPath, `${label} OneVoiceModelNotices.json`);
  const privacyContract = readJson(
    privacyContractPath,
    `${label} OneVoicePrivacyContract.v1.json`,
  );

  if (privacyContract?.protocol_version !== "one.voice.privacy-contract.v1") {
    fail(`${label} One Voice privacy contract has an unsupported protocol version.`);
  }
  if (
    privacyContract?.app_store_declaration_contract_version !==
    "one-voice-privacy-v1"
  ) {
    fail(`${label} One Voice privacy contract must declare the current App Store contract version.`);
  }
  if (privacyContract?.model_packs?.base_bundle_weights !== "forbidden") {
    fail(`${label} One Voice privacy contract must forbid base-bundle model weights.`);
  }

  const fluidSDK = findNotice(notices, "fluidaudio-sdk-v0.15.6");
  if (fluidSDK?.license !== "Apache-2.0") {
    fail(`${label} must retain the pinned FluidAudio SDK notice.`);
  }
  const fluidModel = findNotice(
    notices,
    "fluid-audio-parakeet-eou-120m-coreml-v1",
  );
  if (fluidModel?.license !== "NVIDIA Open Model License") {
    fail(`${label} must retain the exact FluidAudio model license notice.`);
  }

  const fluidEnabled = plistBoolean(infoPlist, "OneVoiceFluidAudioEnabled");
  const fluidBenchmarkEligible = plistBoolean(
    infoPlist,
    "OneVoiceFluidAudioBenchmarkEligible",
  );
  if (fluidEnabled === null || fluidBenchmarkEligible === null) {
    fail(`${label} must explicitly declare FluidAudio release and benchmark flags.`);
    return;
  }
  const allowedBuckets = plistStringArray(
    infoPlist,
    "OneVoiceModelPackAllowedBuckets",
  );
  if (label === "iOS source") {
    if (
      allowedBuckets.length !== 1 ||
      allowedBuckets[0] !== "$(ONE_VOICE_MODEL_PACK_BUCKET)"
    ) {
      fail(`${label} must use the environment-owned One Voice model-bucket build setting.`);
    }
  } else if (
    allowedBuckets.length !== 1 ||
    !/^hushh-pda(?:-uat)?-one-voice-model-packs$/.test(allowedBuckets[0])
  ) {
    fail(`${label} must allow exactly one explicit One Voice model-pack bucket.`);
  }
  if (
    fluidEnabled === "true" &&
    (fluidBenchmarkEligible !== "true" ||
      fluidModel?.approval_state !== "approved" ||
      fluidModel?.release_enabled !== true)
  ) {
    fail(
      `${label} enables FluidAudio without benchmark eligibility and an approved release-enabled model notice.`,
    );
  }
}

function verifyWebManifest(filePath, label) {
  if (!requireFile(filePath, label)) return;
  let manifest;
  try {
    manifest = JSON.parse(read(filePath));
  } catch (error) {
    fail(`${label} is not valid JSON (${error.message}).`);
    return;
  }

  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail(`${label} must define a non-empty name.`);
  }
  if (typeof manifest.short_name !== "string" || !manifest.short_name.trim()) {
    fail(`${label} must define a non-empty short_name.`);
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    fail(`${label} must define at least one icon.`);
  }
}

function verifyAppIntentsMetadata(filePath) {
  const label = "built App Intents metadata";
  const metadata = readJson(filePath, label);
  const actions = metadata?.actions;
  const shortcuts = metadata?.autoShortcuts;

  if (!actions || typeof actions !== "object" || Array.isArray(actions)) {
    fail(`${label} must contain an action dictionary.`);
    return;
  }
  if (!Array.isArray(shortcuts)) {
    fail(`${label} must contain exported App Shortcuts.`);
    return;
  }

  const requiredHandoffs = [
    {
      actionId: "TalkToHusshOneIntent",
      parameter: null,
      phrase: "Talk to ${applicationName}",
    },
    {
      actionId: "AskOneRequestIntent",
      parameter: "requestText",
      phrase: "Ask ${applicationName} something",
    },
  ];

  for (const handoff of requiredHandoffs) {
    const action = actions[handoff.actionId];
    if (!action || action.openAppWhenRun !== true) {
      fail(
        `${label} must export ${handoff.actionId} as an open-app handoff.`,
      );
      continue;
    }

    if (
      handoff.parameter &&
      !action.parameters?.some?.((parameter) => parameter?.name === handoff.parameter)
    ) {
      fail(
        `${label} must export ${handoff.actionId}.${handoff.parameter}.`,
      );
    }

    const shortcut = shortcuts.find(
      (candidate) => candidate?.actionIdentifier === handoff.actionId,
    );
    const phrases = shortcut?.phraseTemplates
      ?.map?.((template) => template?.key)
      .filter?.((phrase) => typeof phrase === "string") ?? [];
    if (!phrases.includes(handoff.phrase)) {
      fail(
        `${label} must export the ${handoff.actionId} phrase ${JSON.stringify(handoff.phrase)}.`,
      );
    }
    if (phrases.some((phrase) => phrase.includes("${requestText}"))) {
      fail(
        `${label} must not interpolate free-text requestText into an App Shortcut phrase.`,
      );
    }
  }
}

function verifySourceContracts() {
  const infoPlist = readPlistXml(sourceInfoPlistPath);
  const privacyManifest = read(sourcePrivacyManifestPath);
  const xcodeProject = read(xcodeProjectPath);

  if (!xcodeProject.includes("ONE_VOICE_MODEL_PACK_BUCKET = hushh-pda-uat-one-voice-model-packs;")) {
    fail("iOS source project must define the explicit UAT One Voice model-bucket default.");
  }

  for (const key of requiredIosUsageDescriptionKeys) {
    requirePlistString(infoPlist, key, "iOS source Info.plist");
  }

  if (!/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(privacyManifest)) {
    fail("iOS PrivacyInfo.xcprivacy must explicitly declare NSPrivacyTracking=false.");
  }

  const requiredProjectEntries = [
    "public in Resources",
    "PrivacyInfo.xcprivacy in Resources",
    "OneVoiceAppIntent.swift in Sources",
    "HushhVoiceInvocationPlugin.swift in Sources",
    "OneVoiceMicrophoneCapture.swift in Sources",
    "OneVoiceFluidAudioPackStore.swift in Sources",
    "OneVoiceFluidAudioSession.swift in Sources",
    "HushhConsentPlugin.swift in Sources",
    "OneVoiceModelNotices.json in Resources",
    "OneVoicePrivacyContract.v1.json in Resources",
  ];
  for (const entry of requiredProjectEntries) {
    if (!xcodeProject.includes(entry)) {
      fail(`Xcode project is missing the required build entry: ${entry}.`);
    }
  }

  verifyWebManifest(sourceWebManifestPath, "web source manifest.webmanifest");
  verifyWebManifest(stagedWebManifestPath, "Capacitor staged manifest.webmanifest");
  verifyOneVoiceReleaseAssets({
    infoPlist,
    noticesPath: sourceModelNoticesPath,
    privacyContractPath: sourceVoicePrivacyContractPath,
    label: "iOS source",
  });
}

function findSuspiciousModelFiles(directoryPath) {
  const suspicious = [];
  const modelExtensions = new Set([
    ".onnx",
    ".gguf",
    ".safetensors",
    ".tflite",
    ".mlmodel",
    ".mlpackage",
    ".mlmodelc",
  ]);

  function walk(currentPath) {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (modelExtensions.has(path.extname(entry.name).toLowerCase())) {
          suspicious.push(childPath);
          continue;
        }
        walk(childPath);
        continue;
      }
      if (modelExtensions.has(path.extname(entry.name).toLowerCase())) {
        suspicious.push(childPath);
      }
    }
  }

  walk(directoryPath);
  return suspicious;
}

function verifyBuiltBundle(bundlePath) {
  if (!bundlePath) return;
  if (!requireDirectory(bundlePath, "iOS product bundle")) return;

  const infoPlistPath = path.join(bundlePath, "Info.plist");
  const privacyManifestPath = path.join(bundlePath, "PrivacyInfo.xcprivacy");
  const webManifestPath = path.join(bundlePath, "public/manifest.webmanifest");
  const appIntentsMetadataPath = path.join(bundlePath, "Metadata.appintents");
  const appIntentsActionsPath = path.join(
    appIntentsMetadataPath,
    "extract.actionsdata",
  );
  const modelNoticesPath = path.join(bundlePath, "OneVoiceModelNotices.json");
  const privacyContractPath = path.join(
    bundlePath,
    "OneVoicePrivacyContract.v1.json",
  );

  requireFile(infoPlistPath, "built Info.plist");
  requireFile(privacyManifestPath, "built PrivacyInfo.xcprivacy");
  requireFile(webManifestPath, "built public/manifest.webmanifest");
  requireDirectory(appIntentsMetadataPath, "built Metadata.appintents");
  requireFile(appIntentsActionsPath, "built Metadata.appintents/extract.actionsdata");
  requireFile(modelNoticesPath, "built OneVoiceModelNotices.json");
  requireFile(privacyContractPath, "built OneVoicePrivacyContract.v1.json");

  const infoPlist = readPlistXml(infoPlistPath);
  const privacyManifest = readPlistXml(privacyManifestPath);

  for (const key of requiredIosUsageDescriptionKeys) {
    requirePlistString(infoPlist, key, "built Info.plist");
  }

  if (
    !/<key>UIBackgroundModes<\/key>[\s\S]*?<string>location<\/string>/.test(
      infoPlist,
    )
  ) {
    fail("built Info.plist must retain the location background mode for live-location sharing.");
  }

  if (!/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(privacyManifest)) {
    fail("built PrivacyInfo.xcprivacy must explicitly declare NSPrivacyTracking=false.");
  }

  verifyWebManifest(webManifestPath, "built public/manifest.webmanifest");
  verifyAppIntentsMetadata(appIntentsActionsPath);
  verifyOneVoiceReleaseAssets({
    infoPlist,
    noticesPath: modelNoticesPath,
    privacyContractPath,
    label: "built iOS bundle",
  });

  const modelFiles = findSuspiciousModelFiles(bundlePath);
  if (modelFiles.length > 0) {
    fail(
      "the base iOS product must not embed model weights; found: " +
        modelFiles.map((filePath) => path.relative(bundlePath, filePath)).join(", "),
    );
  }
}

verifySourceContracts();
const bundlePath = process.env.IOS_APP_BUNDLE_PATH?.trim() || "";
verifyBuiltBundle(bundlePath);

if (!process.exitCode) {
  console.log(
    bundlePath
      ? "iOS source contracts and product bundle assets passed."
      : "iOS source contracts and Capacitor staged assets passed.",
  );
}
