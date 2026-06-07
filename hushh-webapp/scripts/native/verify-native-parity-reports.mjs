#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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

function normalizeRoute(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return trimmed || "/";
  }
  try {
    const url = new URL(trimmed, "https://native-audit.local");
    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${pathname}${url.search}`;
  } catch {
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

function matchesRoute(parsedRoute, route) {
  if (route.expectedRoute) {
    return normalizeRoute(parsedRoute) === normalizeRoute(route.expectedRoute);
  }
  if (route.expectedRoutePrefix) {
    return normalizeRoute(parsedRoute).startsWith(
      normalizeRoute(route.expectedRoutePrefix)
    );
  }
  return true;
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
    if (!matchesRoute(observed.route || "", route)) {
      fail(
        failures,
        platform,
        `${route.route} observed route=${observed.route || ""}; expected ${
          route.expectedRoute || route.expectedRoutePrefix || "route-compatible"
        }`
      );
    }
    if ((observed.auth || "") !== route.expectedAuth) {
      fail(
        failures,
        platform,
        `${route.route} auth=${observed.auth || ""}; expected ${route.expectedAuth}`
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
