#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const iosInfoPlistPath = path.join(repoRoot, "ios/App/App/Info.plist");
const androidManifestPath = path.join(repoRoot, "android/app/src/main/AndroidManifest.xml");
const routesPath = path.join(repoRoot, "lib/navigation/routes.ts");
const inventoryPath = path.join(repoRoot, "native-route-inventory.json");

function fail(message) {
  console.error(`native-static-parity: ${message}`);
  process.exitCode = 1;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function routeValuesFromRoutesTs(source) {
  return [
    ...new Set(
      [...source.matchAll(/\b[A-Z0-9_]+:\s*"([^"]+)"/g)].map((match) => match[1])
    ),
  ].sort();
}

const infoPlist = read(iosInfoPlistPath);
const iosUsageDescriptionKeys = [
  ...infoPlist.matchAll(/<key>(NS[A-Za-z0-9]+UsageDescription)<\/key>/g),
].map((match) => match[1]);
const allowedIosUsageDescriptionKeys = new Set([
  "NSMicrophoneUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  // Background location sharing (One Location) needs Always authorization.
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSContactsUsageDescription",
  // The shared vault bridge uses Face ID for a locally authorized unlock.
  // Keep this aligned with verify-native-plugin-contracts.mjs, which requires
  // the same non-empty declaration when the vault/keychain plugins are present.
  "NSFaceIDUsageDescription",
  // Profile picture: choose from library / take a photo.
  "NSPhotoLibraryUsageDescription",
  "NSCameraUsageDescription",
]);
const unexpectedIosUsageDescriptionKeys = iosUsageDescriptionKeys.filter(
  (key) => !allowedIosUsageDescriptionKeys.has(key)
);
if (unexpectedIosUsageDescriptionKeys.length > 0) {
  fail(
    `iOS Info.plist has unexpected permission usage descriptions: ${unexpectedIosUsageDescriptionKeys.join(", ")}.`
  );
}
const micUsageMatch = infoPlist.match(
  /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/
);
if (!micUsageMatch?.[1]?.trim()) {
  fail("iOS Info.plist must include non-empty NSMicrophoneUsageDescription.");
}
const locationUsageMatch = infoPlist.match(
  /<key>NSLocationWhenInUseUsageDescription<\/key>\s*<string>([^<]+)<\/string>/
);
if (!locationUsageMatch?.[1]?.trim()) {
  fail("iOS Info.plist must include non-empty NSLocationWhenInUseUsageDescription.");
}
const contactsUsageMatch = infoPlist.match(
  /<key>NSContactsUsageDescription<\/key>\s*<string>([^<]+)<\/string>/
);
if (!contactsUsageMatch?.[1]?.trim()) {
  fail("iOS Info.plist must include non-empty NSContactsUsageDescription.");
}

const androidManifest = read(androidManifestPath);
const androidPermissions = [
  ...androidManifest.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g),
].map((match) => match[1]);
const allowedAndroidPermissions = new Set([
  "android.permission.INTERNET",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.READ_CONTACTS",
]);
const unexpectedAndroidPermissions = androidPermissions.filter(
  (permission) => !allowedAndroidPermissions.has(permission)
);
if (unexpectedAndroidPermissions.length > 0) {
  fail(
    `AndroidManifest.xml has unexpected permissions: ${unexpectedAndroidPermissions.join(", ")}.`
  );
}
if (!androidManifest.includes('android.permission.RECORD_AUDIO')) {
  fail("AndroidManifest.xml must include android.permission.RECORD_AUDIO.");
}
if (!androidManifest.includes('android.permission.MODIFY_AUDIO_SETTINGS')) {
  fail("AndroidManifest.xml must include android.permission.MODIFY_AUDIO_SETTINGS.");
}
if (!androidManifest.includes('android.permission.ACCESS_FINE_LOCATION')) {
  fail("AndroidManifest.xml must include android.permission.ACCESS_FINE_LOCATION.");
}
if (!androidManifest.includes('android.permission.ACCESS_COARSE_LOCATION')) {
  fail("AndroidManifest.xml must include android.permission.ACCESS_COARSE_LOCATION.");
}
if (!androidManifest.includes('android.permission.READ_CONTACTS')) {
  fail("AndroidManifest.xml must include android.permission.READ_CONTACTS.");
}
if (androidManifest.includes('android.permission.ACCESS_BACKGROUND_LOCATION')) {
  fail("One Location Agent v1 must not request android.permission.ACCESS_BACKGROUND_LOCATION.");
}
const androidMainActivity = androidManifest.match(
  /<activity\b(?=[^>]*android:name="\.MainActivity")[^>]*>/,
);
if (!androidMainActivity?.[0]?.includes('android:windowSoftInputMode="adjustNothing"')) {
  fail(
    "Android MainActivity must use windowSoftInputMode=adjustNothing so KeyboardInsetManager is the only keyboard layout authority.",
  );
}
if (!infoPlist.includes("<string>location</string>")) {
  fail("One Location background sharing requires the iOS 'location' background mode in Info.plist UIBackgroundModes.");
}

const routeValues = routeValuesFromRoutesTs(read(routesPath));
const inventory = JSON.parse(read(inventoryPath));
const inventoryRoutes = inventory.routes || [];
const inventoryRouteSet = new Set(inventoryRoutes.map((route) => route.route));

const missingRoutes = routeValues.filter((route) => !inventoryRouteSet.has(route));
if (missingRoutes.length > 0) {
  fail(`native-route-inventory.json is missing ROUTES entries: ${missingRoutes.join(", ")}`);
}

const routeValueSet = new Set(routeValues);
const unclassifiedExtras = inventoryRoutes
  .filter((route) => !routeValueSet.has(route.route))
  .filter((route) => route.legacyAlias !== true)
  .filter((route) => !String(route.classification || "").startsWith("excluded"));
if (unclassifiedExtras.length > 0) {
  fail(
    `native-route-inventory.json has unclassified legacy routes: ${unclassifiedExtras
      .map((route) => route.route)
      .join(", ")}`
  );
}

const nativeRequiredCount = inventoryRoutes.filter((route) =>
  String(route.classification || "").startsWith("native-required")
).length;
if (inventory.total_routes !== inventoryRoutes.length) {
  fail(
    `inventory total_routes=${inventory.total_routes} does not match routes.length=${inventoryRoutes.length}.`
  );
}
if (inventory.native_required_routes !== nativeRequiredCount) {
  fail(
    `inventory native_required_routes=${inventory.native_required_routes} does not match classified count=${nativeRequiredCount}.`
  );
}

const markerlessRequiredRoutes = inventoryRoutes
  .filter((route) => String(route.classification || "").startsWith("native-required"))
  .filter((route) => !String(route.expectedMarker || "").trim())
  .map((route) => route.route);
if (markerlessRequiredRoutes.length > 0) {
  fail(`native-required routes need expectedMarker: ${markerlessRequiredRoutes.join(", ")}`);
}

const nonCanonicalProfileLaunches = inventoryRoutes
  .filter((route) => String(route.route || "").startsWith("/one/profile"))
  .filter((route) => String(route.initialRoute || "").startsWith("/login?"))
  .filter((route) => {
    try {
      const redirect = new URL(route.initialRoute, "https://native-test.local").searchParams.get("redirect");
      return !redirect?.startsWith("/one/profile");
    } catch {
      return true;
    }
  })
  .map((route) => route.route);
if (nonCanonicalProfileLaunches.length > 0) {
  fail(
    `canonical /one/profile inventory entries must launch through /one/profile redirects: ${nonCanonicalProfileLaunches.join(", ")}`,
  );
}

if (!process.exitCode) {
  console.log("Native static parity checks passed.");
}
