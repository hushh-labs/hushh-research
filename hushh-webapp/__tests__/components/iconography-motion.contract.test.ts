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
  return path.replaceAll("\\", "/").includes("/components/icons/");
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
        ? [relative(webappRoot, path).replaceAll("\\", "/")]
        : [];
    });
  });
}

describe("application icon import boundary", () => {
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

});
