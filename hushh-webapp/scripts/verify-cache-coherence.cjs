#!/usr/bin/env node
/*
 * verify-cache-coherence.cjs
 *
 * Hard-fail guardrail for deterministic cache mutation policy.
 * Critical CRUD paths must route cache updates through CacheSyncService.
 */

const fs = require("node:fs");
const path = require("node:path");

const webappRoot = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(webappRoot, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.join(webappRoot, relPath));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function assertContains(relPath, snippets) {
  if (!exists(relPath)) {
    fail(`Missing required file: ${relPath}`);
    return;
  }

  const src = read(relPath);
  for (const snippet of snippets) {
    if (!src.includes(snippet)) {
      fail(`${relPath} missing required cache-coherence hook: ${snippet}`);
    }
  }
}

function assertNotContains(relPath, snippets) {
  if (!exists(relPath)) {
    fail(`Missing required file: ${relPath}`);
    return;
  }

  const src = read(relPath);
  for (const snippet of snippets) {
    if (src.includes(snippet)) {
      fail(`${relPath} contains bypass pattern: ${snippet}`);
    }
  }
}

function checkRequiredCoordinatorUsage() {
  const required = [
    ["lib/services/personal-knowledge-model-service.ts", ["CacheSyncService.onPkmDomainStored", "CacheSyncService.onPkmDomainCleared"]],
    ["lib/services/vault-service.ts", ["CacheSyncService.onVaultStateChanged"]],
    ["lib/services/kai-history-service.ts", ["CacheSyncService.onAnalysisHistoryMutated"]],
    ["lib/consent/use-consent-actions.ts", ["CacheSyncService.onConsentMutated"]],
    ["components/kai/views/portfolio-review-view.tsx", ["CacheSyncService.onPortfolioUpserted"]],
    ["components/kai/kai-flow.tsx", ["CacheSyncService.onPortfolioUpserted"]],
    ["components/kai/views/manage-portfolio-view.tsx", ["CacheSyncService.onPortfolioUpserted"]],
    ["lib/firebase/auth-context.tsx", ["CacheSyncService.onAuthSignedOut"]],
    ["app/profile/page.tsx", ["CacheSyncService.onAccountDeleted"]],
    ["components/app-ui/top-app-bar.tsx", ["CacheSyncService.onAccountDeleted"]],
    ["app/logout/page.tsx", ["CacheSyncService.onAuthSignedOut"]],
  ];

  for (const [relPath, snippets] of required) {
    assertContains(relPath, snippets);
  }

  ok("Critical CRUD/auth paths are wired to CacheSyncService");
}

function checkBypassPatterns() {
  const bypassChecks = [
    [
      "lib/services/kai-history-service.ts",
      ["CacheService.getInstance()", "cache.invalidate(", "CACHE_KEYS."],
    ],
    [
      "components/kai/views/portfolio-review-view.tsx",
      ["CacheService.getInstance()", "CACHE_KEYS.", "CACHE_TTL."],
    ],
    [
      "components/kai/kai-flow.tsx",
      ["CacheService.getInstance().invalidate(", "CACHE_KEYS.PKM_METADATA", "CACHE_KEYS.PORTFOLIO_DATA"],
    ],
    [
      "components/kai/views/manage-portfolio-view.tsx",
      ["CacheService.getInstance().invalidate(", "CACHE_KEYS.PKM_METADATA"],
    ],
  ];

  for (const [relPath, snippets] of bypassChecks) {
    assertNotContains(relPath, snippets);
  }

  ok("No direct cache invalidation bypasses in critical mutation paths");
}

function checkMutationServiceHints() {
  // Best-effort hard checks: these service files include mutation calls and must include CacheSyncService.
  const serviceFiles = [
    "lib/services/personal-knowledge-model-service.ts",
    "lib/services/vault-service.ts",
    "lib/services/kai-history-service.ts",
  ];

  for (const relPath of serviceFiles) {
    const src = read(relPath);
    const hasMutationVerb =
      src.includes("method: \"POST\"") ||
      src.includes("method: \"PUT\"") ||
      src.includes("method: \"PATCH\"") ||
      src.includes("method: \"DELETE\"") ||
      src.includes("storeMergedDomain(") ||
      src.includes("clearDomain(") ||
      src.includes("setupVault(");

    if (hasMutationVerb && !src.includes("CacheSyncService")) {
      fail(`${relPath} appears to mutate DB data but does not reference CacheSyncService`);
    }
  }

  ok("Service-layer mutation files include cache sync coordinator");
}

function main() {
  checkRequiredCoordinatorUsage();
  checkBypassPatterns();
  checkMutationServiceHints();

  if (process.exitCode) {
    console.error("\nCache coherence verification FAILED");
    process.exit(1);
  }

  console.log("\nCache coherence verification PASSED");
}

main();
