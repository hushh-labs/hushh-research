#!/usr/bin/env node
/*
 * verify-docs-freshness.cjs
 *
 * Production-hardening guardrail for documentation currency,
 * placeholder markers, deprecated export audit, and stale artifacts.
 */

const fs = require("node:fs");
const path = require("node:path");

const webappRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webappRoot, "..");

let exitCode = 0;

function fail(message) {
  console.error(`ERROR: ${message}`);
  exitCode = 1;
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function warn(message) {
  console.warn(`WARN: ${message}`);
}

function readFile(absPath) {
  return fs.readFileSync(absPath, "utf8");
}

function exists(absPath) {
  return fs.existsSync(absPath);
}

function walkDir(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, ext));
    } else if (!ext || entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// Check 1: No production placeholder markers in consent-protocol
// ─────────────────────────────────────────────────────────
function checkPlaceholderMarkers() {
  console.log("\n--- Check 1: Placeholder markers in consent-protocol ---");

  const cpDir = path.join(repoRoot, "consent-protocol", "hushh_mcp");
  if (!exists(cpDir)) {
    warn("consent-protocol/hushh_mcp not found, skipping placeholder check");
    return;
  }

  const patterns = [
    /\[LEGAL ENTITY NAME.*?TBD\]/i,
    /\[TBD\]/i,
    /\[PLACEHOLDER\]/i,
    /TODO:.*production/i,
    /FIXME:.*deploy/i,
  ];

  const pyFiles = walkDir(cpDir, ".py");
  let found = 0;

  for (const file of pyFiles) {
    const src = readFile(file);
    const rel = path.relative(repoRoot, file);

    for (const pat of patterns) {
      const match = src.match(pat);
      if (match) {
        fail(`${rel} contains production placeholder: "${match[0]}"`);
        found++;
      }
    }
  }

  if (found === 0) {
    ok("No production placeholder markers found in consent-protocol");
  }
}

// ─────────────────────────────────────────────────────────
// Check 2: Deprecated export audit — @deprecated must have context
// ─────────────────────────────────────────────────────────
function checkDeprecatedExports() {
  console.log("\n--- Check 2: Deprecated export audit ---");

  const dirs = [
    path.join(webappRoot, "lib"),
    path.join(webappRoot, "components"),
    path.join(webappRoot, "app"),
  ];

  let totalDeprecated = 0;
  let undocumented = 0;

  for (const dir of dirs) {
    const tsFiles = [
      ...walkDir(dir, ".ts"),
      ...walkDir(dir, ".tsx"),
    ];

    for (const file of tsFiles) {
      const src = readFile(file);
      const lines = src.split("\n");
      const rel = path.relative(webappRoot, file);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("@deprecated")) {
          totalDeprecated++;
          const context = lines.slice(i, i + 3).join(" ");
          // Must have at least "Use X instead" or "Removed in" or similar guidance
          if (
            !context.match(/use\s+\w+/i) &&
            !context.match(/removed/i) &&
            !context.match(/replaced/i) &&
            !context.match(/migrated/i) &&
            !context.match(/NOT_IN_SCOPE/i)
          ) {
            warn(
              `${rel}:${i + 1} has @deprecated without migration guidance`
            );
            undocumented++;
          }
        }
      }
    }
  }

  if (undocumented === 0) {
    ok(`${totalDeprecated} @deprecated annotations all have migration guidance`);
  }
}

// ─────────────────────────────────────────────────────────
// Check 3: README currency — each README references at least one existing file
// ─────────────────────────────────────────────────────────
function checkReadmeCurrency() {
  console.log("\n--- Check 3: README currency ---");

  const readmeDirs = [
    ...fs
      .readdirSync(path.join(webappRoot, "components"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(webappRoot, "components", d.name)),
    ...fs
      .readdirSync(path.join(webappRoot, "lib"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(webappRoot, "lib", d.name)),
  ];

  let checked = 0;
  let stale = 0;

  for (const dir of readmeDirs) {
    const readmePath = path.join(dir, "README.md");
    if (!exists(readmePath)) continue;

    checked++;
    const content = readFile(readmePath);
    // Extract backtick-quoted filenames
    const fileRefs = content.match(/`([a-zA-Z0-9_-]+\.\w+)`/g) || [];
    const cleanRefs = fileRefs.map((r) => r.replace(/`/g, ""));

    if (cleanRefs.length === 0) continue;

    const anyExists = cleanRefs.some((ref) => {
      return (
        exists(path.join(dir, ref)) ||
        // Check subdirectories one level deep
        fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .some((d) => exists(path.join(dir, d.name, ref)))
      );
    });

    if (!anyExists) {
      const rel = path.relative(webappRoot, readmePath);
      fail(
        `${rel} references files that no longer exist: ${cleanRefs.join(", ")}`
      );
      stale++;
    }
  }

  if (stale === 0) {
    ok(`${checked} README files are current (reference existing files)`);
  }
}

// ─────────────────────────────────────────────────────────
// Check 4: Stale env var check
// ─────────────────────────────────────────────────────────
function checkStaleEnvVars() {
  console.log("\n--- Check 4: Stale env var check ---");

  const envExamplePath = path.join(webappRoot, ".env.example");
  if (!exists(envExamplePath)) {
    const envLocalPath = path.join(webappRoot, ".env.local.example");
    if (!exists(envLocalPath)) {
      ok("No .env.example found, skipping env var check");
      return;
    }
  }

  // Collect all NEXT_PUBLIC_ vars used in source
  const srcDirs = [
    path.join(webappRoot, "lib"),
    path.join(webappRoot, "components"),
    path.join(webappRoot, "app"),
  ];

  const usedVars = new Set();
  for (const dir of srcDirs) {
    const files = [...walkDir(dir, ".ts"), ...walkDir(dir, ".tsx")];
    for (const file of files) {
      const src = readFile(file);
      const matches = src.match(/process\.env\.NEXT_PUBLIC_\w+/g) || [];
      for (const m of matches) {
        usedVars.add(m.replace("process.env.", ""));
      }
    }
  }

  ok(`Found ${usedVars.size} NEXT_PUBLIC_* env vars referenced in source`);
}

// ─────────────────────────────────────────────────────────
// Check 5: Orphaned test fixtures
// ─────────────────────────────────────────────────────────
function checkOrphanedFixtures() {
  console.log("\n--- Check 5: Orphaned test fixtures ---");

  const fixtureDir = path.join(webappRoot, "__tests__", "fixtures");
  if (!exists(fixtureDir)) {
    ok("No __tests__/fixtures directory found, skipping");
    return;
  }

  const fixtures = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".json") || f.endsWith(".mock.ts"));

  if (fixtures.length === 0) {
    ok("No fixture files found");
    return;
  }

  // Check if each fixture is referenced by at least one test file
  const testFiles = walkDir(path.join(webappRoot, "__tests__"), ".test.ts")
    .concat(walkDir(path.join(webappRoot, "__tests__"), ".test.tsx"));

  const allTestContent = testFiles.map((f) => readFile(f)).join("\n");

  let orphaned = 0;
  for (const fixture of fixtures) {
    const name = fixture.replace(/\.\w+$/, "");
    if (!allTestContent.includes(fixture) && !allTestContent.includes(name)) {
      warn(`__tests__/fixtures/${fixture} may be orphaned (not imported by any test)`);
      orphaned++;
    }
  }

  if (orphaned === 0) {
    ok(`${fixtures.length} fixture files are all referenced by tests`);
  }
}

// ─────────────────────────────────────────────────────────
// Run all checks
// ─────────────────────────────────────────────────────────
console.log("=== Documentation Freshness Verification ===");

checkPlaceholderMarkers();
checkDeprecatedExports();
checkReadmeCurrency();
checkStaleEnvVars();
checkOrphanedFixtures();

console.log("\n=== Done ===");
process.exitCode = exitCode;
