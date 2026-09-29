import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APPLICATION_ROOTS = ["app", "components", "hooks", "lib", "scripts", "src"];
const SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

// Every glyph library an application file could reach for. Only the registry
// under components/icons may import one; everything else goes through
// `@/components/icons`, so one concept has one glyph app-wide.
const ICON_LIBRARY_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:lucide-react|@phosphor-icons\/react|react-icons|@heroicons\/react|@radix-ui\/react-icons|@tabler\/icons-react|@mui\/icons-material)(?:\/[^"']*)?["']/;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules"
        ? []
        : collectSourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  });
}

function isCanonicalIconImplementation(path: string): boolean {
  return path.includes("/components/icons/");
}

function findDirectIconLibraryImports(webappRoot: string): string[] {
  return APPLICATION_ROOTS.flatMap((root) => {
    let files: string[];
    try {
      files = collectSourceFiles(join(webappRoot, root));
    } catch {
      return [];
    }
    return files.flatMap((path) => {
      if (isCanonicalIconImplementation(path)) return [];
      return ICON_LIBRARY_IMPORT.test(readFileSync(path, "utf8"))
        ? [relative(webappRoot, path)]
        : [];
    });
  });
}

// Profile, and every nested screen reachable from it, draws row icons the
// way the Profile menu does: an authored registry glyph in its own colour on
// a transparent well (`iconTone="capability"`), never a coloured or gray tile.
const PROFILE_ROW_SURFACES = [
  "components/profile",
  "components/wallet-card",
  "app/one/profile",
];

function findTiledSettingsRows(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/<SettingsRow\b/g)) {
    let index = match.index;
    let depth = 0;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
    }
    const tag = source.slice(match.index, index);
    const icon = tag.match(/\bicon=\{([^}]+)\}/)?.[1]?.trim();
    if (!icon) continue;
    if (!/\biconTone="capability"/.test(tag)) offenders.push(icon);
  }
  return offenders;
}

// Founder directive (2026-09-28): no sparkle glyph anywhere, the registry
// included, so one can never be reached for again. Each former use now draws
// its concept's /one glyph instead (a preview, a draft, the Email agent).
// Case-insensitive on purpose: the identifier, a string option such as
// `icon="sparkles"`, and a stray comment are all a way back in.
const SPARKLE_GLYPH = /\b(?:sparkles?|magic-?wand)/i;

function findSparkleReferences(webappRoot: string): string[] {
  return APPLICATION_ROOTS.flatMap((root) => {
    let files: string[];
    try {
      files = collectSourceFiles(join(webappRoot, root));
    } catch {
      return [];
    }
    return files.flatMap((path) =>
      SPARKLE_GLYPH.test(readFileSync(path, "utf8"))
        ? [relative(webappRoot, path)]
        : [],
    );
  });
}

// Consent cards draw their header the way /one draws its launcher: a bare
// duotone registry glyph on a transparent well. A painted box whose only
// child is one glyph (the blue tile with a white shield, the sage circle) is
// the tile shape /one does not use. Controls are exempt by construction: a
// checkbox renders a conditional, not a sole glyph, and buttons are components.
const CONSENT_CARD_SURFACES = [
  "components/agent/consent",
  "components/agent/agent-structured-experience.tsx",
  "components/agent/specialist-directive-card.tsx",
  "components/consent/consent-pending-row.tsx",
];

const PAINTED_BACKGROUND =
  /(?:^|[\s"'`{(])(?:dark:)?bg-(?!transparent\b|none\b)[^\s"'`}]+/;
const SOLE_GLYPH_CHILD =
  /^\s*(?:<([A-Z]\w*)\b[^<>]*\/>|\{\s*([\w.]*[Ii]con)\s*\})\s*<\/(?:span|div)>/;

function surfaceFiles(surface: string): string[] {
  const path = join(process.cwd(), surface);
  return path.endsWith(".tsx") ? [path] : collectSourceFiles(path);
}

function findFilledIconTiles(
  source: string,
  isRegistryGlyph: (name: string) => boolean,
): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/<(?:span|div)\b/g)) {
    let index = match.index;
    let depth = 0;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
    }
    const tag = source.slice(match.index, index);
    if (tag.trimEnd().endsWith("/") || !PAINTED_BACKGROUND.test(tag)) continue;
    const child = source.slice(index + 1).match(SOLE_GLYPH_CHILD);
    if (!child) continue;
    const glyph = child[1] ?? child[2];
    // `{icon}` is a glyph slot; a named child must be a registry glyph, so a
    // painted panel around one content component is not mistaken for a tile.
    if (child[2] || isRegistryGlyph(glyph)) offenders.push(glyph);
  }
  return offenders;
}

describe("application icon and motion contracts", () => {
  it("never draws or exports a sparkle glyph", async () => {
    expect(findSparkleReferences(process.cwd())).toEqual([]);

    const registry = await import("@/components/icons");
    expect(
      Object.keys(registry).filter((name) => SPARKLE_GLYPH.test(name)),
    ).toEqual([]);

    // Negative control: a registry export, an application import and a
    // string option must all be reported; a clean file must not.
    const root = mkdtempSync(join(tmpdir(), "sparkle-control-"));
    try {
      mkdirSync(join(root, "components/icons"), { recursive: true });
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "components/icons/registry.tsx"),
        "export const Sparkles = createCanonicalIcon(Phosphor.Sparkle);\n",
      );
      writeFileSync(
        join(root, "components/card.tsx"),
        'import { SparkleIcon } from "@/components/icons";\n',
      );
      writeFileSync(join(root, "lib/accordion.tsx"), 'const icon = "sparkles";\n');
      writeFileSync(
        join(root, "components/clean.tsx"),
        'import { PreviewRowIcon } from "@/components/icons";\n',
      );
      expect(findSparkleReferences(root).sort()).toEqual([
        "components/card.tsx",
        "components/icons/registry.tsx",
        "lib/accordion.tsx",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("draws consent card headers as bare glyphs, never a filled tile", async () => {
    const registry = await import("@/components/icons");
    const isRegistryGlyph = (name: string) => name in registry;

    const files = CONSENT_CARD_SURFACES.flatMap(surfaceFiles).filter((path) =>
      path.endsWith(".tsx"),
    );
    const offenders = files.flatMap((path) =>
      findFilledIconTiles(readFileSync(path, "utf8"), isRegistryGlyph).map(
        (glyph) => `${relative(process.cwd(), path)}: ${glyph}`,
      ),
    );
    expect(offenders).toEqual([]);

    // The scan is not vacuous: the headers it guards are on the transparent
    // well, and the consent headers carry /one's Consent glyph.
    const withHeaderWell = files.filter((path) =>
      readFileSync(path, "utf8").includes('data-slot="card-header-icon"'),
    );
    expect(withHeaderWell.map((path) => relative(process.cwd(), path)).sort()).toEqual([
      "components/agent/agent-structured-experience.tsx",
      "components/agent/consent/ask-proposal-card.tsx",
      "components/agent/specialist-directive-card.tsx",
    ]);
    for (const path of withHeaderWell) {
      expect(readFileSync(path, "utf8")).toContain("<ConsentAgentIcon");
    }

    // Negative control: each tile shape that shipped must be reported, and
    // the migrated well and a checkbox control must not.
    expect(
      findFilledIconTiles(
        // The requester card's shell before this fix.
        '<span className="inline-flex h-10 w-10 rounded-[14px] bg-accent-strong text-white shadow-sm">\n  {icon}\n</span>\n' +
          // The ask card's header before this fix.
          '<span className="inline-flex h-9 w-9 rounded-[10px] bg-accent-strong text-white">\n  <ShieldCheck className="h-4 w-4" aria-hidden="true" />\n</span>\n' +
          // The specialist card's tinted circle before this fix.
          '<div className="grid h-9 w-9 place-items-center rounded-full bg-[#6b8f71]/10 text-[#426548]">\n  <ShieldCheck className="h-4 w-4" />\n</div>\n' +
          // Allowed: the migrated well, a checkbox and a painted content panel.
          '<span data-slot="card-header-icon" className="inline-flex h-9 w-9 items-center justify-center">\n  <ConsentAgentIcon className="h-7 w-7" />\n</span>\n' +
          '<span className={`h-5 w-5 ${on ? "bg-accent-strong text-white" : "border"}`}>\n  {on ? <Check className="h-3 w-3" /> : null}\n</span>\n' +
          '<div className="rounded-xl bg-muted/40">\n  <OutlineRows names={names} />\n</div>\n',
        isRegistryGlyph,
      ),
    ).toEqual(["icon", "ShieldCheck", "ShieldCheck"]);
  });

  it("routes application-owned icon imports through the canonical registry", () => {
    expect(findDirectIconLibraryImports(process.cwd())).toEqual([]);
  });

  it("reports a direct icon-library import reintroduced outside the registry", () => {
    // Negative control: the scanner above would pass vacuously if it walked
    // nothing or matched nothing. Build a miniature app tree with one
    // offender, one registry file and one clean file, and require exactly the
    // offender back.
    const root = mkdtempSync(join(tmpdir(), "icon-import-control-"));
    try {
      mkdirSync(join(root, "components/icons"), { recursive: true });
      mkdirSync(join(root, "app/one"), { recursive: true });
      writeFileSync(
        join(root, "components/icons/registry.tsx"),
        'import { Bank } from "@phosphor-icons/react";\n',
      );
      writeFileSync(
        join(root, "app/one/page.tsx"),
        'import { Settings } from "lucide-react";\n',
      );
      writeFileSync(
        join(root, "components/clean.tsx"),
        'import { GearIcon } from "@/components/icons";\n',
      );
      expect(findDirectIconLibraryImports(root)).toEqual(["app/one/page.tsx"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("draws every Profile nested-route row icon with the Profile menu treatment", () => {
    const offenders = PROFILE_ROW_SURFACES.flatMap((surface) =>
      collectSourceFiles(join(process.cwd(), surface))
        .filter((path) => path.endsWith(".tsx"))
        .flatMap((path) =>
          findTiledSettingsRows(readFileSync(path, "utf8")).map(
            (icon) => `${relative(process.cwd(), path)}: ${icon}`,
          ),
        ),
    );
    expect(offenders).toEqual([]);

    // Negative control: a tiled row, and a row with no tone at all (which
    // falls back to the gray tile), must both be reported.
    expect(
      findTiledSettingsRows(
        '<SettingsRow icon={KeyRound} iconTone="blue" title="Vault" />\n' +
          '<SettingsRow icon={Laptop} title="Device" />\n' +
          '<SettingsRow icon={VaultRowIcon} iconTone="capability" title="Ok" />',
      ),
    ).toEqual(["KeyRound", "Laptop"]);

    // The Account screen's iOS tile rules once painted a tile behind the
    // capability Wallet row and shrank its glyph to 17px. They must exclude
    // capability rows, and nested screens must share the menu's glyph size.
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toContain(
      '.profile-account-content [data-slot="settings-row-icon"]:not([data-icon-tone="capability"]):not([data-icon-tone="transparent"]) {',
    );
    expect(css).not.toMatch(
      /\.profile-account-content \[data-slot="settings-row-icon"\] \{/,
    );
    expect(css).toMatch(
      /\[data-profile-stack-content="true"\] \[data-icon-tone="capability"\] svg,[\s\S]*?height: 28px !important;\s+width: 28px !important;/,
    );
  });

  it("keeps the compatibility facade on official native Phosphor geometry", () => {
    const source = readFileSync(
      join(process.cwd(), "components/icons/legacy-ui-icons.tsx"),
      "utf8",
    );

    expect(source).toContain('import * as Phosphor from "@phosphor-icons/react"');
    expect(source).toContain('defaultWeight: IconWeight = "duotone"');
    expect(source).toContain('Phosphor.CircleNotch, "regular"');
    expect(source).toContain(
      'export const MoreHorizontal = createCanonicalIcon(Phosphor.DotsThree, "regular");',
    );
    expect(source).toContain("forwardRef<SVGSVGElement");
    expect(source).toContain('data-canonical-icon="true"');

    const uiIcons = readFileSync(
      join(process.cwd(), "components/icons/ui/ui-icons.tsx"),
      "utf8",
    );
    const detailIcons = readFileSync(
      join(process.cwd(), "components/icons/ui/detail-icons.tsx"),
      "utf8",
    );
    expect(uiIcons).toContain('weight = "regular"');
    expect(uiIcons).toContain(
      'export function DotsThreeIcon({\n  size = "1em",\n  weight = "regular",',
    );
    expect(detailIcons).toContain(
      'ArrowsClockwiseIcon({ weight = "regular"',
    );
    expect(detailIcons).toContain('SpinnerGapIcon({ weight = "regular"');
    expect(detailIcons).toContain('data-canonical-icon="true"');
    expect(uiIcons).toContain('data-canonical-icon="true"');

    const globals = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(globals).toContain('svg[data-canonical-icon="true"]');
    expect(globals).toContain("background-color: transparent !important;");
  });
});
