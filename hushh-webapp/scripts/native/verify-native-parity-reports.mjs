#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasNativeRouteAuditContract,
  nativeRouteReportMatches,
} from "./native-route-status.mjs";

const repoRoot = process.cwd();
const inventoryPath = path.join(repoRoot, "native-route-inventory.json");
const reports = {
  ios: path.join(repoRoot, "native-ios-parity-report.json"),
  android: path.join(repoRoot, "native-android-parity-report.json"),
};

const requestedPlatform = (() => {
  const platformArg = process.argv.find((arg) => arg.startsWith("--platform="));
  if (platformArg) {
    return platformArg.split("=")[1];
  }
  const index = process.argv.indexOf("--platform");
  return index >= 0 ? process.argv[index + 1] : "all";
})();

function fail(failures, platform, message) {
  failures.push(`${platform}: ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateReport({ platform, reportPath, requiredRoutes }) {
  const failures = [];
  if (!fs.existsSync(reportPath)) {
    fail(failures, platform, `missing report ${path.relative(repoRoot, reportPath)}`);
    return failures;
  }

  const report = readJson(reportPath);
  const results = Array.isArray(report.results) ? report.results : [];
  const resultsByRoute = new Map(results.map((result) => [result.route, result]));

  if (report.audit_complete !== true) {
    fail(failures, platform, "route audit did not complete");
  }
  if (report.completed_routes !== report.audited_routes || report.completed_routes !== results.length) {
    fail(failures, platform, "completed route count does not match the audit and its results");
  }
  if (resultsByRoute.size !== results.length) {
    fail(failures, platform, "route audit contains duplicate results");
  }
  for (const result of results) {
    if (result.skipped === true) {
      fail(failures, platform, `${result.route} was skipped`);
    }
  }
  if (report.audited_routes < requiredRoutes.length) {
    fail(
      failures,
      platform,
      `audited_routes=${report.audited_routes} is less than current native-required inventory=${requiredRoutes.length}`
    );
  }
  if (results.length < requiredRoutes.length) {
    fail(
      failures,
      platform,
      `results length=${results.length} is less than current native-required inventory=${requiredRoutes.length}`
    );
  }
  if (report.failed_routes !== 0) {
    fail(failures, platform, `failed_routes=${report.failed_routes}; expected 0`);
  }
  if (report.passed_routes !== report.audited_routes) {
    fail(
      failures,
      platform,
      `passed_routes=${report.passed_routes} does not match audited_routes=${report.audited_routes}`
    );
  }

  for (const route of requiredRoutes) {
    if (!hasNativeRouteAuditContract(route)) {
      fail(failures, platform, `${route.route} has an incomplete auth/data contract`);
      continue;
    }
    const result = resultsByRoute.get(route.route);
    if (!result) {
      fail(failures, platform, `missing route result for ${route.route}`);
      continue;
    }

    if (result.ok !== true) {
      fail(failures, platform, `${route.route} is not ok=true`);
      continue;
    }

    const observed = result.observed || {};
    if ((observed.ready || "") !== "1") {
      fail(failures, platform, `${route.route} has ok=true but ready=${observed.ready || ""}`);
    }
    if ((observed.found || "") !== "1") {
      fail(failures, platform, `${route.route} has ok=true but found=${observed.found || ""}`);
    }
    if (result.visible404 === true || (observed.visible404 || "") === "1") {
      fail(failures, platform, `${route.route} has ok=true but visible 404/not-found copy was detected`);
    }
    if ((observed.marker || "") !== route.expectedMarker) {
      fail(
        failures,
        platform,
        `${route.route} marker=${observed.marker || ""}; expected ${route.expectedMarker}`
      );
    }
    if (!nativeRouteReportMatches(observed, route)) {
      fail(
        failures,
        platform,
        `${route.route} failed its native route verdict or sanitized path check ` +
          `(routeok=${observed.routeok || ""}, observed=${observed.route || ""}, expected=${
            route.expectedRoute || route.expectedRoutePrefix || "route-compatible"
          })`
      );
    }
    const allowedAuthStates = route.allowedAuthStates || [route.expectedAuth];
    if (!allowedAuthStates.includes(observed.auth || "")) {
      fail(
        failures,
        platform,
        `${route.route} auth=${observed.auth || ""}; allowed ${allowedAuthStates.join(", ")}`
      );
    }
    if (!route.allowedDataStates.includes(observed.data || "")) {
      fail(
        failures,
        platform,
        `${route.route} data=${observed.data || ""}; allowed ${route.allowedDataStates.join(", ")}`
      );
    }
  }

  return failures;
}

function main() {
  const inventory = readJson(inventoryPath);
  const requiredRoutes = (inventory.routes || []).filter((route) =>
    String(route.classification || "").startsWith("native-required")
  );
  const platforms =
    requestedPlatform === "all"
      ? Object.keys(reports)
      : [requestedPlatform].filter((platform) => reports[platform]);

  if (platforms.length === 0) {
    throw new Error(`Unknown platform "${requestedPlatform}". Use ios, android, or all.`);
  }

  const failures = platforms.flatMap((platform) =>
    validateReport({
      platform,
      reportPath: reports[platform],
      requiredRoutes,
    })
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`native-parity-reports: ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `Native parity report freshness passed (${platforms.join(", ")}, ${requiredRoutes.length} native-required routes).`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
