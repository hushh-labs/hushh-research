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
  "LargeTitle",
  "PageTitle",
  "AgentTitle",
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
  "AgentTabLabel",
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
  ["--type-large-page-title-size", "28px"],
  ["--type-large-page-title-line", "34px"],
  ["--type-large-page-title-weight", "700"],
  ["--type-large-page-title-tracking", "-0.025em"],
  ["--type-page-title-size", "28px"],
  ["--type-page-title-line", "34px"],
  ["--type-page-title-weight", "700"],
  ["--type-page-title-tracking", "-0.025em"],
  ["--type-major-section-title-size", "20px"],
  ["--type-major-section-title-line", "25px"],
  ["--type-major-section-title-weight", "600"],
  ["--type-major-section-title-tracking", "-0.016em"],
  ["--type-page-subtitle-size", "15px"],
  ["--type-page-subtitle-line", "20px"],
  ["--type-section-label-size", "15px"],
  ["--type-section-label-line", "20px"],
  ["--type-section-label-weight", "500"],
  ["--type-section-label-tracking", "-0.01em"],
  ["--type-row-label-size", "17px"],
  ["--type-row-label-line", "22px"],
  ["--type-row-label-tracking", "-0.01em"],
  ["--type-row-description-size", "13px"],
  ["--type-row-description-line", "18px"],
  ["--type-row-description-tracking", "0"],
  ["--type-input-value-size", "17px"],
  ["--type-input-value-line", "22px"],
  ["--type-helper-text-size", "13px"],
  ["--type-helper-text-line", "18px"],
  ["--type-helper-text-tracking", "0"],
  ["--type-legal-text-size", "11px"],
  ["--type-legal-text-line", "15px"],
  ["--type-tab-label-size", "11px"],
  ["--type-tab-label-line", "13px"],
  ["--type-tab-label-weight", "500"],
  ["--type-agent-tab-label-size", "15px"],
  ["--type-agent-tab-label-line", "20px"],
  ["--type-agent-tab-label-weight", "500"],
]) {
  if (!globals.includes(`${token}: ${value};`)) {
    failures.push(`app/globals.css: ${token} must stay ${value}`);
  }
}

if (!/\.type-caption\s*\{[^}]*text-transform:\s*none;/s.test(globals)) {
  failures.push("app/globals.css: legacy type-caption must preserve natural casing");
}

if (!globals.includes(".app-page-shell")) {
  failures.push("app/globals.css: app shell must keep scoped readable-text guardrails");
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
  "components/app-ui/section-toc.tsx",
  "lib/morphy-ux/ui/surface-primitives.tsx",
  "lib/morphy-ux/ui/segmented-tabs.tsx",
  "lib/morphy-ux/ui/segmented-pill.tsx",
  "components/dashboard/one-agent-roster.tsx",
  "components/connect/nearby-directory-ui.tsx",
  "components/one-location/activity-dashboard.tsx",
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
  "Agents ({modes.length})",
  "agents heading is the page title and must use title casing",
);

expectNotIncludes(
  "components/dashboard/one-agent-roster.tsx",
  "text-[28px] leading-[34px]",
  "agents heading must use the shared PageTitle role instead of a route-level arbitrary override",
);

expectNotIncludes(
  "components/dashboard/one-agent-roster.tsx",
  'placeholder="search agents"',
  "search placeholder must preserve sentence casing",
);

for (const repoPath of [
  "components/kai/shared/kai-typography.ts",
  "components/dashboard/one-agent-roster.tsx",
]) {
  const source = read(repoPath);
  for (const forbidden of [
    "sm:text-",
    "md:text-",
    "lg:text-",
    "xl:text-",
    "clamp(",
    "font-size:",
    "fontSize:",
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${repoPath}: strict app typography must not use ${forbidden}`);
    }
  }
}

for (const [key, uiRole] of [
  ["largeTitle", "large-title"],
  ["pageTitle", "page-title"],
  ["agentTitle", "agent-title"],
  ["pageSubtitle", "subtitle"],
  ["sectionLabel", "section-label"],
  ["cardTitle", "card-title"],
  ["rowLabel", "body"],
  ["rowDescription", "row-description"],
  ["trailingValue", "trailing-value"],
  ["trailingAction", "trailing-action"],
  ["inputValue", "input-text"],
  ["helperText", "helper-text"],
  ["buttonLabel", "button-label"],
  ["tabLabel", "tab-label"],
  ["agentTabLabel", "agent-tab-label"],
  ["legal", "legal-text"],
]) {
  if (!typographySource.includes(`[TYPOGRAPHY_CLASSNAMES.${key}]: "${uiRole}"`)) {
    failures.push(
      `components/app-ui/typography.tsx: ${key} must emit data-ui-role="${uiRole}"`,
    );
  }
}

if (failures.length > 0) {
  console.error(`verify-apple-hierarchy: ${failures.length} failure(s)\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("verify-apple-hierarchy: OK");
