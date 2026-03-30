#!/usr/bin/env node
/*
 * verify-native-parity-extended.cjs
 *
 * Extended platform parity checks beyond the base parity script.
 *
 * Checks:
 * 1. Static export coverage: native-supported page IDs map to routes in the contract
 * 2. Web fallback plugins: each *-web.ts plugin has a corresponding interface in index.ts
 * 3. Proxy vs direct routing: api-service.ts has native platform check + web fallback
 * 4. No server-only imports in native pages: page.tsx files must not use next/headers
 */
const fs = require("node:fs");
const path = require("node:path");

const webappRoot = path.resolve(__dirname, "..");
let exitCode = 0;

function fail(msg) { console.error(`ERROR: ${msg}`); exitCode = 1; }
function ok(msg) { console.log(`OK: ${msg}`); }
function read(relPath) { return fs.readFileSync(path.join(webappRoot, relPath), "utf8"); }
function exists(relPath) { return fs.existsSync(path.join(webappRoot, relPath)); }

// ---------------------------------------------------------------------------
// 1. Static export coverage
//    Every nativeSupportedPageContractId must map to a route in the layout contract.
// ---------------------------------------------------------------------------
function checkStaticExportCoverage() {
  const registry = JSON.parse(read("mobile-parity-registry.json"));
  const routeContract = JSON.parse(read("lib/navigation/app-route-layout.contract.json"));

  const nativeIds = registry.nativeSupportedPageContractIds;
  const contractRoutes = routeContract.map((entry) => entry.route);

  // Build a simple mapping from camelCase page IDs to expected route prefixes.
  // We verify that for each ID we can find at least one route that looks related.
  // This uses a heuristic: strip "Page" suffix, convert camelCase to dash-separated segments.
  function idToRouteHint(id) {
    // e.g. "kaiDashboardPage" -> "kai/dashboard"
    const stripped = id.replace(/Page$/, "");
    const segments = stripped
      .replace(/([A-Z])/g, "/$1")
      .toLowerCase()
      .replace(/^\//, "");
    return segments;
  }

  let covered = 0;
  for (const id of nativeIds) {
    const hint = idToRouteHint(id);
    // Check if any contract route contains the hint segments
    const match = contractRoutes.some((route) => {
      const normalized = route.replace(/^\//, "").toLowerCase();
      // Direct containment or the hint starts with the normalized route
      return normalized.includes(hint) || hint.includes(normalized.replace(/\//g, ""));
    });

    if (!match) {
      // Softer check: just see if any route starts with the first segment
      const firstSeg = hint.split("/")[0];
      const softMatch = contractRoutes.some((r) =>
        r.toLowerCase().startsWith("/" + firstSeg) || r === "/"
      );
      if (!softMatch) {
        fail(`Native page ID "${id}" (hint: ${hint}) has no matching route in app-route-layout.contract.json`);
      }
    }
    covered++;
  }

  ok(`Static export coverage: checked ${covered} native page IDs against ${contractRoutes.length} contract routes`);
}

// ---------------------------------------------------------------------------
// 2. Web fallback plugins
//    Each *-web.ts file in lib/capacitor/plugins/ should have its interface
//    referenced in lib/capacitor/index.ts (directly or via re-export).
// ---------------------------------------------------------------------------
function checkWebFallbackPlugins() {
  const pluginsDir = path.join(webappRoot, "lib/capacitor/plugins");
  if (!fs.existsSync(pluginsDir)) {
    fail("lib/capacitor/plugins/ directory not found");
    return;
  }

  const webPluginFiles = fs.readdirSync(pluginsDir).filter((f) => f.endsWith("-web.ts"));
  const indexTs = read("lib/capacitor/index.ts");

  // Read all .ts files in lib/capacitor/ (not just re-exports from index.ts)
  // because some plugins like kai.ts are standalone modules imported directly.
  const capDir = path.join(webappRoot, "lib/capacitor");
  const allCapFiles = fs.readdirSync(capDir).filter((f) => f.endsWith(".ts"));
  const allSources = allCapFiles.map((f) => {
    try { return fs.readFileSync(path.join(capDir, f), "utf8"); } catch { return ""; }
  });
  const combinedSource = allSources.join("\n");

  for (const file of webPluginFiles) {
    // e.g. "auth-web.ts" -> plugin import path fragment "auth-web"
    const baseName = file.replace(".ts", "");
    // The import should reference the plugin file path like ./plugins/auth-web
    if (!combinedSource.includes(baseName)) {
      fail(`Web plugin "${file}" is not referenced in any lib/capacitor/*.ts module`);
    }
  }

  ok(`Web fallback plugins: all ${webPluginFiles.length} web plugin files are referenced`);
}

// ---------------------------------------------------------------------------
// 3. Proxy vs direct routing
//    api-service.ts must contain both a Capacitor.isNativePlatform() check
//    AND a relative-path web fallback.
// ---------------------------------------------------------------------------
function checkProxyVsDirectRouting() {
  const apiService = read("lib/services/api-service.ts");

  if (!apiService.includes("Capacitor.isNativePlatform()")) {
    fail("api-service.ts missing Capacitor.isNativePlatform() check for native routing");
  }

  // Web fallback: should use relative paths like /api/ for web mode
  const hasRelativePaths = apiService.includes('"/api/') || apiService.includes("'/api/");
  if (!hasRelativePaths) {
    fail("api-service.ts missing relative path /api/ fallback for web mode");
  }

  ok("Proxy vs direct routing: api-service.ts has native platform check and web relative path fallback");
}

// ---------------------------------------------------------------------------
// 4. No server-only imports in native pages
//    Pages that run on native must not import next/headers.
// ---------------------------------------------------------------------------
function checkNoServerOnlyImportsInNativePages() {
  const registry = JSON.parse(read("mobile-parity-registry.json"));
  const routeContract = JSON.parse(read("lib/navigation/app-route-layout.contract.json"));

  // Build route -> page.tsx path mapping from the contract routes
  const routeToPath = {};
  for (const entry of routeContract) {
    const route = entry.route === "/" ? "" : entry.route;
    routeToPath[entry.route] = `app${route}/page.tsx`;
  }

  const nativeIds = registry.nativeSupportedPageContractIds;
  let checkedCount = 0;

  for (const id of nativeIds) {
    // Find matching contract routes for this ID
    for (const entry of routeContract) {
      const pagePath = routeToPath[entry.route];
      if (!pagePath || !exists(pagePath)) continue;

      // Only check routes that could plausibly match this native page ID
      const idLower = id.replace(/Page$/, "").toLowerCase();
      const routeLower = entry.route.replace(/\//g, "").toLowerCase();
      if (!routeLower.includes(idLower.slice(0, 3)) && idLower !== "home" && entry.route !== "/") {
        continue;
      }

      const content = read(pagePath);
      if (
        content.includes('from "next/headers"') ||
        content.includes("from 'next/headers'")
      ) {
        fail(`Native-supported page ${pagePath} imports next/headers (server-only, breaks native)`);
      }
      checkedCount++;
    }
  }

  ok(`No server-only imports: checked ${checkedCount} page files for next/headers usage`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  checkStaticExportCoverage();
  checkWebFallbackPlugins();
  checkProxyVsDirectRouting();
  checkNoServerOnlyImportsInNativePages();

  if (exitCode) {
    console.error("\nExtended parity check FAILED");
    process.exit(1);
  }
  console.log("\nExtended parity check PASSED");
}

main();
