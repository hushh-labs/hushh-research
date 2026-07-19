#!/usr/bin/env node

/**
 * Non-destructive iOS continuity session.
 *
 * Existing route audits deliberately reinstall/reset the app and are cold-start
 * evidence. This command does neither: it opens the canonical iPhone 14 Plus,
 * launches the already-installed app, and keeps device logs attached while a
 * person drives rapid tabs, background/resume, and One voice interactions.
 */

import { execFileSync, spawn } from "node:child_process";

const DEVICE_NAME = process.env.IOS_TEST_DEVICE_NAME || "iPhone 14 Plus";
const DEFAULT_UDID = "9C5B1D61-028C-474A-BDFC-523BACC3B02C";
const DEVICE_ID = process.env.IOS_TEST_DEVICE_UDID || DEFAULT_UDID;
const BUNDLE_ID = process.env.IOS_CONTINUITY_BUNDLE_ID || "com.hushh.app";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function fail(message) {
  process.stderr.write(`ios continuity: ${message}\n`);
  process.exitCode = 1;
}

let devices;
try {
  devices = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"]));
} catch {
  fail("could not read available simulators.");
  process.exit();
}

const device = Object.values(devices.devices ?? {})
  .flat()
  .find((candidate) => candidate?.udid === DEVICE_ID && candidate?.name === DEVICE_NAME);
if (!device) {
  fail(`required ${DEVICE_NAME} (${DEVICE_ID}) is unavailable; do not substitute another device.`);
  process.exit();
}

try {
  if (device.state !== "Booted") {
    run("xcrun", ["simctl", "boot", DEVICE_ID]);
    run("xcrun", ["simctl", "bootstatus", DEVICE_ID, "-b"]);
  }
  execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
  run("xcrun", ["simctl", "get_app_container", DEVICE_ID, BUNDLE_ID, "app"]);
} catch {
  fail(
    `the continuity flow never installs or resets the app. Build/install ${BUNDLE_ID} first, then rerun.`,
  );
  process.exit();
}

try {
  run("xcrun", ["simctl", "launch", DEVICE_ID, BUNDLE_ID]);
} catch {
  fail(`could not launch ${BUNDLE_ID} on ${DEVICE_NAME}.`);
  process.exit();
}

process.stdout.write(
  [
    `Continuity session running on ${DEVICE_NAME} (${DEVICE_ID}).`,
    "The app was not terminated, uninstalled, or reset.",
    "Drive rapid Bottom Bar taps, Home → resume, and a double One voice start in the visible Simulator.",
    "Press Ctrl-C when finished; device logs below contain no vault material by contract.",
  ].join("\n") + "\n",
);

const logs = spawn(
  "xcrun",
  [
    "simctl",
    "spawn",
    DEVICE_ID,
    "log",
    "stream",
    "--style",
    "compact",
    "--predicate",
    'process == "App"',
  ],
  { stdio: "inherit" },
);

const stop = () => {
  logs.kill("SIGINT");
  process.exit();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
logs.once("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
});
