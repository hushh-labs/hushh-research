#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function resolveAppRoot(cwd = process.cwd()) {
  if (fs.existsSync(path.join(cwd, "capacitor.config.ts"))) {
    return cwd;
  }
  const nested = path.join(cwd, "hushh-webapp");
  if (fs.existsSync(path.join(nested, "capacitor.config.ts"))) {
    return nested;
  }
  return cwd;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function androidPackageNames(filePath) {
  try {
    const payload = readJson(filePath);
    return new Set(
      (payload.client || [])
        .map((client) => client.client_info?.android_client_info?.package_name)
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function iosBundleId(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return source.match(/<key>BUNDLE_ID<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "";
}

function copyIfDifferent(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const source = fs.readFileSync(sourcePath);
  const current = fs.existsSync(destinationPath)
    ? fs.readFileSync(destinationPath)
    : null;
  if (current && Buffer.compare(source, current) === 0) {
    return false;
  }
  fs.copyFileSync(sourcePath, destinationPath);
  return true;
}

export function syncNativeFirebaseConfigs({
  appRoot = resolveAppRoot(),
  monorepoRoot = path.resolve(appRoot, ".."),
  platform = "all",
} = {}) {
  if (!["all", "ios", "android"].includes(platform)) {
    throw new Error(`Unsupported native Firebase platform: ${platform}`);
  }

  const includeIos = platform === "all" || platform === "ios";
  const includeAndroid = platform === "all" || platform === "android";
  const iosSource = firstExisting([
    path.join(monorepoRoot, "GoogleService-Info.plist"),
    path.join(appRoot, "GoogleService-Info.plist"),
  ]);
  const androidSource = firstExisting([
    path.join(monorepoRoot, "google-services.json"),
    path.join(monorepoRoot, "android/app/google-services.json"),
    path.join(appRoot, "google-services.json"),
  ]);

  if (includeIos && !iosSource) {
    throw new Error("Missing root GoogleService-Info.plist for iOS native build.");
  }
  if (includeAndroid && !androidSource) {
    throw new Error("Missing root google-services.json for Android native build.");
  }

  const bundleId = includeIos ? iosBundleId(iosSource) : "";
  if (bundleId && bundleId !== "com.hushh.app") {
    throw new Error(
      `iOS Firebase config bundle id is ${bundleId}; expected com.hushh.app.`
    );
  }

  // Android ships as com.hussh.app; only iOS is com.hushh.app. This check used
  // the iOS bundle id, so it accepted a google-services.json with no client for
  // the package Android actually builds as, and Gradle then failed at
  // processDebugGoogleServices with "No matching client found".
  const packages = includeAndroid ? androidPackageNames(androidSource) : new Set();
  if (includeAndroid && !packages.has("com.hussh.app")) {
    throw new Error(
      "Android Firebase config does not contain package_name com.hussh.app."
    );
  }

  const iosDestination = path.join(
    appRoot,
    "ios/App/App/GoogleService-Info.plist"
  );
  const androidDestination = path.join(appRoot, "android/app/google-services.json");

  const iosCopied = includeIos ? copyIfDifferent(iosSource, iosDestination) : false;
  const androidCopied = includeAndroid ? copyIfDifferent(androidSource, androidDestination) : false;

  return {
    iosCopied,
    androidCopied,
    iosDestination,
    androidDestination,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const platformIndex = process.argv.indexOf("--platform");
    const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : "all";
    const result = syncNativeFirebaseConfigs({ platform });
    console.log(
      `Native Firebase configs ready (${platform}; iOS ${result.iosCopied ? "updated" : "current"}, Android ${
        result.androidCopied ? "updated" : "current"
      }).`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
