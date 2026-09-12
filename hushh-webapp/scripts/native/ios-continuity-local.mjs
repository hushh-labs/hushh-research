#!/usr/bin/env node

/**
 * Non-destructive iOS continuity session.
 *
 * Existing route audits deliberately reinstall/reset the app and are cold-start
 * evidence. This command does neither: it boots an available iPhone simulator,
 * launches the already-installed app, and keeps device logs attached while a
 * person or automation drives tabs, background/resume, and One voice interactions.
 * Headless by default; pass --visible only for an explicitly requested desktop UI.
 */

import { execFileSync, spawn } from "node:child_process";

const REQUESTED_DEVICE_NAME = process.env.IOS_TEST_DEVICE_NAME?.trim() || "";
const REQUESTED_DEVICE_ID = process.env.IOS_TEST_DEVICE_UDID?.trim() || "";
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

const phoneDevices = Object.values(devices.devices ?? {})
  .flat()
  .filter((candidate) => candidate?.isAvailable !== false && /^iPhone/.test(candidate?.name || ""));
const device = phoneDevices.find(
  (candidate) =>
    (!REQUESTED_DEVICE_ID || candidate.udid === REQUESTED_DEVICE_ID) &&
    (!REQUESTED_DEVICE_NAME || candidate.name === REQUESTED_DEVICE_NAME),
) || (!REQUESTED_DEVICE_ID && !REQUESTED_DEVICE_NAME
  ? phoneDevices.find((candidate) => candidate.state === "Booted") || phoneDevices[0]
  : undefined);
if (!device) {
  fail(
    REQUESTED_DEVICE_ID || REQUESTED_DEVICE_NAME
      ? `requested simulator ${REQUESTED_DEVICE_NAME || ""} (${REQUESTED_DEVICE_ID || "any id"}) is unavailable.`
      : "no available iPhone simulator was found.",
  );
  process.exit();
}
const DEVICE_NAME = device.name;
const DEVICE_ID = device.udid;

try {
  if (device.state !== "Booted") {
    run("xcrun", ["simctl", "boot", DEVICE_ID]);
    run("xcrun", ["simctl", "bootstatus", DEVICE_ID, "-b"]);
  }
  if (process.argv.includes("--visible")) {
    execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
  }
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
    "Exercise Bottom Bar taps, Home → resume, and a double One voice start through the selected interaction harness.",
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
