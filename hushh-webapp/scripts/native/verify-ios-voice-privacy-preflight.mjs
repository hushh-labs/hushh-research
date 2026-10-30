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

if (contract?.protocol_version !== "one.voice.privacy-contract.v2") {
  fail("privacy contract protocol version is missing or unsupported.");
}
if (contract?.app_store_declaration_contract_version !== "one-voice-privacy-v2") {
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

// v2: bounded command capture stays; One Live Voice adds a server-relayed Live
// session whose generated audio is streamed for playback only (never stored),
// with no provider fallback, no background audio, and a hard session ceiling.
const capture = contract?.voice_capture ?? {};
if (capture.maximum_duration_seconds !== 60) fail("Command capture must stay bounded to 60 seconds.");
if (capture.live_conversation !== "server_relay_gemini_live_vertex_adc") fail("Live conversation must be the server relay on Vertex ADC.");
if (capture.generated_audio !== "streamed_playback_memory_only") fail("Generated audio must be streamed playback only, never stored.");
if (capture.provider_fallback !== "forbidden") fail("Provider fallback must stay forbidden.");
if (!Number.isInteger(capture.maximum_live_session_seconds) || capture.maximum_live_session_seconds > 1800) fail("Live sessions must be bounded to at most 30 minutes.");
if (!["webview_getusermedia", "native_live_audio"].includes(capture.live_capture_path)) fail("Live capture path must be declared.");
if (contract?.background_audio !== "not_required") fail("Live voice must not require background audio.");
if (/<string>audio<\/string>/.test(infoPlist)) fail("UIBackgroundModes must not include audio.");

if (!process.exitCode) {
  console.log("One Voice iOS privacy preflight passed.");
}
