import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const AUDIT_TARGETS = [
  "app",
  "components/developers",
  "components/consent",
  "components/profile",
  "components/ria",
  "components/kai/cards",
  "components/kai/home",
  "components/kai/views",
  "components/kai/onboarding",
] as const;

const ALLOWED_FILE_EXCEPTIONS = new Set([
  "components/profile/settings-ui.tsx",
  "components/kai/onboarding/KaiPersonaScreen.tsx",
  "app/ria/onboarding/page.tsx",
  "components/consent/consent-center-page.tsx",
  "components/profile/pkm-upgrade-status-card.tsx",
  "components/kai/views/analysis-history-dashboard.tsx",
  "components/ria/ria-page-shell.tsx",
]);

const FORBIDDEN_PATTERNS = [
  /rounded-\[(22|24|26|28|32)px\].*border.*bg/,
  /shadow-\[[^\]]+\].*(bg|border)/,
  /<Card[^\n>]*className=.*rounded/,
];

function walkTsxFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsxFiles(nextPath));
      continue;
    }
    if (entry.isFile() && nextPath.endsWith(".tsx")) {
      files.push(nextPath);
    }
  }
  return files;
}

describe("card system audit", () => {
  it("keeps app-facing route shells on shared card presets", () => {
    const root = projectRoot();
    const files = AUDIT_TARGETS.flatMap((target) => walkTsxFiles(path.join(root, target)));

    for (const absoluteFile of files) {
      const relativeFile = path.relative(root, absoluteFile);
      if (ALLOWED_FILE_EXCEPTIONS.has(relativeFile)) {
        continue;
      }

      const source = fs.readFileSync(absoluteFile, "utf8");
      const lines = source.split("\n");

      for (const pattern of FORBIDDEN_PATTERNS) {
        const offendingLine = lines.find((line) => pattern.test(line));
        expect(
          offendingLine,
          `${relativeFile} should not define outer-card chrome manually`
        ).toBeUndefined();
      }
    }
  });
});
