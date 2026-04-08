#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");

const LEGACY_ROUTE_TOKENS = [
  "/agent-nav",
  "/dashboard/kai",
  "/dashboard/domain",
  "/dashboard/agent-nav",
  "/onboarding/preferences",
];

const UNRESOLVED_MARKERS = [
  /\bTODO\b/,
  /\bTBD\b/,
  /\bPLACEHOLDER\b/,
  /PENDING LEGAL FINALIZATION/,
];

const SPECULATIVE_PATTERNS = [
  /\bPlanned\b/i,
  /Future Implementation/i,
];

const OPERATIONAL_DOC_TARGETS = [
  "docs/reference",
  "docs/guides",
  "docs/project_context_map.md",
  "consent-protocol/docs/reference",
  "hushh-webapp/docs",
];

const FIRST_PARTY_DOC_TARGETS = [
  "README.md",
  "getting_started.md",
  "TESTING.md",
  "contributing.md",
  "docs",
  "consent-protocol/docs",
  "hushh-webapp/docs",
];

const DOC_EXCLUDES = [
  "docs/audits/",
  "docs/archives/",
];

const GENERATED_ARTIFACT_DIRS = [
  "hushh-webapp/ios/App/DerivedData",
  "hushh-webapp/ios/build/SourcePackages",
];

const REQUIRED_CANONICAL_ROUTES = {
  HOME: "/",
  LOGIN: "/login",
  LOGOUT: "/logout",
  LABS_PROFILE_APPEARANCE: "/labs/profile-appearance",
  PROFILE: "/profile",
  CONSENTS: "/consents",
  MARKETPLACE: "/marketplace",
  MARKETPLACE_RIA_PROFILE: "/marketplace/ria",
  RIA_HOME: "/ria",
  RIA_ONBOARDING: "/ria/onboarding",
  RIA_CLIENTS: "/ria/clients",
  RIA_REQUESTS: "/ria/requests",
  RIA_SETTINGS: "/ria/settings",
  KAI_HOME: "/kai",
  KAI_ONBOARDING: "/kai/onboarding",
  KAI_IMPORT: "/kai/import",
  KAI_DASHBOARD: "/kai/portfolio",
  KAI_ANALYSIS: "/kai/analysis",
  KAI_OPTIMIZE: "/kai/optimize",
};

const REQUIRED_OPERATIONAL_MARKERS = [
  {
    file: "docs/reference/architecture/api-contracts.md",
    patterns: [
      "/api/kai/market/insights/{user_id}",
      "layout_version",
      "meta.symbol_quality",
      "meta.filtered_symbols",
      "short_recommendation",
      "analysis_degraded",
      "degraded_agents",
    ],
  },
  {
    file: "docs/reference/streaming/streaming-contract.md",
    patterns: [
      "\"event\": \"decision\"",
      "short_recommendation",
      "analysis_degraded",
      "degraded_agents",
      "analysis_mode",
    ],
  },
];

const REMOVED_SCRIPT_REFERENCES = [
  "npm run check-lint",
  "npm run ci:simulate",
  "npm run verify:vault-schema",
  "npm run sync:mobile-firebase:b64",
  "npm run verify:shadcn-parity",
  "npm run cap:android:dev:run",
  "npm run cap:ios:dev:run",
];

const REMOVED_FILE_REFERENCES = [
  "scripts/test-ci-simulation.sh",
  "scripts/ci-simulate.sh",
];

const STALE_DOC_REFERENCE_PATTERNS = [
  "docs/reference/ci.md",
  "docs/reference/route_contracts.md",
  "docs/reference/architecture.md",
  "docs/reference/consent_protocol.md",
  "docs/reference/database_service_layer.md",
  "docs/reference/developer_api.md",
  "docs/guides/mobile_development.md",
  "docs/technical/",
  "docs/business/",
];

const REQUIRED_DOMAIN_INDEXES = [
  "docs/guides/README.md",
  "docs/reference/architecture/README.md",
  "docs/reference/quality/README.md",
  "docs/reference/kai/README.md",
  "docs/reference/mobile/README.md",
  "docs/reference/operations/README.md",
  "docs/reference/streaming/README.md",
];

const REQUIRED_SOURCE_TREE_INDEXES = [
  "hushh-webapp/components/app-ui/README.md",
  "hushh-webapp/components/consent/README.md",
  "hushh-webapp/components/kai/README.md",
  "hushh-webapp/components/ria/README.md",
  "hushh-webapp/lib/services/README.md",
];

const REQUIRED_ROOT_DOC_LINKS = [
  "./guides/README.md",
  "./reference/architecture/README.md",
  "./reference/ai/README.md",
  "./reference/iam/README.md",
  "./reference/kai/README.md",
  "./reference/mobile/README.md",
  "./reference/operations/README.md",
  "./reference/quality/README.md",
  "./reference/streaming/README.md",
  "./vision/README.md",
  "../hushh-webapp/components/app-ui/README.md",
  "../hushh-webapp/components/consent/README.md",
  "../hushh-webapp/components/kai/README.md",
  "../hushh-webapp/components/ria/README.md",
  "../hushh-webapp/lib/services/README.md",
];

const VISUAL_DOC_TARGETS = [
  "docs",
  "consent-protocol/README.md",
  "consent-protocol/docs",
  "hushh-webapp/README.md",
  "hushh-webapp/docs",
];

const PUBLIC_DOC_CONTRACT_TARGETS = [
  "README.md",
  "getting_started.md",
  "contributing.md",
  "docs/README.md",
  "docs/guides/README.md",
  "docs/guides/mobile.md",
  "docs/guides/new-feature.md",
  "docs/guides/getting-started.md",
  "docs/guides/environment-model.md",
  "docs/vision/README.md",
  "docs/reference/architecture/architecture.md",
  "docs/reference/operations/cli.md",
  "docs/reference/operations/branch-governance.md",
  "docs/reference/operations/naming-policy.md",
];

const FORBIDDEN_PUBLIC_DOC_PATTERNS = [
  { pattern: /🤫/g, message: "emoji-led secrecy branding is not allowed in canonical public docs" },
  { pattern: /\bmake setup\b/g, message: "make setup is not part of the public contributor contract" },
  { pattern: /\bmake verify-setup\b/g, message: "make verify-setup is not part of the public contributor contract" },
  { pattern: /\bmake local\b/g, message: "make local is not part of the public contributor contract" },
  { pattern: /\bmake local-web\b/g, message: "make local-web is not part of the public contributor contract" },
  { pattern: /\bmake local-backend\b/g, message: "make local-backend is not part of the public contributor contract" },
  { pattern: /\bnpm run bootstrap\b/g, message: "root npm bootstrap is not part of the public contributor contract" },
  { pattern: /\bnpm run doctor\b/g, message: "root npm doctor is not part of the public contributor contract" },
  { pattern: /\bnpm run web\b/g, message: "root npm web is not part of the public contributor contract" },
  { pattern: /\bnpm run backend\b/g, message: "root npm backend is not part of the public contributor contract" },
  { pattern: /\bnpm run native:ios\b/g, message: "root npm native:ios is not part of the public contributor contract" },
  { pattern: /\bnpm run native:android\b/g, message: "root npm native:android is not part of the public contributor contract" },
  { pattern: /\/Users\//g, message: "personal absolute paths are not allowed in canonical public docs" },
  { pattern: /\bHussh\b/g, message: "Hussh public branding is not allowed in canonical public docs" },
];

const REQUIRED_DENSITY_MARKERS = [
  {
    file: "docs/reference/quality/app-surface-design-system.md",
    patterns: [
      "default to `compact` density",
      "direct page-number navigation",
      "single-page list views must not render pagination chrome",
    ],
  },
  {
    file: "docs/reference/quality/profile-settings-design-system.md",
    patterns: [
      "inherit the app-wide compact density contract by default",
      "shared compact density variables",
    ],
  },
];

const VISUAL_TIER_A_EXTRA = new Set([
  "docs/project_context_map.md",
  "docs/reference/operations/documentation-architecture-map.md",
  "docs/reference/architecture/architecture.md",
  "docs/reference/architecture/api-contracts.md",
  "docs/reference/architecture/cache-coherence.md",
  "docs/reference/architecture/route-contracts.md",
  "docs/reference/iam/architecture.md",
  "docs/reference/iam/runtime-surface.md",
  "docs/reference/iam/consent-scope-catalog.md",
  "docs/reference/kai/kai-interconnection-map.md",
  "docs/reference/kai/kai-brokerage-connectivity-architecture.md",
  "docs/guides/mobile.md",
  "docs/reference/mobile/capacitor-parity-audit.md",
  "docs/reference/operations/ci.md",
  "docs/reference/operations/branch-governance.md",
  "hushh-webapp/README.md",
  "consent-protocol/README.md",
]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function exists(repoRelativePath) {
  return fs.existsSync(path.join(repoRoot, repoRelativePath));
}

function read(repoRelativePath) {
  return fs.readFileSync(path.join(repoRoot, repoRelativePath), "utf8");
}

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function shouldExcludeDoc(repoRelativePath) {
  const normalized = normalize(repoRelativePath);
  return DOC_EXCLUDES.some((prefix) => normalized.startsWith(prefix));
}

function listMarkdownFromTarget(target) {
  const full = path.join(repoRoot, target);
  if (!fs.existsSync(full)) return [];

  const stat = fs.statSync(full);
  if (stat.isFile()) {
    return target.endsWith(".md") && !shouldExcludeDoc(target) ? [target] : [];
  }

  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const rel = normalize(path.relative(repoRoot, child));
      if (!shouldExcludeDoc(rel)) out.push(rel);
    }
  };

  walk(full);
  return out;
}

function unique(list) {
  return [...new Set(list)];
}

function collectDocs(targets) {
  return unique(targets.flatMap((target) => listMarkdownFromTarget(target))).sort();
}

function scanLegacyRoutesInOperationalDocs(files) {
  const offenders = [];
  for (const file of files) {
    const src = read(file);
    for (const token of LEGACY_ROUTE_TOKENS) {
      if (src.includes(token)) offenders.push(`${file}: contains legacy route token ${token}`);
    }
  }
  if (offenders.length) {
    fail(`Legacy route tokens found in operational docs:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Operational docs contain no legacy route tokens");
  }
}

function scanUnresolvedMarkers(files) {
  const offenders = [];
  for (const file of files) {
    const src = read(file);
    for (const pattern of UNRESOLVED_MARKERS) {
      if (pattern.test(src)) offenders.push(`${file}: matches ${pattern}`);
    }
  }
  if (offenders.length) {
    fail(`Unresolved markers found in first-party docs:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("First-party docs contain no unresolved markers");
  }
}

function scanSpeculativeOperationalContent(files) {
  const offenders = [];
  for (const file of files) {
    const src = read(file);
    for (const pattern of SPECULATIVE_PATTERNS) {
      if (pattern.test(src)) offenders.push(`${file}: matches ${pattern}`);
    }
  }
  if (offenders.length) {
    fail(`Speculative phrasing found in operational docs:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Operational docs contain no speculative roadmap phrasing");
  }
}

function verifyNoRemovedScriptReferences(files) {
  const offenders = [];

  for (const file of files) {
    const src = read(file);
    for (const command of REMOVED_SCRIPT_REFERENCES) {
      if (src.includes(command)) {
        offenders.push(`${file}: stale command reference "${command}"`);
      }
    }
  }

  if (offenders.length) {
    fail(`Stale script references found in docs:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Docs do not reference removed/stale package scripts");
  }
}

function verifyNoRemovedFileReferences(files) {
  const offenders = [];

  for (const file of files) {
    const src = read(file);
    for (const removedPath of REMOVED_FILE_REFERENCES) {
      if (src.includes(removedPath)) {
        offenders.push(`${file}: stale file reference "${removedPath}"`);
      }
    }
  }

  if (offenders.length) {
    fail(`Stale file references found in docs:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Docs do not reference removed helper scripts");
  }
}

function verifyNoStaleDocReferences(files) {
  const offenders = [];

  for (const file of files) {
    const src = read(file);
    for (const staleRef of STALE_DOC_REFERENCE_PATTERNS) {
      if (src.includes(staleRef)) {
        offenders.push(`${file}: stale doc reference "${staleRef}"`);
      }
    }
  }

  if (offenders.length) {
    fail(`Stale doc references found:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Docs do not reference deleted legacy doc paths");
  }
}

function looksLikePath(token) {
  if (!token.includes("/")) return false;
  if (token.includes(" ")) return false;
  if (/^[a-zA-Z]+:\/\//.test(token)) return false;
  if (token.startsWith("#")) return false;
  if (token.startsWith("/")) return false; // route paths handled separately
  if (token.includes("{") || token.includes("}")) return false;
  if (token.includes("...")) return false;
  return true;
}

function isLocalEnvReference(token) {
  const cleaned = token.replace(/[),.;:]+$/g, "");
  return /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/.test(cleaned) || cleaned.includes(".env.local.d/");
}

function resolveDocPathReference(file, token) {
  const cleaned = token.replace(/[),.;:]+$/g, "");
  const candidates = [];

  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    candidates.push(
      normalize(path.relative(repoRoot, path.resolve(path.dirname(path.join(repoRoot, file)), cleaned)))
    );
    if (cleaned.startsWith("./")) {
      candidates.push(normalize(cleaned.slice(2)));
    }
    return candidates;
  }

  const rootPrefixed = ["hushh-webapp/", "consent-protocol/", "docs/", "scripts/", "data/", "deploy/"];
  if (rootPrefixed.some((prefix) => cleaned.startsWith(prefix))) {
    candidates.push(normalize(cleaned));
    return candidates;
  }

  return [];
}

function verifyDocPathReferences(files) {
  const offenders = [];

  for (const file of files) {
    const src = read(file);
    const matches = src.matchAll(/`([^`\n]+)`/g);

    for (const match of matches) {
      const token = match[1].trim();
      if (!looksLikePath(token)) continue;
      if (token.includes("*")) continue;
      if (isLocalEnvReference(token)) continue;

      const resolved = resolveDocPathReference(file, token);
      if (resolved.length === 0) continue;

      if (!resolved.some((candidate) => exists(candidate))) {
        offenders.push(`${file}: unresolved path reference \`${token}\` -> ${resolved.join(" OR ")}`);
      }
    }
  }

  if (offenders.length) {
    fail(`Unresolved doc path references found:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Operational doc path references resolve on disk");
  }
}

function parseRoutesContract() {
  const src = read("hushh-webapp/lib/navigation/routes.ts");
  const routes = {};
  for (const match of src.matchAll(/\s+([A-Z_]+):\s*"([^"]+)"/g)) {
    routes[match[1]] = match[2];
  }
  return routes;
}

function verifyCanonicalRouteContract(operationalDocs) {
  const routes = parseRoutesContract();

  for (const [key, expected] of Object.entries(REQUIRED_CANONICAL_ROUTES)) {
    if (routes[key] !== expected) {
      fail(`hushh-webapp/lib/navigation/routes.ts mismatch for ${key}: expected ${expected}, found ${routes[key] ?? "<missing>"}`);
    }
  }

  if ("ONBOARDING_PREFERENCES_LEGACY" in routes) {
    fail("Legacy route key ONBOARDING_PREFERENCES_LEGACY must be removed from route contract");
  }

  const docsBody = operationalDocs.map((file) => read(file)).join("\n");
  for (const route of Object.values(REQUIRED_CANONICAL_ROUTES)) {
    if (!docsBody.includes(route)) {
      fail(`Operational docs missing canonical route reference: ${route}`);
    }
  }

  if (!process.exitCode) ok("Canonical route contract matches docs + runtime source");
}

function verifyNoGeneratedArtifacts() {
  const offenders = [];

  for (const dir of GENERATED_ARTIFACT_DIRS) {
    try {
      const tracked = execSync(`git ls-files -- "${dir}"`, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (tracked.length > 0) {
        offenders.push(`${dir} (tracked files present)`);
      }
    } catch {
      // ignore git invocation failures and continue best-effort checks
    }
  }

  if (offenders.length) {
    fail(`Generated native artifact trees must not be tracked:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("No generated iOS artifact doc/build trees are tracked");
  }
}

function verifyPublicDocContract() {
  const offenders = [];

  for (const file of PUBLIC_DOC_CONTRACT_TARGETS) {
    if (!exists(file)) {
      offenders.push(`${file}: missing canonical public doc`);
      continue;
    }

    const content = read(file);
    for (const rule of FORBIDDEN_PUBLIC_DOC_PATTERNS) {
      if (rule.pattern.test(content)) {
        offenders.push(`${file}: ${rule.message}`);
      }
      rule.pattern.lastIndex = 0;
    }
  }

  const requiredBootstrapDocs = ["README.md", "docs/guides/getting-started.md", "contributing.md"];
  for (const file of requiredBootstrapDocs) {
    const content = read(file);
    if (!content.includes("./bin/hushh bootstrap")) {
      offenders.push(`${file}: must include ./bin/hushh bootstrap in the canonical contributor surface`);
    }
  }

  if (offenders.length) {
    fail(`Public documentation contract violations found:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Canonical public docs match the Hushh/root-CLI contract");
  }
}

function verifyRequiredOperationalMarkers() {
  const offenders = [];

  for (const rule of REQUIRED_OPERATIONAL_MARKERS) {
    if (!exists(rule.file)) {
      offenders.push(`${rule.file}: file missing`);
      continue;
    }
    const src = read(rule.file);
    for (const marker of rule.patterns) {
      if (!src.includes(marker)) {
        offenders.push(`${rule.file}: missing marker "${marker}"`);
      }
    }
  }

  if (offenders.length) {
    fail(`Required operational contract markers missing:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Operational docs include current Kai market + stream contract markers");
  }
}

function verifyRequiredDensityMarkers() {
  const offenders = [];

  for (const rule of REQUIRED_DENSITY_MARKERS) {
    if (!exists(rule.file)) {
      offenders.push(`${rule.file}: file missing`);
      continue;
    }
    const src = read(rule.file);
    for (const marker of rule.patterns) {
      if (!src.includes(marker)) {
        offenders.push(`${rule.file}: missing marker "${marker}"`);
      }
    }
  }

  if (offenders.length) {
    fail(`Required density contract markers missing:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Quality docs include the compact-density contract markers");
  }
}

function verifyRequiredDocIndexes() {
  const missing = [...REQUIRED_DOMAIN_INDEXES, ...REQUIRED_SOURCE_TREE_INDEXES].filter(
    (file) => !exists(file)
  );

  if (missing.length) {
    fail(`Required documentation indexes are missing:\n${missing.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Required documentation index files exist");
  }
}

function verifyRootDocHubLinks() {
  const rootDocs = read("docs/README.md");
  const missing = REQUIRED_ROOT_DOC_LINKS.filter((link) => !rootDocs.includes(link));

  if (missing.length) {
    fail(`docs/README.md is missing required north-star index links:\n${missing.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("docs/README.md links to the required domain and source-tree indexes");
  }
}

function isVisualTierA(file) {
  if (VISUAL_TIER_A_EXTRA.has(file)) {
    return true;
  }

  const normalized = normalize(file);
  const basename = path.basename(normalized);
  if (basename !== "README.md") {
    return false;
  }

  return (
    normalized.startsWith("docs/") ||
    normalized.startsWith("consent-protocol/docs/") ||
    normalized.startsWith("hushh-webapp/docs/")
  );
}

function extractVisualSection(src, heading) {
  const top = src.split(/\r?\n/).slice(0, 160).join("\n");
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^## ${escapedHeading}\\n+([\\s\\S]*?)(?=^##\\s|^#\\s|\\Z)`,
    "m"
  );
  return top.match(pattern);
}

function resolveMarkdownLink(file, target) {
  if (!target || target.startsWith("#") || /^[a-zA-Z]+:\/\//.test(target)) {
    return null;
  }

  const clean = target.split("#")[0].trim();
  if (!clean) {
    return null;
  }

  const absolute = path.resolve(path.dirname(path.join(repoRoot, file)), clean);
  return normalize(path.relative(repoRoot, absolute));
}

function verifyVisualCoverage() {
  const docs = collectDocs(VISUAL_DOC_TARGETS);
  const offenders = [];

  for (const file of docs) {
    const src = read(file);
    const mapMatch = extractVisualSection(src, "Visual Map");
    const contextMatch = extractVisualSection(src, "Visual Context");
    const tierA = isVisualTierA(file);

    if (tierA) {
      if (!mapMatch) {
        offenders.push(`${file}: Tier A doc must contain ## Visual Map near the top`);
        continue;
      }
      if (!/```/.test(mapMatch[1] || "")) {
        offenders.push(`${file}: Visual Map must include a markdown-native diagram block`);
      }
      continue;
    }

    if (!mapMatch && !contextMatch) {
      offenders.push(`${file}: Tier B doc must contain ## Visual Map or ## Visual Context near the top`);
      continue;
    }

    if (contextMatch) {
      const links = [...contextMatch[1].matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) =>
        match[1].trim()
      );
      if (links.length === 0) {
        offenders.push(`${file}: Visual Context must link to a canonical visual owner`);
        continue;
      }

      const resolvedTargets = links
        .map((link) => resolveMarkdownLink(file, link))
        .filter(Boolean);

      if (resolvedTargets.length === 0) {
        offenders.push(`${file}: Visual Context links do not resolve to local docs`);
        continue;
      }

      const validOwner = resolvedTargets.find((target) => exists(target) && isVisualTierA(target));
      if (!validOwner) {
        offenders.push(
          `${file}: Visual Context must include at least one existing Tier A visual owner link`
        );
      }
    }
  }

  if (offenders.length) {
    fail(`Visual coverage contract violations found:\n${offenders.map((x) => `- ${x}`).join("\n")}`);
  } else {
    ok("Maintained docs provide local or inherited visual coverage");
  }
}

function main() {
  const operationalDocs = collectDocs(OPERATIONAL_DOC_TARGETS);
  const firstPartyDocs = collectDocs(FIRST_PARTY_DOC_TARGETS);

  if (operationalDocs.length === 0) {
    fail("No operational docs were discovered to verify");
  }
  if (firstPartyDocs.length === 0) {
    fail("No first-party docs were discovered to verify");
  }

  scanLegacyRoutesInOperationalDocs(operationalDocs);
  scanUnresolvedMarkers(firstPartyDocs);
  scanSpeculativeOperationalContent(operationalDocs);
  verifyNoRemovedScriptReferences(firstPartyDocs);
  verifyNoRemovedFileReferences(firstPartyDocs);
  verifyNoStaleDocReferences(firstPartyDocs);
  verifyDocPathReferences(firstPartyDocs);
  verifyRequiredDocIndexes();
  verifyRootDocHubLinks();
  verifyVisualCoverage();
  verifyPublicDocContract();
  verifyCanonicalRouteContract(operationalDocs);
  verifyRequiredOperationalMarkers();
  verifyRequiredDensityMarkers();
  verifyNoGeneratedArtifacts();

  if (process.exitCode) {
    console.error("\nDocs/runtime parity verification FAILED");
    process.exit(1);
  }

  console.log("\nDocs/runtime parity verification PASSED");
}

main();
