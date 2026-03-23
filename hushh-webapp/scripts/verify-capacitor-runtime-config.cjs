#!/usr/bin/env node
/*
 * verify-capacitor-runtime-config.cjs
 *
 * Ensures generated Capacitor runtime config is valid and safe:
 * - plugin backend URLs are present for all networked native plugins
 * - hosted WebView URL is never paired with localhost backend target
 * - SystemBars immersive config is present and StatusBar legacy config is removed
 * - source capacitor.config.ts stays aligned with runtime expectations
 */

const fs = require("node:fs");
const path = require("node:path");

const webRoot = path.resolve(__dirname, "..");
const SOURCE_CONFIG_PATH = path.join(webRoot, "capacitor.config.ts");
const IOS_VIEW_CONTROLLER_PATH = path.join(webRoot, "ios", "App", "App", "MyViewController.swift");

const CONFIG_FILES = [
  {
    label: "iOS",
    relPath: "ios/App/App/capacitor.config.json",
  },
  {
    label: "Android",
    relPath: "android/app/src/main/assets/capacitor.config.json",
  },
];

const REQUIRED_BACKEND_PLUGINS = [
  "HushhVault",
  "HushhConsent",
  "Kai",
  "HushhNotifications",
  "PersonalKnowledgeModel",
  "HushhAccount",
  "HushhSync",
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function readJson(relPath) {
  const full = path.join(webRoot, relPath);
  if (!fs.existsSync(full)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(full, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid JSON in ${relPath}: ${error.message}`);
    return null;
  }
}

function readText(fullPath) {
  if (!fs.existsSync(fullPath)) return null;
  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch (error) {
    fail(`Unable to read ${fullPath}: ${error.message}`);
    return null;
  }
}

function hostFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    return new URL(rawUrl).hostname.trim().toLowerCase();
  } catch {
    return null;
  }
}

function validateConfig(label, relPath, json) {
  if (!json || typeof json !== "object") return;

  const plugins = json.plugins || {};
  const serverUrl = json.server?.url || null;
  const webHost = hostFromUrl(serverUrl);
  const hostedWebView = Boolean(webHost && !LOCAL_HOSTS.has(webHost));
  const iosContentInset = json?.ios?.contentInset;

  const backendUrls = [];
  for (const pluginName of REQUIRED_BACKEND_PLUGINS) {
    const backendUrl = plugins?.[pluginName]?.backendUrl;
    if (typeof backendUrl !== "string" || backendUrl.trim() === "") {
      fail(
        `${label} config (${relPath}) missing plugins.${pluginName}.backendUrl`
      );
      continue;
    }
    backendUrls.push({ pluginName, backendUrl: backendUrl.trim() });
  }

  for (const entry of backendUrls) {
    const backendHost = hostFromUrl(entry.backendUrl);
    if (!backendHost) {
      fail(
        `${label} config (${relPath}) has invalid backendUrl for ${entry.pluginName}: ${entry.backendUrl}`
      );
      continue;
    }
    if (hostedWebView && LOCAL_HOSTS.has(backendHost)) {
      fail(
        `${label} config (${relPath}) pairs hosted server.url (${serverUrl}) with local backendUrl (${entry.backendUrl}) for ${entry.pluginName}`
      );
    }
  }

  if (backendUrls.length > 0) {
    ok(`${label} generated runtime config has backendUrl for required plugins`);
  }

  if (iosContentInset !== "never") {
    fail(
      `${label} config (${relPath}) must set ios.contentInset to "never" for SystemBars immersive mode`
    );
  } else {
    ok(`${label} generated runtime config sets ios.contentInset to "never"`);
  }

  const systemBars = plugins.SystemBars;
  if (!systemBars || typeof systemBars !== "object") {
    fail(`${label} config (${relPath}) missing plugins.SystemBars`);
    return;
  }
  if (plugins.StatusBar) {
    fail(
      `${label} config (${relPath}) still contains legacy plugins.StatusBar block`
    );
  }

  if (systemBars.insetsHandling !== "css") {
    fail(
      `${label} config (${relPath}) must set plugins.SystemBars.insetsHandling to "css"`
    );
  }
  if (
    systemBars.style !== "DEFAULT" ||
    systemBars.hidden !== false ||
    systemBars.animation !== "NONE"
  ) {
    fail(
      `${label} config (${relPath}) must set plugins.SystemBars style=DEFAULT hidden=false animation=NONE`
    );
  } else {
    ok(`${label} generated runtime config has expected plugins.SystemBars values`);
  }
}

function validateSourceConfig() {
  const text = readText(SOURCE_CONFIG_PATH);
  if (!text) {
    fail("Missing source capacitor.config.ts");
    return;
  }

  if (!/contentInset\s*:\s*["']never["']/.test(text)) {
    fail('Source capacitor.config.ts must set ios.contentInset to "never"');
  } else {
    ok('Source capacitor.config.ts sets ios.contentInset to "never"');
  }

  if (!/SystemBars\s*:\s*\{/.test(text)) {
    fail("Source capacitor.config.ts must define plugins.SystemBars");
  } else {
    ok("Source capacitor.config.ts defines plugins.SystemBars");
  }

  if (/StatusBar\s*:\s*\{/.test(text)) {
    fail("Source capacitor.config.ts still defines legacy plugins.StatusBar");
  } else {
    ok("Source capacitor.config.ts removed legacy plugins.StatusBar");
  }

  if (!/insetsHandling\s*:\s*["']css["']/.test(text)) {
    fail('Source capacitor.config.ts must set plugins.SystemBars.insetsHandling to "css"');
  }
}

function validateIOSBridgeInsets() {
  const text = readText(IOS_VIEW_CONTROLLER_PATH);
  if (!text) {
    fail("Missing iOS bridge file ios/App/App/MyViewController.swift");
    return;
  }

  if (/contentInsetAdjustmentBehavior\s*=\s*\.automatic/.test(text)) {
    fail(
      "MyViewController.swift must not set webView.scrollView.contentInsetAdjustmentBehavior = .automatic"
    );
  }

  if (!/contentInsetAdjustmentBehavior\s*=\s*\.never/.test(text)) {
    fail(
      "MyViewController.swift must set webView.scrollView.contentInsetAdjustmentBehavior = .never for SystemBars + ios.contentInset=\"never\""
    );
  } else {
    ok("MyViewController.swift uses contentInsetAdjustmentBehavior = .never");
  }
}

function main() {
  validateSourceConfig();
  validateIOSBridgeInsets();

  let validatedCount = 0;
  const missing = [];

  for (const file of CONFIG_FILES) {
    const json = readJson(file.relPath);
    if (!json) {
      missing.push(file.relPath);
      continue;
    }
    validatedCount += 1;
    validateConfig(file.label, file.relPath, json);
  }

  if (missing.length > 0) {
    console.warn(
      `WARN: Skipping missing generated Capacitor config file(s): ${missing.join(", ")}`
    );
  }
  if (validatedCount === 0) {
    console.warn(
      "WARN: No generated Capacitor configs found. Run `npx cap sync ios` / `npx cap sync android` in mobile build pipelines."
    );
    return;
  }

  if (process.exitCode) {
    console.error("\nCapacitor runtime config verification FAILED");
    process.exit(1);
  }

  console.log("\nCapacitor runtime config verification PASSED");
}

main();
