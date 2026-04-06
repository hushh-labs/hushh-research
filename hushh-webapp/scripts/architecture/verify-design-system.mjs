#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const STOCK_UI_FILES = new Set([
  "accordion.tsx",
  "alert-dialog.tsx",
  "alert.tsx",
  "avatar.tsx",
  "badge.tsx",
  "breadcrumb.tsx",
  "button-group.tsx",
  "button.tsx",
  "card.tsx",
  "carousel.tsx",
  "chart.tsx",
  "checkbox.tsx",
  "collapsible.tsx",
  "combobox.tsx",
  "command.tsx",
  "dialog.tsx",
  "drawer.tsx",
  "dropdown-menu.tsx",
  "empty.tsx",
  "field.tsx",
  "input-group.tsx",
  "input.tsx",
  "kbd.tsx",
  "label.tsx",
  "pagination.tsx",
  "popover.tsx",
  "progress.tsx",
  "radio-group.tsx",
  "scroll-area.tsx",
  "select.tsx",
  "separator.tsx",
  "sheet.tsx",
  "sidebar.tsx",
  "skeleton.tsx",
  "sonner.tsx",
  "spinner.tsx",
  "switch.tsx",
  "table.tsx",
  "tabs.tsx",
  "textarea.tsx",
  "tooltip.tsx",
]);

const restrictedUiImports = [
  "@/components/app-ui/",
  "@/components/consent/",
  "@/components/kai/",
  "@/components/labs/",
  "@/components/profile/",
  "@/components/ria/",
  "@/lib/services/",
  "@/lib/notifications/",
  "@/lib/persona/",
  "@/lib/vault/",
];

const restrictedMorphyImports = [
  "@/components/app-ui/",
  "@/components/consent/",
  "@/components/kai/",
  "@/components/labs/",
  "@/components/profile/",
  "@/components/ria/",
];

const deprecatedImports = [
  "@/lib/morphy-ux/ui/tabs",
];

function listFiles(dir, matcher = () => true) {
  const result = [];
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
      if (matcher(fullPath)) {
        result.push(fullPath);
      }
    }
  };
  visit(dir);
  return result.sort();
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

const failures = [];

const uiDir = path.join(repoRoot, "components/ui");
const actualUiFiles = fs
  .readdirSync(uiDir)
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .sort();

for (const file of actualUiFiles) {
  if (!STOCK_UI_FILES.has(file)) {
    failures.push(`components/ui contains a non-contract file: ${file}`);
  }
}

const uiSources = listFiles(uiDir, (filePath) => /\.(ts|tsx)$/.test(filePath));
for (const filePath of uiSources) {
  const source = read(filePath);
  for (const restrictedImport of restrictedUiImports) {
    if (source.includes(restrictedImport)) {
      failures.push(
        `${toRepoPath(filePath)} imports forbidden app-specific code from ${restrictedImport}`
      );
    }
  }
}

const morphyDir = path.join(repoRoot, "lib/morphy-ux");
const morphySources = listFiles(morphyDir, (filePath) => /\.(ts|tsx)$/.test(filePath));
for (const filePath of morphySources) {
  const source = read(filePath);
  for (const restrictedImport of restrictedMorphyImports) {
    if (source.includes(restrictedImport)) {
      failures.push(
        `${toRepoPath(filePath)} imports feature/app-ui code from ${restrictedImport}`
      );
    }
  }
}

const appSources = listFiles(repoRoot, (filePath) => /\.(ts|tsx|md)$/.test(filePath));
for (const filePath of appSources) {
  const source = read(filePath);
  for (const deprecatedImport of deprecatedImports) {
    if (source.includes(deprecatedImport)) {
      failures.push(`${toRepoPath(filePath)} references deprecated path ${deprecatedImport}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Design-system verification failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Design-system verification passed.");
