#!/usr/bin/env node

/**
 * Build the selected native iOS app + UI flow artifacts for device or simulator XCUITest.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyNativeAuditBuildEnvironment } from "./native-build-environment.mjs";
import { prepareNativeTestArtifacts } from "./prepare-native-test-artifacts.mjs";
import { createNativeUiAuditPlan } from "./native-ui-audit-plan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function main() {
  applyNativeAuditBuildEnvironment(repoRoot);
  execSync("npm run cap:build", { cwd: repoRoot, stdio: "inherit", env: process.env });
  const manifest = prepareNativeTestArtifacts({
    flowFilter: process.env.IOS_UI_FLOW_FILTER || "",
    routeFilter: process.env.IOS_UI_ROUTE_FILTER || "",
  });
  execSync("npm run cap:sync:ios", { cwd: repoRoot, stdio: "inherit", env: process.env });
  const copiedManifestPath = path.join(repoRoot, "ios/App/App/public/native-ui-flows.json");
  if (!fs.existsSync(copiedManifestPath)) {
    throw new Error("native-ui-flows.json was not copied into the iOS app bundle.");
  }
  const copiedManifest = JSON.parse(fs.readFileSync(copiedManifestPath, "utf8"));
  const auditPlan = createNativeUiAuditPlan(manifest.flows);
  if (copiedManifest?.audit_plan?.digest !== auditPlan.digest) {
    throw new Error("iOS device UI bundle flow manifest does not match the requested audit plan.");
  }
  console.log(`==> native UI flow manifest copied (${manifest.flows.length} flow(s), plan ${auditPlan.digest.slice(0, 12)})`);
}

main();
