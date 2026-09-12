#!/usr/bin/env node

/**
 * Validate the source and archive-facing privacy contract for One Voice.
 * App Store Connect answers remain owner-controlled, so CI separately checks
 * a versioned attestation from Secret Manager before a TestFlight upload.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appSource = path.join(appRoot, "ios/App/App");
const infoPlistPath = path.join(appSource, "Info.plist");
const privacyManifestPath = path.join(appSource, "PrivacyInfo.xcprivacy");
const privacyContractPath = path.join(appSource, "OneVoicePrivacyContract.v1.json");
const modelNoticesPath = path.join(appSource, "OneVoiceModelNotices.json");
const xcodeProjectPath = path.join(appRoot, "ios/App/App.xcodeproj/project.pbxproj");

function fail(message) {
  console.error(`ios-voice-privacy-preflight: ${message}`);
  process.exitCode = 1;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.basename(filePath)} (${error.message})`);
    return null;
  }
}

function readPlistXml(filePath) {
  try {
    return execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", filePath], {
      encoding: "utf8",
    });
  } catch {
    fail(`cannot read ${path.basename(filePath)}`);
    return "";
  }
}

function plistBoolean(xml, key) {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`));
  return match?.[1] ?? null;
}

function plistStringArray(xml, key) {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`));
  return match ? [...match[1].matchAll(/<string>([^<]+)<\/string>/g)].map((entry) => entry[1].trim()) : [];
}

function hasNonEmptyPlistString(xml, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>[^<\\s][^<]*</string>`).test(xml);
}

function findNotice(notices, noticeId) {
  return notices?.artifacts?.find?.((entry) => entry?.notice_id === noticeId) ?? null;
}

const contract = readJson(privacyContractPath);
const notices = readJson(modelNoticesPath);
const infoPlist = readPlistXml(infoPlistPath);
let privacyManifest = "";
let xcodeProject = "";
try {
  privacyManifest = fs.readFileSync(privacyManifestPath, "utf8");
  xcodeProject = fs.readFileSync(xcodeProjectPath, "utf8");
} catch (error) {
  fail(`cannot read native privacy/build metadata (${error.message})`);
}

if (contract?.protocol_version !== "one.voice.privacy-contract.v1") {
  fail("privacy contract protocol version is missing or unsupported.");
}
if (contract?.app_store_declaration_contract_version !== "one-voice-privacy-v1") {
  fail("privacy contract must require the current App Store declaration version.");
}
for (const key of contract?.required_info_plist_keys ?? []) {
  if (!hasNonEmptyPlistString(infoPlist, key)) {
    fail(`Info.plist is missing a non-empty ${key}.`);
  }
}
if (!new RegExp("<key>NSPrivacyTracking</key>\\s*<false\\s*/>").test(privacyManifest)) {
  fail("PrivacyInfo.xcprivacy must state tracking=false.");
}
for (const fileName of ["OneVoicePrivacyContract.v1.json", "OneVoiceModelNotices.json"]) {
  if (!xcodeProject.includes(`${fileName} in Resources`)) {
    fail(`Xcode project must ship ${fileName} as a resource.`);
  }
}

const fluidModel = findNotice(notices, "fluid-audio-parakeet-eou-120m-coreml-v1");
if (!fluidModel || fluidModel.license !== "NVIDIA Open Model License") {
  fail("FluidAudio model notice must identify the exact upstream model license.");
}
const fluidEnabled = plistBoolean(infoPlist, "OneVoiceFluidAudioEnabled");
const fluidBenchmarkEligible = plistBoolean(infoPlist, "OneVoiceFluidAudioBenchmarkEligible");
if (fluidEnabled === null || fluidBenchmarkEligible === null) {
  fail("Info.plist must explicitly declare FluidAudio release and benchmark flags.");
}
const allowedBuckets = plistStringArray(infoPlist, "OneVoiceModelPackAllowedBuckets");
if (
  allowedBuckets.length !== 1 ||
  allowedBuckets[0] !== "$(ONE_VOICE_MODEL_PACK_BUCKET)"
) {
  fail("Info.plist must use the environment-owned One Voice model-bucket build setting.");
}
if (!xcodeProject.includes("ONE_VOICE_MODEL_PACK_BUCKET = hushh-pda-uat-one-voice-model-packs;")) {
  fail("The native UAT default must define its One Voice model bucket explicitly.");
}
if (fluidEnabled === "true") {
  if (fluidModel.approval_state !== "approved" || fluidModel.release_enabled !== true) {
    fail("FluidAudio cannot be enabled without an approved, release-enabled model notice.");
  }
  if (fluidBenchmarkEligible !== "true") {
    fail("FluidAudio release selection requires benchmark eligibility.");
  }
}

if (!process.exitCode) {
  console.log("One Voice iOS privacy preflight passed.");
}
