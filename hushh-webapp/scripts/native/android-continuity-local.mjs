#!/usr/bin/env node

/** Non-destructive Android counterpart of ios-continuity-local.mjs. */
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";

const serial = process.env.ANDROID_CONTINUITY_SERIAL || "";
const bundleId = process.env.ANDROID_CONTINUITY_BUNDLE_ID || "com.hussh.app";
const defaultAndroidSdk = `${process.env.HOME || ""}/Library/Android/sdk`;
const defaultAdb = `${defaultAndroidSdk}/platform-tools/adb`;
const adbCommand =
  process.env.ADB || (fs.existsSync(defaultAdb) ? defaultAdb : "adb");
const adb = (args, options = {}) =>
  execFileSync(adbCommand, [...(serial ? ["-s", serial] : []), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();

function waitForProcessId(maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const pid = adb(["shell", "pidof", bundleId]).split(/\s+/).find(Boolean);
      if (pid) return pid;
    } catch {
      // Android may still be creating the process immediately after launch.
    }
    execFileSync("sleep", ["1"], { stdio: "ignore" });
  }
  throw new Error("app-process-not-ready");
}

try {
  const state = adb(["get-state"]);
  if (state !== "device") throw new Error("not-ready");
  const installed = adb(["shell", "pm", "path", bundleId]);
  if (!installed.includes("package:")) throw new Error("not-installed");
  adb(["shell", "monkey", "-p", bundleId, "-c", "android.intent.category.LAUNCHER", "1"]);
} catch {
  process.stderr.write(
    "android continuity: requires a ready emulator with an already-installed app; it will not install, clear, or force-stop it.\n",
  );
  process.exit(1);
}

const pid = waitForProcessId();
process.stdout.write(
  "Android continuity session running without reset. Drive rapid tabs, Home → resume, and double voice start; Ctrl-C stops log monitoring only.\n",
);
const logs = spawn(
  adbCommand,
  [...(serial ? ["-s", serial] : []), "logcat", "--pid", pid],
  {
  stdio: "inherit",
  },
);
process.once("SIGINT", () => logs.kill("SIGINT"));
process.once("SIGTERM", () => logs.kill("SIGTERM"));
