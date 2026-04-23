#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const ignoredDirs = new Set([
  "node_modules",
  ".next",
  "DerivedData",
  ".pytest_cache",
  ".git",
  ".venv",
  "dist",
  "build",
  "__pycache__",
]);

const targets = [
  "README.md",
  "getting_started.md",
  "TESTING.md",
  "contributing.md",
  "docs",
  "consent-protocol/docs",
  "hushh-webapp/docs",
  "packages/hushh-mcp/README.md",
  ".codex/skills",
  ".codex/workflows",
];

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function walk(relTarget) {
  const absTarget = path.join(repoRoot, relTarget);
  if (!fs.existsSync(absTarget)) return [];
  const stat = fs.statSync(absTarget);

  if (stat.isFile()) return [normalize(relTarget)];

  const out = [];

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (
        entry.name.endsWith(".md") ||
        entry.name === "SKILL.md" ||
        entry.name === "PLAYBOOK.md" ||
        entry.name.endsWith(".json")
      ) {
        out.push(normalize(path.relative(repoRoot, full)));
      }
    }
  };

  visit(absTarget);
  return out;
}

function stripMarkdownCode(source) {
  return source
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/^---[\s\S]*?---\s*/m, "");
}

function loadComparableText(relFile) {
  const raw = fs.readFileSync(path.join(repoRoot, relFile), "utf8");
  if (relFile.endsWith(".md")) return stripMarkdownCode(raw);
  return raw;
}

function main() {
  const files = [...new Set(targets.flatMap((target) => walk(target)))].sort();
  const failures = [];

  for (const relFile of files) {
    const comparable = loadComparableText(relFile);
    if (!/\bHushh\b/.test(comparable)) continue;

    const lines = comparable.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/\bHushh\b/.test(lines[i])) {
        failures.push(`${relFile}:${i + 1}: stray standalone Hushh branding`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("ERROR: docs brand check failed");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("OK: docs brand check passed");
}

main();
