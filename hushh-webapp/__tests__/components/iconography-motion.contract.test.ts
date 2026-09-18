import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APPLICATION_ROOTS = ["app", "components", "lib", "scripts"];
const SOURCE_EXTENSIONS = new Set([".css", ".mjs", ".ts", ".tsx"]);

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  });
}

function isCanonicalIconImplementation(path: string): boolean {
  return path.includes("/components/icons/");
}

describe("application icon and motion contracts", () => {
  it("routes application-owned icon imports through the canonical registry", () => {
    const legacyImports = APPLICATION_ROOTS.flatMap((root) =>
      collectSourceFiles(join(process.cwd(), root)).flatMap((path) => {
        if (isCanonicalIconImplementation(path)) return [];
        const source = readFileSync(path, "utf8");
        return /from ["'](?:lucide-react|@phosphor-icons\/react)["']/.test(source)
          ? [path]
          : [];
      }),
    );

    expect(legacyImports).toEqual([]);
  });

  it("keeps the compatibility facade on official native Phosphor geometry", () => {
    const source = readFileSync(
      join(process.cwd(), "components/icons/legacy-ui-icons.tsx"),
      "utf8",
    );

    expect(source).toContain('import * as Phosphor from "@phosphor-icons/react"');
    expect(source).toContain('defaultWeight: IconWeight = "duotone"');
    expect(source).toContain('Phosphor.CircleNotch, "regular"');
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
