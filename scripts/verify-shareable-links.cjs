#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = path.join(repoRoot, "tmp");
const ignoredDirs = new Set(["node_modules", ".git", ".next"]);
const repoishPrefixes = [
  "./",
  "../",
  "docs/",
  "consent-protocol/",
  "hushh-webapp/",
  "packages/",
  ".codex/",
  "/Users/",
];

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function walkShareableFiles() {
  if (!fs.existsSync(tmpRoot)) return [];
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
      if (entry.name.endsWith(".md") || entry.name.endsWith(".html")) {
        out.push(normalize(path.relative(repoRoot, full)));
      }
    }
  };

  visit(tmpRoot);
  return out;
}

function tokenLooksRepoLocal(token) {
  if (!token) return false;
  const cleaned = token.trim();
  if (!cleaned) return false;
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.startsWith("mailto:")) return false;
  if (cleaned.startsWith("#")) return false;
  return repoishPrefixes.some((prefix) => cleaned.startsWith(prefix));
}

function main() {
  const files = walkShareableFiles();
  const failures = [];

  for (const relFile of files) {
    const src = fs.readFileSync(path.join(repoRoot, relFile), "utf8");

    if (src.includes("file://")) {
      failures.push(`${relFile}: contains file:// link`);
    }
    if (src.includes("/Users/")) {
      failures.push(`${relFile}: contains local absolute path`);
    }

    for (const match of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const token = (match[1] || "").trim();
      if (tokenLooksRepoLocal(token)) {
        failures.push(`${relFile}: non-shareable markdown link -> ${token}`);
      }
    }

    for (const match of src.matchAll(/\bhref=["']([^"']+)["']/g)) {
      const token = (match[1] || "").trim();
      if (tokenLooksRepoLocal(token)) {
        failures.push(`${relFile}: non-shareable href -> ${token}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("ERROR: shareable links check failed");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("OK: shareable links check passed");
}

main();
