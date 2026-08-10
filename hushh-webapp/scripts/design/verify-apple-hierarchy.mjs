#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const failures = [];

function read(repoPath) {
  return fs.readFileSync(path.join(repoRoot, repoPath), "utf8");
}

function expectIncludes(repoPath, needle, message) {
  if (!read(repoPath).includes(needle)) {
    failures.push(`${repoPath}: ${message}`);
  }
}

function expectNotIncludes(repoPath, needle, message) {
  if (read(repoPath).includes(needle)) {
    failures.push(`${repoPath}: ${message}`);
  }
}

const typographySource = read("components/app-ui/typography.tsx");
for (const exportName of [
  "PageTitle",
  "PageSubtitle",
  "SectionLabel",
  "CardTitle",
  "RowLabel",
  "RowDescription",
  "TrailingValue",
  "TrailingAction",
  "FormLabel",
  "InputValue",
  "HelperText",
  "StatusText",
  "ButtonLabel",
  "TabLabel",
  "CaptionText",
  "LegalText",
]) {
  if (!typographySource.includes(`export function ${exportName}`)) {
    failures.push(
      `components/app-ui/typography.tsx: missing semantic role primitive ${exportName}`,
    );
  }
}

const globals = read("app/globals.css");
for (const [token, value] of [
  ["--type-section-label-size", "15px"],
  ["--type-section-label-line", "20px"],
  ["--type-section-label-weight", "500"],
  ["--type-section-label-tracking", "-0.01em"],
  ["--type-row-label-size", "17px"],
  ["--type-row-description-size", "15px"],
  ["--type-input-value-size", "17px"],
]) {
  if (!globals.includes(`${token}: ${value};`)) {
    failures.push(`app/globals.css: ${token} must stay ${value}`);
  }
}

for (const repoPath of [
  "components/app-ui/settings-ui.tsx",
  "components/app-ui/page-sections.tsx",
  "components/feed/feed-page.tsx",
  "components/one-location/redesign/check-in-flow.tsx",
  "components/one-location/activity-dashboard.tsx",
  "components/ria/onboarding/onboarding-step-services.tsx",
]) {
  expectIncludes(
    repoPath,
    "SectionLabel",
    "section headings must route through the shared SectionLabel role",
  );
  expectNotIncludes(
    repoPath,
    "font-[family-name:var(--font-app-body)] text-[15px] font-medium leading-[20px] tracking-[-0.01em] text-[#6E6E73]",
    "must not duplicate the section-label recipe locally",
  );
}

for (const repoPath of [
  "components/app-ui/settings-ui.tsx",
  "components/app-ui/page-sections.tsx",
  "components/app-ui/top-shell-tabs.tsx",
  "components/ui/input.tsx",
  "components/ui/label.tsx",
  "components/ui/tabs.tsx",
  "components/app-ui/stream-progress-panel.tsx",
  "lib/morphy-ux/ui/surface-primitives.tsx",
  "lib/morphy-ux/ui/segmented-tabs.tsx",
  "lib/morphy-ux/ui/segmented-pill.tsx",
  "components/dashboard/one-agent-roster.tsx",
]) {
  const source = read(repoPath);
  for (const tinyClass of [
    "text-[9px]",
    "text-[9.5px]",
    "text-[10px]",
  ]) {
    if (source.includes(tinyClass)) {
      failures.push(`${repoPath}: shared/system UI must not use ${tinyClass}`);
    }
  }
  if (source.includes("uppercase") && !repoPath.includes("top-shell-tabs")) {
    failures.push(`${repoPath}: shared/system UI must preserve natural casing`);
  }
}

expectIncludes(
  "components/dashboard/one-agent-roster.tsx",
  "agents ({modes.length})",
  "agents heading must preserve the requested natural lowercase casing",
);

if (failures.length > 0) {
  console.error(`verify-apple-hierarchy: ${failures.length} failure(s)\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("verify-apple-hierarchy: OK");
