import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

type SurfaceContract = {
  file: string;
  includes: string[];
  excludes: string[];
};

const SURFACE_CONTRACTS: SurfaceContract[] = [
  {
    file: "lib/morphy-ux/card.tsx",
    includes: [
      "CARD_PRESET_SHELL_CLASSES",
      "var(--app-card-surface-default)",
      "var(--app-card-shadow-standard)",
      "var(--app-card-shadow-feature)",
      "overflow-visible",
      "MaterialRipple",
      "ring-1 ring-sky-500/25 dark:ring-sky-400/30",
    ],
    excludes: [
      "showRipple ? \"overflow-hidden\" : \"\"",
      "!border-[color:var(--app-card-border-standard)]",
      "!border-[color:var(--app-card-border-strong)]",
    ],
  },
  {
    file: "components/app-ui/surfaces.tsx",
    includes: [
      'preset={tone === "feature" ? "surface-feature" : "surface"}',
      'data-surface-tone={tone}',
      'data-surface-accent={accent}',
    ],
    excludes: [
      "SURFACE_TONE_CLASSES",
      "SURFACE_ACCENT_CLASSES",
      'glassAccent={accent === "none" ? "none" : "balanced"}',
    ],
  },
  {
    file: "components/app-ui/page-sections.tsx",
    includes: [
      "ACCENT_STYLES",
      "HeaderLeading",
      "text-sky-700",
      "text-emerald-700",
      "text-amber-700",
      "text-rose-700",
      "text-violet-700",
      "self-center",
    ],
    excludes: ["NEUTRAL_SECTION_STYLE", "bg-gradient-to-r"],
  },
  {
    file: "components/developers/developer-docs-hub.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceCard"],
    excludes: [
      "rounded-[22px] border border-foreground/10 bg-background/72 shadow-sm",
      "lg:overflow-hidden",
    ],
  },
  {
    file: "components/kai/views/kai-market-preview-view.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack", "SurfaceCard"],
    excludes: ['<Card variant="muted"', 'rounded-[24px] p-0'],
  },
  {
    file: "components/kai/views/investments-master-view.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack", "SurfaceCard"],
    excludes: ['rounded-[24px] border border-border/70 bg-background/82', '<Card variant='],
  },
  {
    file: "app/kai/analysis/page.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack", "SurfaceCard"],
    excludes: ['rounded-2xl border border-border/60 bg-background/70'],
  },
  {
    file: "app/kai/optimize/page.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "PageHeader", "SurfaceStack", "SurfaceCard"],
    excludes: ["<Card", "showRipple={false}"],
  },
  {
    file: "app/kai/portfolio/page.tsx",
    includes: ["AppPageShell", "AppPageContentRegion"],
    excludes: ['<div className="w-full">'],
  },
  {
    file: "app/kai/import/page.tsx",
    includes: ["FullscreenFlowShell", "KaiFlow"],
    excludes: ['<div className="w-full">'],
  },
  {
    file: "components/kai/views/portfolio-import-view.tsx",
    includes: ["SurfaceCard", "SurfaceCardContent"],
    excludes: ['<Card variant="none" effect="glass" showRipple={false}'],
  },
  {
    file: "components/consent/consent-center-view.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack", "SurfaceInset"],
    excludes: ['rounded-[24px] border border-border/60 bg-background/65'],
  },
  {
    file: "components/ria/ria-page-shell.tsx",
    includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack", "SurfaceCard"],
    excludes: ["ContentSurface", 'rounded-[28px] border border-border/70'],
  },
  {
    file: "components/profile/settings-ui.tsx",
    includes: ["SurfaceCard"],
    excludes: ['rounded-[22px] border border-foreground/10 bg-background/72 shadow-sm'],
  },
];

describe("surface system contract", () => {
  it("keeps standard route surfaces on shared wrappers", () => {
    const root = projectRoot();

    for (const contract of SURFACE_CONTRACTS) {
      const source = fs.readFileSync(path.join(root, contract.file), "utf8");

      for (const include of contract.includes) {
        expect(source, `${contract.file} should include ${include}`).toContain(include);
      }

      for (const exclude of contract.excludes) {
        expect(source, `${contract.file} should not include ${exclude}`).not.toContain(exclude);
      }
    }
  });
});
