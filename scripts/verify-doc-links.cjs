#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const docTargets = [
  "README.md",
  "getting_started.md",
  "TESTING.md",
  "contributing.md",
  "docs",
  "consent-protocol/docs",
  "hushh-webapp/docs",
];
const ignoredDirs = new Set([
  "node_modules",
  ".next",
  "DerivedData",
  ".pytest_cache",
  ".git",
  ".venv",
  "dist",
  "build",
]);
const pathPrefixes = ["bin/", "docs/", "consent-protocol/", "hushh-webapp/", "scripts/", "deploy/", "data/"];
const fileLikeExt = /\.(md|ts|tsx|js|cjs|py|sh|yml|yaml|json|txt)$/i;

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function walkMarkdown(relTarget) {
  const fullTarget = path.join(repoRoot, relTarget);
  if (!fs.existsSync(fullTarget)) return [];
  const stat = fs.statSync(fullTarget);

  if (stat.isFile()) {
    return relTarget.endsWith(".md") ? [normalize(relTarget)] : [];
  }

  const out = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(normalize(path.relative(repoRoot, full)));
      }
    }
  };

  walk(fullTarget);
  return out;
}

function shouldValidateLinkToken(token) {
  if (!token) return false;
  if (token.startsWith("http://") || token.startsWith("https://") || token.startsWith("mailto:")) return false;
  if (token.startsWith("#")) return false;

  const cleaned = token.split("#")[0].trim();
  if (!cleaned) return false;

  if (cleaned.startsWith("./") || cleaned.startsWith("../")) return true;
  if (fileLikeExt.test(cleaned)) return true;
  if (pathPrefixes.some((prefix) => cleaned.startsWith(prefix))) return true;
  return false;
}

function resolveCandidate(baseFile, token) {
  const cleaned = token.split("#")[0].trim();
  const baseDir = path.dirname(path.join(repoRoot, baseFile));

  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    return path.resolve(baseDir, cleaned);
  }

  return path.join(repoRoot, cleaned);
}

function shouldValidateCodePath(token) {
  if (!token || token.includes(" ")) return false;
  if (token.startsWith("http://") || token.startsWith("https://") || token.startsWith("mailto:")) return false;
  if (token.startsWith("/")) return false; // route-like, not repo path
  if (token.startsWith("~/")) return false;
  if (token.includes("...")) return false;
  if (token.includes("*")) return false;
  if (token.includes("{") || token.includes("}") || token.includes("<") || token.includes(">")) return false;
  if (!token.includes("/")) return false;

  const cleaned = token.replace(/[),.;:]+$/g, "");
  if (/^\.env(\.[A-Za-z0-9_-]+)?$/.test(path.basename(cleaned))) return false;
  if (cleaned.includes(".env.local.d/")) return false;

  if (cleaned.startsWith("./") || cleaned.startsWith("../")) return true;
  return pathPrefixes.some((prefix) => cleaned.startsWith(prefix));
}

function resolveCodePath(baseFile, token) {
  const cleaned = token.replace(/[),.;:]+$/g, "");
  const baseDir = path.dirname(path.join(repoRoot, baseFile));

  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    return [path.resolve(baseDir, cleaned)];
  }

  if (pathPrefixes.some((prefix) => cleaned.startsWith(prefix))) {
    return [path.join(repoRoot, cleaned)];
  }

  return [path.join(repoRoot, cleaned)];
}

function main() {
  const mdFiles = [...new Set(docTargets.flatMap((target) => walkMarkdown(target)))].sort();
  const errors = [];

  for (const relFile of mdFiles) {
    const src = fs.readFileSync(path.join(repoRoot, relFile), "utf8");

    const linkMatches = src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
    for (const m of linkMatches) {
      const token = (m[1] || "").trim();
      if (!shouldValidateLinkToken(token)) continue;
      const resolved = resolveCandidate(relFile, token);
      if (!fs.existsSync(resolved)) {
        errors.push(`${relFile}: broken markdown link -> ${token}`);
      }
    }

    const codeMatches = src.matchAll(/`([^`\n]+)`/g);
    for (const m of codeMatches) {
      const token = (m[1] || "").trim();
      if (!shouldValidateCodePath(token)) continue;
      const candidates = resolveCodePath(relFile, token);
      if (!candidates.some((candidate) => fs.existsSync(candidate))) {
        errors.push(`${relFile}: unresolved code path -> ${token}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("ERROR: docs integrity check failed");
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log("OK: docs integrity check passed");
}

main();
