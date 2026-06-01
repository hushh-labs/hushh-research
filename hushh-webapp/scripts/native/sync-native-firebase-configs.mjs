#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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
} = {}) {
  const iosSource = firstExisting([
    path.join(monorepoRoot, "GoogleService-Info.plist"),
    path.join(appRoot, "GoogleService-Info.plist"),
  ]);
  const androidSource = firstExisting([
    path.join(monorepoRoot, "google-services.json"),
    path.join(monorepoRoot, "android/app/google-services.json"),
    path.join(appRoot, "google-services.json"),
  ]);

  if (!iosSource) {
    throw new Error("Missing root GoogleService-Info.plist for iOS native build.");
  }
  if (!androidSource) {
    throw new Error("Missing root google-services.json for Android native build.");
  }

  const bundleId = iosBundleId(iosSource);
  if (bundleId && bundleId !== "com.hushh.app") {
    throw new Error(
      `iOS Firebase config bundle id is ${bundleId}; expected com.hushh.app.`
    );
  }

  const packages = androidPackageNames(androidSource);
  if (!packages.has("com.hushh.app")) {
    throw new Error(
      "Android Firebase config does not contain package_name com.hushh.app."
    );
  }

  const iosDestination = path.join(
    appRoot,
    "ios/App/App/GoogleService-Info.plist"
  );
  const androidDestination = path.join(appRoot, "android/app/google-services.json");

  const iosCopied = copyIfDifferent(iosSource, iosDestination);
  const androidCopied = copyIfDifferent(androidSource, androidDestination);

  return {
    iosCopied,
    androidCopied,
    iosDestination,
    androidDestination,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = syncNativeFirebaseConfigs();
    console.log(
      `Native Firebase configs ready (iOS ${result.iosCopied ? "updated" : "current"}, Android ${
        result.androidCopied ? "updated" : "current"
      }).`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
