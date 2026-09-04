#!/usr/bin/env node

/**
 * User-facing vocabulary enforcement.
 *
 * Hushh is a consent-first product: the screens where a person decides what to
 * share are exactly the screens where trust is won or lost. Internal
 * engineering vocabulary on those screens breaks the promise — a person should
 * never be told to "create a row in user_push_tokens" or read a raw
 * "Scope code" while deciding whether to share their life.
 *
 * This script fails when unambiguously internal vocabulary appears in
 * consumer-facing source (app/ and components/).
 *
 * Design notes (why this list is deliberately narrow):
 * - Only terms that are NEVER acceptable on a consumer screen are listed. That
 *   keeps the signal at 100% and the false positives at zero, so the gate is
 *   trusted rather than muted.
 * - Product concept names ("vault", "Personal Knowledge Model", "Agent One")
 *   are intentionally NOT here. Whether those read warmly enough is a product
 *   naming decision, not an engineering leak — it belongs to the founder, not
 *   to a linter.
 * - Redaction denylists legitimately contain words like "traceback" precisely
 *   to keep them off screens. Those files are allowlisted, not flagged.
 *
 * Run: node ./scripts/design/verify-user-vocabulary.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Vocabulary that must never appear in consumer-facing source.
// Each entry: the term, and why it is forbidden (shown in the failure output).
const FORBIDDEN_TERMS = [
  ["user_push_tokens", "database table name"],
  ["VAPID", "push-infrastructure detail"],
  ["Firebase Console", "vendor console; users have no access"],
  ["Cloud Messaging", "vendor infrastructure detail"],
  ["Scope code", "raw consent scope string; show the human meaning instead"],
  ["consent ledger", "internal storage metaphor; say 'consent record'"],
  ["Supabase", "vendor/infrastructure detail"],
  ["BigQuery", "vendor/infrastructure detail"],
  ["Firestore", "vendor/infrastructure detail"],
  ["asyncpg", "driver detail"],
  ["500 Internal", "raw HTTP error; write a human error message"],
];

// Directories scanned as consumer-facing surface.
const SCAN_DIRS = ["app", "components"];

// Paths where technical vocabulary is legitimate.
const ALLOWLIST_PATTERNS = [
  /__tests__/,
  /\.test\.(ts|tsx)$/,
  // Developer-facing documentation surfaces: builders need the real terms.
  /components\/developers\//,
  /app\/developers\//,
  // Redaction denylists exist to keep these words OFF screens.
  /app\/one\/location\/page\.tsx$/,
];

// The email/drafting capability must not surface the internal "KYC" term.
// (Scoped to the authored setup copy, where the label is rendered verbatim.)
const SCOPED_CHECKS = [
  {
    file: "lib/onboarding/capability-setup-copy.ts",
    term: "KYC",
    why: "industry jargon in authored setup copy; name the outcome instead",
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function isAllowlisted(relPath) {
  return ALLOWLIST_PATTERNS.some((pattern) => pattern.test(relPath));
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];

for (const dir of SCAN_DIRS) {
  const absDir = path.join(repoRoot, dir);
  for (const file of walk(absDir)) {
    const relPath = path.relative(repoRoot, file);
    if (isAllowlisted(relPath)) continue;

    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const [term, why] of FORBIDDEN_TERMS) {
        if (line.includes(term)) {
          violations.push({
            relPath,
            line: index + 1,
            term,
            why,
            text: line.trim().slice(0, 120),
          });
        }
      }
    });
  }
}

for (const check of SCOPED_CHECKS) {
  const abs = path.join(repoRoot, check.file);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.includes(check.term)) {
      violations.push({
        relPath: check.file,
        line: index + 1,
        term: check.term,
        why: check.why,
        text: line.trim().slice(0, 120),
      });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\n✗ User-facing vocabulary check failed (${violations.length} occurrence(s)).\n`,
  );
  console.error(
    "  Internal vocabulary must not reach a consumer screen. Replace it with\n" +
      "  what the person actually needs to know.\n",
  );
  for (const v of violations) {
    console.error(`  ${v.relPath}:${v.line}`);
    console.error(`    term: "${v.term}" — ${v.why}`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    "  If a term is legitimate on a developer-facing surface, add that path to\n" +
      "  ALLOWLIST_PATTERNS in scripts/design/verify-user-vocabulary.mjs.\n",
  );
  process.exit(1);
}

console.log("✓ User-facing vocabulary is clean (no internal terms on consumer surfaces).");
