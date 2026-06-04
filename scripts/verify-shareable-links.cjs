#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CONFIG_RESOURCES, resolveWorkspaceAsset, workspaceRoot } = require("./workspace-setup");

const repoRoot = workspaceRoot;
const tmpRoot = CONFIG_RESOURCES.tmpDirectory;
const ignoredDirs = new Set(["node_modules", ".git", ".next"]);
const repoLocalLinkRoots = ["docs", "consent-protocol", "hushh-webapp", "packages", ".codex"];
const repoishPrefixes = [
  "./",
  "../",
  ...repoLocalLinkRoots.map((root) => `${normalize(root)}/`),
];
const homeDir = normalize(os.homedir());
const escapedHomeDir = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const localAbsolutePathPatterns = [
  /\b[A-Za-z]:[\\/][^\s)'"<>]+/,
  /(^|[\s('"`])\/(?:home|Users|var|tmp|private|Volumes)\/[^\s)'"<>]+/,
  ...(escapedHomeDir ? [new RegExp(`${escapedHomeDir}[^\\s)'"<>]*`)] : []),
];

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function hasFileUri(value) {
  return /\bfile:\/\//i.test(value);
}

function looksAbsoluteLocalPath(value) {
  const cleaned = normalize(value.trim());
  if (!cleaned) return false;
  if (homeDir && cleaned.startsWith(homeDir)) return true;
  return path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(value);
}

function containsAbsoluteLocalPath(value) {
  return localAbsolutePathPatterns.some((pattern) => pattern.test(value));
}

function walkShareableFiles() {
  if (!fs.existsSync(tmpRoot)) return [];
  const out = [];

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) continue;
      const full = resolveWorkspaceAsset(path.relative(repoRoot, path.join(dir, entry.name)));
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
  if (hasFileUri(cleaned) || looksAbsoluteLocalPath(cleaned)) return true;
  return repoishPrefixes.some((prefix) => cleaned.startsWith(prefix));
}

function main() {
  const files = walkShareableFiles();
  const failures = [];

  for (const relFile of files) {
    const src = fs.readFileSync(path.join(repoRoot, relFile), "utf8");

    if (hasFileUri(src)) {
      failures.push(`${relFile}: contains file:// link`);
    }
    if (containsAbsoluteLocalPath(src)) {
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
