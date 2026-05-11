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
const micUsageMatch = infoPlist.match(
  /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/
);
if (!micUsageMatch?.[1]?.trim()) {
  fail("iOS Info.plist must include non-empty NSMicrophoneUsageDescription.");
}

const androidManifest = read(androidManifestPath);
if (!androidManifest.includes('android.permission.RECORD_AUDIO')) {
  fail("AndroidManifest.xml must include android.permission.RECORD_AUDIO.");
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

if (!process.exitCode) {
  console.log("Native static parity checks passed.");
}
