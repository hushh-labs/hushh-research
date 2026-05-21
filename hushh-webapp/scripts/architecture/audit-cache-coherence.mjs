#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "..");
const outputPath = path.join(appRoot, "cache-coherence-screen-manifest.generated.json");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(read(filePath));
}

function walkFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, results);
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function routeSort(left, right) {
  if (left === right) return 0;
  if (left === "/") return -1;
  if (right === "/") return 1;
  return left.localeCompare(right);
}

function routeFromPageFile(filePath) {
  const relative = path.relative(path.join(appRoot, "app"), filePath);
  const route = relative.replace(/(?:^|\/)page\.tsx$/, "");
  return route ? `/${route}` : "/";
}

function pageFileForRoute(route) {
  const candidate = route === "/" ? "app/page.tsx" : `app${route}/page.tsx`;
  return fs.existsSync(path.join(appRoot, candidate)) ? candidate : null;
}

function routeValuesFromRoutesTs(source) {
  return [
    ...new Set(
      [...source.matchAll(/\b[A-Z0-9_]+:\s*"([^"]+)"/g)].map((match) => match[1])
    ),
  ].sort(routeSort);
}

function sourceForRoute(route, contractEntry) {
  const files = new Set();
  const pageFile = pageFileForRoute(route);
  if (pageFile) files.add(pageFile);
  const verificationFile = contractEntry?.shellVerification?.file;
  if (verificationFile) files.add(verificationFile);

  const sources = [];
  for (const relative of files) {
    const absolute = path.join(appRoot, relative);
    if (fs.existsSync(absolute)) {
      sources.push(read(absolute));
    }
  }
  return sources.join("\n\n");
}

function flagsForSource(source) {
  return {
    cache_service: source.includes("CacheService"),
    use_stale_resource: source.includes("useStaleResource"),
    device_cache: source.includes("DeviceResourceCacheService"),
    secure_cache: source.includes("SecureResourceCacheService"),
    cache_sync: source.includes("CacheSyncService"),
    resource_wrapper:
      source.includes("ResourceService") ||
      source.includes("useRiaClientWorkspaceState") ||
      source.includes("getCached") ||
      source.includes("primeCached") ||
      source.includes("readCachedOrFetch"),
    direct_fetch: /\bfetch\s*\(/.test(source),
    api_service: source.includes("ApiService"),
    hushh_loader: source.includes("HushhLoader"),
    sse_or_streaming:
      source.includes("EventSource") ||
      source.includes("text/event-stream") ||
      /\bSSE\b/.test(source) ||
      source.includes("AgentRealtimeClient") ||
      source.includes("streamAgent") ||
      source.includes("apiFetchStream") ||
      source.includes("streamPortfolio"),
    native_beacon: source.includes("NativeRouteMarker") || source.includes("data-native-test-beacon"),
  };
}

function screenClassForRoute(route, mode, flags) {
  if (mode === "redirect") return "redirect/alias";
  if (route === "/" || route === "/developers" || route === "/portfolio/shared") {
    return "public/static";
  }
  if (
    route === "/login" ||
    route === "/logout" ||
    route === "/register-phone" ||
    route.endsWith("/oauth/return")
  ) {
    return "auth/pre-vault";
  }
  if (mode === "flow" || route.includes("/onboarding") || route === "/kai/import") {
    return "hidden flow";
  }
  if (flags.sse_or_streaming || route === "/agent") return "realtime/SSE";
  if (route.startsWith("/ria") || route.startsWith("/marketplace")) return "RIA/provider";
  if (route === "/one/kyc" || route.startsWith("/profile/pkm") || route === "/profile/receipts") {
    return "PKM-secure";
  }
  if (route.startsWith("/kai")) return "vault-backed";
  if (route === "/profile" || route === "/consents") return "vault-backed";
  return mode === "hidden" ? "hidden flow" : "vault-backed";
}

function cachePolicyFor(route, screenClass, flags) {
  if (screenClass === "redirect/alias" || screenClass === "public/static") return "none";
  if (screenClass === "auth/pre-vault") return "memory-only";
  if (route === "/kai/portfolio" || route === "/kai/analysis") return "secure-resource";
  if (route === "/kai") return "device-resource";
  if (screenClass === "PKM-secure") return "secure-resource";
  if (screenClass === "realtime/SSE") return flags.secure_cache ? "secure-resource+sse-background" : "memory-only+sse-background";
  if (screenClass === "RIA/provider") return "device-resource";
  if (screenClass === "hidden flow") return flags.secure_cache ? "secure-resource" : "memory-only";
  return flags.secure_cache ? "secure-resource" : "memory-only";
}

function routeCacheKeys(route) {
  if (route === "/consents") return ["CONSENT_CENTER_SUMMARY", "CONSENT_CENTER_LIST"];
  if (route === "/agent") return ["PKM_METADATA", "KAI_PROFILE", "ANALYSIS_HISTORY"];
  if (route === "/one/kyc") return ["PKM_DOMAIN_RESOURCE", "KYC workflow client state"];
  if (route === "/profile") return ["KAI_PROFILE", "PKM_METADATA", "VAULT_STATUS"];
  if (route === "/profile/pkm-agent-lab") return ["PKM_METADATA", "PKM_DOMAIN_RESOURCE", "PKM_UPGRADE_STATUS"];
  if (route === "/profile/receipts") return ["Gmail receipts resource cache", "PKM_DOMAIN_RESOURCE"];
  if (route === "/kai") return ["KAI_MARKET_HOME", "KAI_MARKET_HOME_BASELINE", "KAI_DASHBOARD_PROFILE_PICKS"];
  if (route === "/kai/portfolio") return ["KAI_FINANCIAL_RESOURCE", "PKM_METADATA", "DOMAIN_DATA(financial)"];
  if (route === "/kai/analysis") return ["STOCK_CONTEXT", "ANALYSIS_HISTORY", "KAI_FINANCIAL_RESOURCE"];
  if (route.startsWith("/kai")) return ["KAI_FINANCIAL_RESOURCE", "STOCK_CONTEXT", "PKM_METADATA"];
  if (route === "/ria") return ["RIA_HOME", "PERSONA_STATE", "RIA_ONBOARDING_STATUS"];
  if (route === "/ria/clients") return ["RIA_CLIENTS"];
  if (route.startsWith("/ria/clients/[userId]/accounts")) return ["RIA_CLIENT_DETAIL", "RIA_WORKSPACE"];
  if (route.startsWith("/ria/clients/[userId]/requests")) return ["RIA_CLIENT_DETAIL", "CONSENT_CENTER_LIST"];
  if (route.startsWith("/ria/clients/[userId]")) return ["RIA_CLIENT_DETAIL", "RIA_WORKSPACE"];
  if (route === "/ria/picks") return ["RIA_PICKS"];
  if (route.startsWith("/marketplace")) return ["MARKETPLACE_RIAS_SEARCH", "MARKETPLACE_INVESTORS_SEARCH"];
  return [];
}

function ttlClassFor(route, screenClass) {
  if (screenClass === "redirect/alias" || screenClass === "public/static") return "none";
  if (route.includes("/oauth/return") || route === "/logout") return "single-use";
  if (screenClass === "realtime/SSE") return "CACHE_TTL.SHORT with active stream patching";
  if (screenClass === "RIA/provider" || route.startsWith("/kai")) return "CACHE_TTL.MEDIUM";
  if (screenClass === "PKM-secure") return "CACHE_TTL.SESSION for metadata; secure resource revision controls payload freshness";
  return "CACHE_TTL.MEDIUM";
}

function warmSourceFor(route, screenClass) {
  if (screenClass === "public/static" || screenClass === "redirect/alias") return "none";
  if (route.startsWith("/kai")) return "UnlockWarmOrchestrator plus route resource loader";
  if (route.startsWith("/ria") || route.startsWith("/marketplace")) return "RIA service memory/device cache";
  if (route === "/consents") return "ConsentCenterService memory cache";
  if (screenClass === "PKM-secure") return "Vault unlock plus secure resource cache";
  return "Route-local resource loader";
}

function refreshTriggerFor(screenClass) {
  if (screenClass === "redirect/alias" || screenClass === "public/static") return "none";
  if (screenClass === "realtime/SSE") return "SSE stream patch plus stale-aware background refresh";
  return "stale-aware background refresh; explicit user refresh may force";
}

function invalidatorFor(route, screenClass) {
  if (screenClass === "redirect/alias" || screenClass === "public/static") return "none";
  if (route === "/consents" || route.includes("/requests")) return "CacheSyncService.onConsentMutated";
  if (route.startsWith("/kai") || route === "/profile/receipts" || route === "/one/kyc") {
    return "CacheSyncService PKM/portfolio/write-through hooks";
  }
  if (route.startsWith("/ria") || route.startsWith("/marketplace")) return "RIA service invalidation plus CacheSyncService consent hooks";
  return "CacheSyncService user/session invalidation";
}

function realtimePolicyFor(screenClass) {
  if (screenClass !== "realtime/SSE") return "not realtime";
  return "cached shell/data renders first; stream patches active view state and cache through service-layer adapters only";
}

function reviewerFixtureFor(route, nativeRow) {
  if (nativeRow?.initialRoute) return nativeRow.initialRoute;
  if (route.startsWith("/ria/clients/[userId]/accounts")) {
    return "/ria/clients/${REVIEWER_UID}/accounts/acct_demo_taxable_main?test_profile=1";
  }
  if (route.startsWith("/ria/clients/[userId]/requests")) {
    return "/ria/clients/${REVIEWER_UID}/requests/request_demo_kai_specialized_bundle?test_profile=1";
  }
  if (route.startsWith("/ria/clients/[userId]")) return "/ria/clients/${REVIEWER_UID}?tab=overview&test_profile=1";
  return route;
}

function findingsFor(route, mode, flags, screenClass, nativeRow) {
  const findings = [];
  if (mode !== "redirect" && mode !== "hidden" && !nativeRow && !flags.native_beacon) {
    findings.push("review native route beacon coverage");
  }
  if (
    !["public/static", "redirect/alias", "auth/pre-vault"].includes(screenClass) &&
    !flags.use_stale_resource &&
    !flags.cache_service &&
    !flags.secure_cache &&
    !flags.device_cache &&
    !flags.resource_wrapper
  ) {
    findings.push("no local cache primitive detected in page/contract source");
  }
  if (flags.direct_fetch && !flags.api_service) {
    findings.push("direct fetch detected; verify service-layer boundary or server-only route context");
  }
  if (flags.hushh_loader && !["auth/pre-vault", "hidden flow", "public/static"].includes(screenClass)) {
    findings.push("loader detected; verify warm cache path avoids blocking loader");
  }
  return findings;
}

function buildManifest() {
  const pageRoutes = walkFiles(path.join(appRoot, "app"), (filePath) => filePath.endsWith("/page.tsx"))
    .map(routeFromPageFile)
    .sort(routeSort);
  const routesFromTs = routeValuesFromRoutesTs(read(path.join(appRoot, "lib/navigation/routes.ts")));
  const routeContract = readJson(path.join(appRoot, "lib/navigation/app-route-layout.contract.json"));
  const contractByRoute = new Map((routeContract || []).map((entry) => [entry.route, entry]));
  const surfaceMap = readJson(path.join(appRoot, "frontend-native-surface-map.generated.json"));
  const surfaceRoutes = (surfaceMap.routes || []).map((entry) => entry.route).sort(routeSort);
  const surfaceByRoute = new Map((surfaceMap.routes || []).map((entry) => [entry.route, entry]));
  const nativeInventory = readJson(path.join(appRoot, "native-route-inventory.json"));
  const nativeByRoute = new Map((nativeInventory.routes || []).map((entry) => [entry.route, entry]));
  const routes = [...new Set([...pageRoutes, ...routesFromTs, ...(routeContract || []).map((entry) => entry.route)])].sort(routeSort);

  const screens = routes.map((route) => {
    const contractEntry = contractByRoute.get(route) || null;
    const source = sourceForRoute(route, contractEntry);
    const flags = flagsForSource(source);
    const mode = contractEntry?.mode || "unclassified";
    const screenClass = screenClassForRoute(route, mode, flags);
    const surfaceEntry = surfaceByRoute.get(route) || null;
    const nativeRow = nativeByRoute.get(route) || null;
    return {
      route,
      page_file: pageFileForRoute(route),
      route_contract_mode: mode,
      screen_class: screenClass,
      cache_policy: cachePolicyFor(route, screenClass, flags),
      cache_keys: routeCacheKeys(route),
      ttl_class: ttlClassFor(route, screenClass),
      warm_source: warmSourceFor(route, screenClass),
      refresh_trigger: refreshTriggerFor(screenClass),
      mutation_invalidator: invalidatorFor(route, screenClass),
      realtime_policy: realtimePolicyFor(screenClass),
      reviewer_fixture: reviewerFixtureFor(route, nativeRow),
      surface_map_present: Boolean(surfaceEntry),
      route_contract_present: Boolean(contractEntry),
      evidence: flags,
      findings: findingsFor(route, mode, flags, screenClass, nativeRow),
    };
  });

  const classCounts = {};
  for (const screen of screens) {
    classCounts[screen.screen_class] = (classCounts[screen.screen_class] || 0) + 1;
  }

  return {
    schema_version: "hushh.cache_coherence_screen_manifest.v1",
    generated_at: "2026-05-21",
    purpose:
      "Screen-level cache posture manifest used to keep warm-cache UX, TTL, route inventory, and reviewer verification aligned.",
    sources: {
      physical_pages: "app/**/page.tsx",
      route_contract: "lib/navigation/routes.ts",
      route_layout_contract: "lib/navigation/app-route-layout.contract.json",
      surface_map: "frontend-native-surface-map.generated.json",
      native_inventory: "native-route-inventory.json",
      cache_reference: "../docs/reference/architecture/cache-coherence.md",
    },
    summary: {
      total_screens: screens.length,
      physical_page_count: pageRoutes.length,
      route_contract_count: routeContract.length,
      surface_map_count: surfaceRoutes.length,
      class_counts: classCounts,
      pages_missing_route_contract: pageRoutes.filter((route) => !contractByRoute.has(route)).sort(routeSort),
      routes_missing_surface_map: routes.filter((route) => !surfaceByRoute.has(route)).sort(routeSort),
    },
    rules: [
      "fresh cache renders immediately without a full-page loader",
      "stale cache remains visible while background refresh runs",
      "cold cache may show a loader or skeleton",
      "mutations route through CacheSyncService or a domain service that delegates to it",
      "realtime streams patch active state without blocking warm initial render",
      "decrypted PKM, vault keys, and consent secrets stay memory-only",
    ],
    screens,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const check = process.argv.includes("--check");
const next = stableJson(buildManifest());

if (check) {
  const current = fs.existsSync(outputPath) ? read(outputPath) : "";
  if (current !== next) {
    console.error(
      `cache-coherence: ${path.relative(repoRoot, outputPath)} is stale. Run node scripts/architecture/audit-cache-coherence.mjs from hushh-webapp.`
    );
    process.exit(1);
  }
  const manifest = JSON.parse(next);
  if (manifest.summary.pages_missing_route_contract.length > 0) {
    console.error(
      `cache-coherence: missing route contract entries: ${manifest.summary.pages_missing_route_contract.join(", ")}`
    );
    process.exit(1);
  }
  if (manifest.summary.routes_missing_surface_map.length > 0) {
    console.error(
      `cache-coherence: missing surface map entries: ${manifest.summary.routes_missing_surface_map.join(", ")}`
    );
    process.exit(1);
  }
  console.log(
    `Cache coherence manifest is current (${manifest.summary.total_screens} screens).`
  );
} else {
  fs.writeFileSync(outputPath, next);
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}
