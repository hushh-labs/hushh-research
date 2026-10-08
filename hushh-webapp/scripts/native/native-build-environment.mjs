import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";

const profileLibrary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/env/runtime_profile_lib.sh");
const buildKeys = new Set(["APP_RUNTIME_PROFILE", "NEXT_DIST_DIR", "NODE_OPTIONS"]);

function buildValues(values) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    (buildKeys.has(key) || key.startsWith("NEXT_PUBLIC_")) && typeof value === "string",
  ));
}

// The shell library owns profile aliases, source names and runtime semantics.
export function nativeProfileMetadata(rawProfile) {
  try {
    const output = execFileSync("bash", ["-c", [
      'set -euo pipefail',
      'source "$1"',
      'profile="$(normalize_runtime_profile "$2")"',
      'printf "%s\\n" "$profile"',
      'runtime_profile_frontend_source "$profile"',
      'printf "\\n"',
      'runtime_profile_frontend_environment "$profile"',
    ].join("\n"), "native-build-profile", profileLibrary, rawProfile], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim().split("\n");
    return { profile: output[0], source: output[1], environment: output[2] };
  } catch {
    throw new Error("Unsupported native build runtime profile.");
  }
}

export function resolveNativeBuildEnvironment({ appRoot, env = process.env, audit = false }) {
  const overlayPath = path.join(appRoot, ".env.native.ios.local");
  // Preserve the saved native release overlay only when no explicit profile
  // was selected. It can never fill missing fields for another profile.
  if (!audit && !env.APP_RUNTIME_PROFILE) {
    const overlay = fs.existsSync(overlayPath) ? buildValues(parseEnvFile(overlayPath)) : {};
    return { ...env, ...overlay };
  }
  const metadata = nativeProfileMetadata(env.APP_RUNTIME_PROFILE || "uat");
  const selectedPath = path.join(appRoot, metadata.source);
  const selected = fs.existsSync(selectedPath) ? buildValues(parseEnvFile(selectedPath)) : {};
  // Empty values for canonical public keys prevent Next/Capacitor dotenv from
  // filling absent optional settings from the active, possibly foreign profile.
  const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", `${metadata.source}.example`);
  const emptyPublicValues = Object.fromEntries(Object.keys(parseEnvFile(templatePath))
    .filter((key) => key.startsWith("NEXT_PUBLIC_")).map((key) => [key, ""]));
  const resolved = { ...env, ...emptyPublicValues, ...selected, ...buildValues(env), APP_RUNTIME_PROFILE: metadata.profile };
  if (resolved.NEXT_PUBLIC_APP_ENV && resolved.NEXT_PUBLIC_APP_ENV !== metadata.environment) {
    throw new Error("Native build runtime environment conflicts with its selected profile.");
  }
  resolved.NEXT_PUBLIC_APP_ENV = metadata.environment;
  {
    const required = ["NEXT_PUBLIC_BACKEND_URL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_APP_ID", "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"];
    if (required.some((key) => !String(resolved[key] || "").trim())) {
      throw new Error("Selected native audit profile is incomplete; no other profile will be used as fallback.");
    }
  }
  if (audit) {
    let backend;
    try { backend = new URL(resolved.NEXT_PUBLIC_BACKEND_URL); } catch {
      throw new Error("Selected native audit backend is invalid.");
    }
    if (backend.protocol !== "https:" || backend.username || backend.password || backend.search || backend.hash || ["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname)) {
      throw new Error("Native audit requires a remote HTTPS backend without embedded credentials.");
    }
  }
  return resolved;
}

export function applyNativeAuditBuildEnvironment(appRoot) {
  const resolved = resolveNativeBuildEnvironment({ appRoot, audit: true });
  Object.assign(process.env, buildValues(resolved));
  console.log(`==> native audit profile: ${resolved.APP_RUNTIME_PROFILE}`);
}

// Read the installed bundle configuration, never infer its target from host env.
export function verifyPrebuiltNativeEnvironment({ appPath, env }) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(appPath, "capacitor.config.json"), "utf8"));
    const backends = Object.values(config.plugins || {}).flatMap((plugin) =>
      plugin && typeof plugin.backendUrl === "string" ? [plugin.backendUrl] : []);
    const expected = String(env.NEXT_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
    const plistPath = path.join(appPath, "GoogleService-Info.plist");
    const plist = fs.readFileSync(plistPath);
    // Xcode packages binary plists; source XML fixtures alone do not verify an
    // installed app. Extract only the required identity field, never the plist.
    const project = plist.subarray(0, 8).toString("ascii") === "bplist00"
      ? execFileSync("/usr/bin/plutil", ["-extract", "PROJECT_ID", "raw", "-o", "-", plistPath], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      }).trim()
      : plist.toString("utf8").match(/<key>PROJECT_ID<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!expected || backends.length === 0 || backends.some((url) => url.replace(/\/$/, "") !== expected)
      || !project || project !== env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) throw new Error("mismatch");
  } catch {
    throw new Error("Prebuilt native identity cannot be verified against the selected profile; rebuild the app.");
  }
}
