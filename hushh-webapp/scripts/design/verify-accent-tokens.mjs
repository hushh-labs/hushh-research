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
  "#0070ea",
  "#66adff",
  "#0066ff",
  "#006fe6",
  "#1a85ff",
  "#005bb5",
  // Legacy Apple-marketing blues the migration guide (app-surface-design-system.md)
  // names as targets; they must never silently return anywhere the accent flows.
  "#0071e3",
  "#0066cc",
  "#2997ff",
  "#3b82f6",
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
  // Email HTML, not app UI. Mail clients do not resolve CSS custom
  // properties -- Gmail and Outlook strip or ignore them -- so a token here
  // renders as no colour at all. The accent has to be a literal hex in a
  // message body, and the message is inlined-style-only for the same reason.
  // Keep this entry limited to the mail renderer; nothing that paints a
  // screen belongs on this list.
  "app/api/one/location/sos-email/route.ts",
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

// The canonical document pipeline is the one lane that renders founder-facing PDFs and
// artifacts, and it must resolve every accent from globals.css — never a raw hex. The
// dir/extension scan above misses it twice: the formatter is a .mjs (skipped by the
// .ts/.tsx/.css filter) and the exporter lives under scripts/ (not in SCAN_DIRS). So it is
// scanned explicitly here; a hardcoded accent in the pipeline that ships every brief could
// otherwise never trip a gate. (Code-syntax palettes like Monokai are not accent hexes and
// are not in FORBIDDEN_HEXES, so they pass.)
const CANONICAL_PIPELINE_FILES = [
  "lib/morphy-ux/pdf-document-formatter.mjs",
  "scripts/reports/export-markdown-pdf.mjs",
  // The PR-governance contributor dashboard is a second PDF exporter (Molten Gold variant);
  // it must resolve its palette from globals.css too, never a frozen hex copy. Repo-root path.
  "../.codex/skills/pr-governance-review/scripts/export_contributor_impact_pdf.mjs",
];
for (const repoPath of CANONICAL_PIPELINE_FILES) {
  const full = path.join(repoRoot, repoPath);
  if (!fs.existsSync(full)) {
    failures.push(`${repoPath} is missing; the canonical document pipeline must exist`);
    continue;
  }
  const source = fs.readFileSync(full, "utf8").toLowerCase();
  for (const hex of FORBIDDEN_HEXES) {
    if (source.includes(hex)) {
      failures.push(
        `${repoPath} contains raw accent hex ${hex}; the document pipeline must read the accent from globals.css, not hardcode it`,
      );
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
  "--app-accent-hover:",
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

// ── Apple design grammar (see design-system.md → Radius/Weight/Elevation) ──
// 1. Weight ladder is 300 / 400 / 600 / 700 for prose and general emphasis.
//    The Apple-system web spec allows 500 for segmented/bottom-tab labels.
const WEIGHT_500_ALLOWLIST = new Set(["lib/morphy-ux/ui/segmented-pill.tsx"]);
const morphyDir = path.join(repoRoot, "lib/morphy-ux");
if (fs.existsSync(morphyDir)) {
  for (const filePath of listFiles(morphyDir)) {
    const repoPath = path
      .relative(repoRoot, filePath)
      .replaceAll(path.sep, "/");
    if (isAllowed(repoPath) || WEIGHT_500_ALLOWLIST.has(repoPath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("font-medium")) {
      const line =
        source.split("\n").findIndex((l) => l.includes("font-medium")) + 1;
      failures.push(
        `${repoPath}:${line} uses font-medium (weight 500); the ladder is 300/400/600/700 — use font-normal or font-semibold`,
      );
    }
  }
}

// 2. The photographic product shadow exists exactly once as a token; raw
//    copies of its recipe outside globals.css must consume the token.
const RAW_PRODUCT_SHADOW = /rgba\(0,\s*0,\s*0,\s*0\.22\)\s*[_ ]?3px[_ ]5px[_ ]30px/i;
for (const scanDir of SCAN_DIRS) {
  const fullDir = path.join(repoRoot, scanDir);
  if (!fs.existsSync(fullDir)) continue;
  for (const filePath of listFiles(fullDir)) {
    const repoPath = path
      .relative(repoRoot, filePath)
      .replaceAll(path.sep, "/");
    if (repoPath === "app/globals.css" || isAllowed(repoPath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    if (RAW_PRODUCT_SHADOW.test(source)) {
      failures.push(
        `${repoPath} inlines the product shadow recipe; use var(--app-shadow-product)`,
      );
    }
  }
}

// 3. Grammar tokens must exist.
for (const token of [
  "--app-radius-pill:",
  "--motion-press-scale:",
  "--app-shadow-product:",
  "--app-blur-frosted:",
  "--app-tile-dark-1:",
]) {
  if (!globals.includes(token)) {
    failures.push(`app/globals.css is missing grammar token ${token}`);
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
