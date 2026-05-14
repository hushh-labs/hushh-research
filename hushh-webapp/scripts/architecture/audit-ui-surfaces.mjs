#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scanRoots = [
  path.join(repoRoot, "components/app-ui"),
  path.join(repoRoot, "lib/morphy-ux"),
];
const filePattern = /\.(ts|tsx)$/;

function listFiles(root) {
  const results = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".next-prod") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (filePattern.test(fullPath)) {
        results.push(fullPath);
      }
    }
  };
  visit(root);
  return results;
}

const allFiles = [
  ...listFiles(path.join(repoRoot, "components")),
  ...listFiles(path.join(repoRoot, "lib")),
  ...listFiles(path.join(repoRoot, "app")),
  ...listFiles(path.join(repoRoot, "__tests__")),
];

const report = [];

for (const root of scanRoots) {
  for (const candidate of listFiles(root)) {
    const repoPath = path.relative(repoRoot, candidate).replaceAll(path.sep, "/");
    const importPath = repoPath
      .replace(/^hushh-webapp\//, "")
      .replace(/\.(ts|tsx)$/, "")
      .replace(/\/index$/, "");
    const aliasPath = `@/${importPath}`;
    let referenceCount = 0;

    for (const file of allFiles) {
      if (file === candidate) continue;
      const source = fs.readFileSync(file, "utf8");
      if (source.includes(aliasPath)) {
        referenceCount += 1;
      }
    }

    if (referenceCount === 0) {
      report.push(repoPath);
    }
  }
}

console.log(JSON.stringify({ zeroReferenceCandidates: report.sort() }, null, 2));
