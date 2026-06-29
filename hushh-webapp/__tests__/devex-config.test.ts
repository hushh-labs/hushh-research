import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import tsconfig from "../tsconfig.json";

function tsconfigIncludeMatches(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedPath = filePath.replace(/\\/g, "/");
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexSource = escaped
    .replace(/\/\*\*\//g, "(?:/.*)?/")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");

  return new RegExp(`^${regexSource}$`).test(normalizedPath);
}

describe("DevEx configuration integrity", () => {
  it("keeps the package typecheck script aligned with the TypeScript project config", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");

    expect(tsconfig.compilerOptions.noEmit).toBe(true);
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.include).toEqual(
      expect.arrayContaining(["app/**/*.ts", "lib/**/*.ts"]),
    );
  });

  it("keeps root backup files outside active TypeScript include scans", () => {
    const backupFiles = [
      "workspace.bak",
      "workspace.swp",
      ".DS_Store",
      "app/page.ts.bak",
      "lib/cache/cache-service.ts.swp",
    ];

    expect(tsconfig.include).toEqual(expect.any(Array));
    expect(tsconfig.include).not.toEqual(
      expect.arrayContaining(["*.bak", "*.swp", ".DS_Store"]),
    );

    for (const backupFile of backupFiles) {
      const matchingIncludes = tsconfig.include.filter((pattern) =>
        tsconfigIncludeMatches(pattern, backupFile),
      );

      expect(matchingIncludes, `${backupFile} must not match tsconfig.include`).toEqual([]);
    }
  });
});
