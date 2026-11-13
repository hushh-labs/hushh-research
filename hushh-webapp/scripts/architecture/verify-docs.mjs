#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
);
const scripts = new Set(Object.keys(packageJson.scripts || {}));

const docsToScan = [
  "../docs/development/contracts/ui-contract-contributor-guide.md",
  "README.md",
  "components/README.md",
  "components/app-ui/README.md",
  "../docs/development/quality/README.md",
  "../docs/development/quality/design-system.md",
  "../docs/development/quality/frontend-pattern-catalog.md",
  "../docs/development/quality/frontend-ui-architecture-map.md",
  "../docs/development/quality/app-surface-design-system.md",
];

const forbiddenMentions = [
  "@/lib/morphy-ux/ui/tabs",
];

const failures = [];

for (const relativePath of docsToScan) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const matches = source.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g);
  for (const match of matches) {
    const command = match[1];
    if (!scripts.has(command)) {
      failures.push(`${relativePath} references missing npm script: ${command}`);
    }
  }
  for (const forbiddenMention of forbiddenMentions) {
    if (source.includes(forbiddenMention)) {
      failures.push(`${relativePath} references deprecated path: ${forbiddenMention}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation verification failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Documentation verification passed.");
