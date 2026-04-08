#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const ignoreParts = new Set([
  "node_modules",
  ".next",
  "DerivedData",
  ".pytest_cache",
  ".git",
  ".venv",
  "dist",
  "build",
]);

const rootDocs = [
  "README.md",
  "getting_started.md",
  "contributing.md",
  "TESTING.md",
  "SECURITY.md",
  "code_of_conduct.md",
];

const requiredIndexes = [
  "docs/README.md",
  "docs/guides/README.md",
  "docs/reference/architecture/README.md",
  "docs/reference/iam/README.md",
  "docs/reference/kai/README.md",
  "docs/reference/mobile/README.md",
  "docs/reference/operations/README.md",
  "docs/reference/quality/README.md",
  "docs/reference/streaming/README.md",
  "docs/vision/README.md",
  "consent-protocol/docs/README.md",
  "hushh-webapp/docs/README.md",
];

const tierADocs = [
  "README.md",
  "docs/README.md",
  "docs/guides/README.md",
  "docs/reference/operations/README.md",
  "docs/reference/operations/documentation-architecture-map.md",
  "docs/reference/quality/README.md",
  "docs/vision/README.md",
  "docs/project_context_map.md",
  "consent-protocol/docs/README.md",
  "hushh-webapp/docs/README.md",
];

const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function countLines(source) {
  return source.split("\n").length;
}

for (const rel of requiredIndexes) {
  if (!fs.existsSync(path.join(repoRoot, rel))) {
    failures.push(`missing required docs index: ${rel}`);
  }
}

for (const rel of tierADocs) {
  if (!fs.existsSync(path.join(repoRoot, rel))) continue;
  const src = read(rel);
  if (!src.includes("## Visual Map") && !src.includes("## Visual Context")) {
    failures.push(`tier-a doc missing visual section: ${rel}`);
  }
}

const rootGettingStarted = read("getting_started.md");
if (!rootGettingStarted.includes("docs/guides/getting-started.md")) {
  failures.push("getting_started.md must point to docs/guides/getting-started.md");
}
if (countLines(rootGettingStarted) > 40) {
  failures.push("getting_started.md must stay thin (<= 40 lines)");
}

const rootTesting = read("TESTING.md");
if (!rootTesting.includes("docs/reference/operations/ci.md")) {
  failures.push("TESTING.md must point to docs/reference/operations/ci.md");
}
if (countLines(rootTesting) > 120) {
  failures.push("TESTING.md must stay thin (<= 120 lines)");
}

const rootContributing = read("contributing.md");
if (!rootContributing.includes("docs/guides/getting-started.md")) {
  failures.push("contributing.md must point to docs/guides/getting-started.md");
}
if (countLines(rootContributing) > 140) {
  failures.push("contributing.md must stay thin (<= 140 lines)");
}

const consentDocsReadme = read("consent-protocol/docs/README.md");
for (const forbidden of ["## Quick Start", "## Deployment", "## Linting and Testing"]) {
  if (consentDocsReadme.includes(forbidden)) {
    failures.push(`consent-protocol/docs/README.md should stay an index, not contain section: ${forbidden}`);
  }
}

const docsReadme = read("docs/README.md");
if (!docsReadme.includes("documentation-architecture-map.md")) {
  failures.push("docs/README.md must link documentation-architecture-map.md");
}

function walkMarkdown(relStart) {
  const start = path.join(repoRoot, relStart);
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoreParts.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(start);
  return out;
}

const maintained = [
  ...rootDocs,
  ...walkMarkdown("docs"),
  ...walkMarkdown("consent-protocol/docs"),
  ...walkMarkdown("hushh-webapp/docs"),
];

for (const rel of maintained) {
  if (rel.includes("DerivedData") || rel.includes(".pytest_cache")) {
    failures.push(`generated/vendor markdown leaked into maintained docs set: ${rel}`);
  }
}

if (failures.length > 0) {
  console.error("ERROR: docs governance check failed");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("OK: docs governance check passed");
