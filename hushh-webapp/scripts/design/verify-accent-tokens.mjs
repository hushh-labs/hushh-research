#!/usr/bin/env node

/**
 * Accent token enforcement.
 *
 * The app has ONE switchable accent identity: the --app-accent-* family in
 * app/globals.css (iOS Blue default, Molten Gold under html[data-accent="gold"]).
 * Components must consume the tokens (or their aliases such as
 * --foundation-gold-*, --brand-*, --morphy-*, --tone-blue), never raw accent
 * hexes, or the accent preference silently stops working on that surface.
 *
 * This script fails when a raw accent hex (either palette, any case) appears
 * in app/, components/, or lib/ source outside the allowlist below.
 *
 * Allowlist rationale:
 * - app/globals.css: the token definitions themselves (both palettes) plus
 *   the RIA persona scope, which intentionally keeps its own gold identity
 *   regardless of the accent preference.
 * - lib/foundation/hussh.type.ts: static Foundation design-bible reference
 *   (no runtime consumers).
 * - __tests__ / *.test.*: absence tests assert that gold hexes do NOT render;
 *   they must be able to name the hexes.
 * - lib/theme/accent.ts + this script: define/enforce the mechanism.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Raw accent hexes that must never appear in component source.
// Gold family (legacy identity) + blue family (default identity).
const FORBIDDEN_HEXES = [
  // Gold / molten family
  "#d4a574",
  "#b8894d",
  "#e6b366",
  "#d4af6a",
  "#9c7434",
  "#c8995f",
  "#e0bb8e",
  "#835f27",
  "#8a6a2f",
  // iOS blue family (must flow through tokens too)
  "#007aff",
  "#0a84ff",
  "#4a9eff",
  "#72b4ff",
  "#9bc9ff",
  "#006fdc",
  "#0066ff",
  "#006fe6",
  "#1a85ff",
  "#005bb5",
];

const SCAN_DIRS = ["app", "components", "lib"];

const ALLOWLIST = new Set([
  "app/globals.css",
  "lib/foundation/hussh.type.ts",
  "lib/theme/accent.ts",
  // Deliberately multicolor ambience: the first stop is accent-seeded via
  // var(--app-accent); the remaining rainbow stops (incl. one warm gold) are
  // atmosphere, not the accent identity.
  "components/agent/agent-voice-edge-glow.tsx",
  // Google Maps JS API needs a concrete color; the file resolves the live
  // --app-accent at runtime and only uses #007aff as the SSR fallback.
  "components/one-location/redesign/drive-route-map.tsx",
]);

function isAllowed(repoPath) {
  if (ALLOWLIST.has(repoPath)) return true;
  if (repoPath.includes("__tests__/")) return true;
  if (/\.test\.(ts|tsx)$/.test(repoPath)) return true;
  return false;
}

function listFiles(dir) {
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === ".next-prod"
      ) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (/\.(ts|tsx|css)$/.test(entry.name)) {
        result.push(fullPath);
      }
    }
  };
  visit(dir);
  return result.sort();
}

const failures = [];

for (const scanDir of SCAN_DIRS) {
  const fullDir = path.join(repoRoot, scanDir);
  if (!fs.existsSync(fullDir)) continue;
  for (const filePath of listFiles(fullDir)) {
    const repoPath = path
      .relative(repoRoot, filePath)
      .replaceAll(path.sep, "/");
    if (isAllowed(repoPath)) continue;
    const source = fs.readFileSync(filePath, "utf8").toLowerCase();
    for (const hex of FORBIDDEN_HEXES) {
      if (source.includes(hex)) {
        const line =
          source.split("\n").findIndex((l) => l.includes(hex)) + 1;
        failures.push(
          `${repoPath}:${line} contains raw accent hex ${hex}; use the --app-accent-* token family instead`,
        );
      }
    }
  }
}

// The token definitions themselves must exist.
const globals = fs.readFileSync(
  path.join(repoRoot, "app/globals.css"),
  "utf8",
);
const REQUIRED_TOKENS = [
  "--app-accent:",
  "--app-accent-deep:",
  "--app-accent-bright:",
  "--app-accent-tint:",
  "--app-accent-surface:",
  "--app-accent-surface-strong:",
  "--app-accent-border:",
  "--app-accent-fg:",
  "--app-accent-ring:",
  "--app-accent-hero-from:",
  "--app-accent-hero-mid:",
  "--app-accent-hero-to:",
];
const goldBlockStart = globals.indexOf('html[data-accent="gold"]');
if (goldBlockStart === -1) {
  failures.push(
    'app/globals.css is missing the html[data-accent="gold"] override block',
  );
} else {
  const goldSection = globals.slice(goldBlockStart);
  for (const token of REQUIRED_TOKENS) {
    if (!globals.includes(token)) {
      failures.push(`app/globals.css is missing base token ${token}`);
    }
    if (!goldSection.includes(token)) {
      failures.push(
        `html[data-accent="gold"] block is missing override for ${token}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`verify-accent-tokens: ${failures.length} failure(s)\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("verify-accent-tokens: OK");
