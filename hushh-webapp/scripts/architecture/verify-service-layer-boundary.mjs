#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const scanRoots = ["app", "components"];
const allowedPathParts = new Set(["api"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const forbiddenPatterns = [
  {
    id: "raw-fetch",
    pattern: /\bfetch\s*\(/,
    message: "UI surfaces must call service modules, resource hooks, or route proxies instead of raw fetch().",
  },
];

function walk(dir) {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walk(fullPath));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      entries.push(fullPath);
    }
  }
  return entries;
}

function isAllowed(filePath) {
  const rel = path.relative(repoRoot, filePath).split(path.sep);
  if (rel[0] === "app" && allowedPathParts.has(rel[1])) return true;
  if (rel.at(-1)?.startsWith("route.")) return true;
  return false;
}

const findings = [];

for (const root of scanRoots) {
  const absRoot = path.join(repoRoot, root);
  if (!fs.existsSync(absRoot)) continue;
  for (const filePath of walk(absRoot)) {
    if (isAllowed(filePath)) continue;
    const rel = path.relative(repoRoot, filePath);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(line)) {
          findings.push({
            rule: rule.id,
            path: rel,
            line: index + 1,
            message: rule.message,
          });
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error("Service-layer boundary violations:");
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line} ${finding.rule} - ${finding.message}`);
  }
  process.exit(1);
}

console.log("Service-layer boundary verification passed");
